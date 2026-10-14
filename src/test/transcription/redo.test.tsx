import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { File as NodeFile } from 'node:buffer'
import { MemoryRouter } from 'react-router-dom'

import { DocumentBody } from '@/components/reader/DocumentArticle'
import { defaultIndex } from '@/lib/defaults'
import { PROMPTS } from '@/lib/generation/prompts.data'
import { redoTranscript } from '@/lib/generation/reviewer'
import type { GenerationSession } from '@/lib/generation/session'
import { transcribe } from '@/lib/transcription'
import type { Repository } from '@/lib/storage/repository'
import { useJobsStore, type NewContentRequest } from '@/stores/jobs'
import { useLibraryStore } from '@/stores/library'
import { type CapturedRequest, installFetch, openAiStream, systemPromptOf } from '@/test/ai/fake-provider'
import type { FileSidecar, RecordingData } from '@/types/domain'

const { heard } = vi.hoisted(() => ({
  heard: {
    blocks: [
      { speaker: 'mic', start: 0, end: 3, text: 'Vamos falar do PIX.' },
      { speaker: 'speaker_0', start: 4, end: 8, text: 'O pics entra em maio, falei com o João Vito.' },
      { speaker: 'speaker_0', start: 9, end: 10, text: 'Fechado, eu mando.' },
    ],
    speakers: [
      { id: 'mic', name: 'Você', suggested: false },
      { id: 'speaker_0', name: 'Falante 2', suggested: false },
    ],
    marks: [],
  },
}))

vi.mock('@/lib/transcription', () => ({
  ENGINES: [],
  transcribe: vi.fn(async () => ({ text: 'bruto', engine: 'deepinfra', language: 'pt', durationSeconds: 10, speakers: 2, recording: heard })),
}))

vi.mock('@/components/reader/GithubMarkdownView', () => ({
  default: ({ markdown }: { markdown: string }) => <div data-testid="markdown">{markdown}</div>,
}))

const INSTRUCTION = 'É PIX, não pics. O nome é João Vitor. A fala "Fechado, eu mando." é minha.'
const asked: string[] = []

function memoryRepository() {
  const sidecars = new Map<string, FileSidecar>()
  const contents = new Map<string, string>()
  const repo = {
    kind: 'local',
    accountId: 'local',
    load: async () => ({ folders: [], files: [], index: defaultIndex() }),
    readContent: async (id: string) => contents.get(id) ?? '',
    readSidecar: async (id: string) => {
      const sidecar = sidecars.get(id)
      if (!sidecar) throw new Error(`missing ${id}`)
      return sidecar
    },
    saveFile: async (sidecar: FileSidecar, content?: string) => {
      sidecars.set(sidecar.meta.id, sidecar)
      if (content !== undefined) contents.set(sidecar.meta.id, content)
      return sidecar
    },
    saveIndex: async () => undefined,
    fileSizes: async () => ({}),
  } as unknown as Repository
  return { repo, sidecars, contents }
}

const REDO_ANSWER = {
  correcoes: [
    { fala: 2, de: 'pics', para: 'PIX' },
    { fala: 2, de: 'João Vito', para: 'João Vitor' },
  ],
  falantes: [{ fala: 3, quem: 'Você' }],
}

function provider(request: CapturedRequest): Response {
  const system = systemPromptOf(request)
  if (system === PROMPTS.SPEAKER_NAMES_PROMPT) return openAiStream(JSON.stringify({ nomes: [] }))
  if (system === PROMPTS.TRANSCRIPT_REVIEW_PROMPT) return openAiStream(JSON.stringify({ correcoes: [] }))
  if (system === PROMPTS.TITLE_PROMPT) return openAiStream(JSON.stringify({ titulo: 'PIX em maio' }))
  if (system === PROMPTS.TRANSCRIPT_REDO_PROMPT) {
    asked.push(JSON.stringify(request.body))
    return openAiStream(JSON.stringify(REDO_ANSWER))
  }
  return new Response(`unexpected ${system.slice(0, 40)}`, { status: 500 })
}

let memory: ReturnType<typeof memoryRepository>

beforeEach(() => {
  asked.length = 0
  memory = memoryRepository()
  const index = defaultIndex()
  index.settings.ai = { provider: 'custom', baseUrl: 'https://api.exemplo.dev/v1', apiKey: 'test-key', model: 'default' }
  useLibraryStore.setState({ repo: memory.repo, accountId: 'local', ready: true, folders: [], files: [], index, opened: {}, openedAt: {}, localMedia: [], sharedView: null })
  useJobsStore.setState({ jobs: [], live: {}, proposals: [] })
  installFetch(provider)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('redo the transcript with an instruction', () => {
  it('applies the words and the speaker the instruction asks for, keeping what was heard', async () => {
    const session = { chat: vi.fn(async () => JSON.stringify(REDO_ANSWER)) } as unknown as GenerationSession
    const redone = await redoTranscript(heard as RecordingData, INSTRUCTION, session)
    expect(vi.mocked(session.chat).mock.calls[0][0]).toContain(INSTRUCTION)
    expect(redone.blocks[1]).toMatchObject({ speaker: 'speaker_0', text: 'O PIX entra em maio, falei com o João Vitor.', original: 'O pics entra em maio, falei com o João Vito.' })
    expect(redone.blocks[2]).toMatchObject({ speaker: 'mic', text: 'Fechado, eu mando.' })
  })

  it('a name nobody has yet becomes a new speaker', async () => {
    const session = { chat: vi.fn(async () => JSON.stringify({ correcoes: [], falantes: [{ fala: 3, quem: 'Carla' }] })) } as unknown as GenerationSession
    const redone = await redoTranscript(heard as RecordingData, 'A última fala é da Carla.', session)
    const carla = redone.speakers.find(speaker => speaker.name === 'Carla')
    expect(carla).toBeTruthy()
    expect(redone.blocks[2].speaker).toBe(carla!.id)
  })

  it('"Refazer a transcrição" in the note takes what is wrong and saves the transcript fixed, without transcribing again', async () => {
    const file = new NodeFile([new Uint8Array(4)], 'Reunião 14-10-2026.webm', { type: 'audio/webm' }) as unknown as File
    const request: NewContentRequest = { agent: 'reading', input: { kind: 'recording', file }, name: '', description: '', folderId: null, prompt: '', storage: 'none', litterboxTime: '72h' as NewContentRequest['litterboxTime'] }
    const id = (await useJobsStore.getState().startNewContent(request))!
    await waitFor(() => expect(useLibraryStore.getState().files.find(item => item.id === id)?.status).toBe('ready'))
    const heardTimes = vi.mocked(transcribe).mock.calls.length
    render(
      <MemoryRouter>
        <DocumentBody fileId={id} />
      </MemoryRouter>,
    )
    fireEvent.click(await screen.findByRole('button', { name: 'Refazer a transcrição' }))
    const box = screen.getByRole('textbox', { name: 'O que está errado na transcrição' })
    expect(screen.getByRole('button', { name: 'Refazer' })).toBeDisabled()
    fireEvent.change(box, { target: { value: INSTRUCTION } })
    fireEvent.click(screen.getByRole('button', { name: 'Refazer' }))
    await waitFor(() => expect(memory.contents.get(id)).toContain('O PIX entra em maio, falei com o João Vitor.'))
    expect(memory.contents.get(id)).toContain('Você [00:09]: Fechado, eu mando.')
    expect(asked.join(' ')).toContain('João Vitor')
    await waitFor(() => expect(screen.getByText(/falei com o/)).toHaveTextContent('João Vitor'))
    expect(vi.mocked(transcribe).mock.calls.length).toBe(heardTimes)
  })
})
