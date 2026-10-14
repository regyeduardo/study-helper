import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { File as NodeFile } from 'node:buffer'
import { MemoryRouter } from 'react-router-dom'

import { DocumentBody } from '@/components/reader/DocumentArticle'
import { defaultIndex } from '@/lib/defaults'
import { PROMPTS } from '@/lib/generation/prompts.data'
import type { Repository } from '@/lib/storage/repository'
import { useJobsStore, type NewContentRequest } from '@/stores/jobs'
import { useLibraryStore } from '@/stores/library'
import { type CapturedRequest, installFetch, openAiStream, systemPromptOf } from '@/test/ai/fake-provider'
import type { FileSidecar } from '@/types/domain'

const { heard } = vi.hoisted(() => ({
  heard: {
    blocks: [
      { speaker: 'mic', start: 0, end: 3, text: 'Vamos lançar em maio?' },
      { speaker: 'speaker_0', start: 4, end: 8, text: 'Sim, eu mando a proposta para a Mariana.' },
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
  transcribe: vi.fn(async () => ({ text: 'bruto', engine: 'deepinfra', language: 'pt', durationSeconds: 8, speakers: 2, recording: heard })),
}))

vi.mock('@/components/reader/GithubMarkdownView', () => ({
  default: ({ markdown }: { markdown: string }) => <div data-testid="markdown">{markdown}</div>,
}))

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

let release: () => void = () => {}
let reviewed: Promise<void>

function provider(request: CapturedRequest): Response | Promise<Response> {
  const system = systemPromptOf(request)
  if (system === PROMPTS.POLISH_PROMPT) return reviewed.then(() => openAiStream(JSON.stringify({ titulo: 'Lançamento em maio', nomes: [], correcoes: [{ fala: 2, de: 'Mariana', para: 'Marina' }] })))
  if (system === PROMPTS.SPEAKER_NAMES_PROMPT) return openAiStream(JSON.stringify({ nomes: [] }))
  if (system === PROMPTS.TITLE_PROMPT) return openAiStream(JSON.stringify({ titulo: 'Lançamento em maio' }))
  if (system === PROMPTS.TRANSCRIPT_REVIEW_PROMPT) return reviewed.then(() => openAiStream(JSON.stringify({ correcoes: [{ fala: 2, de: 'Mariana', para: 'Marina' }] })))
  if (system === PROMPTS.MINUTES_EXTRACT_PROMPT) return openAiStream(JSON.stringify({ assunto: 'Lançamento', temas: [{ tema: 'Data', pontos: [{ texto: 'Lançar em maio', citacao: 'Vamos lançar em maio', hora: '00:00' }] }], passos: [] }))
  return new Response(`unexpected ${system.slice(0, 40)}`, { status: 500 })
}

function recordingRequest(agent: NewContentRequest['agent']): NewContentRequest {
  const file = new NodeFile([new Uint8Array(4)], 'Reunião 14-10-2026.webm', { type: 'audio/webm' }) as unknown as File
  return { agent, input: { kind: 'recording', file }, name: '', description: '', folderId: null, prompt: '', storage: 'none', litterboxTime: '72h' as NewContentRequest['litterboxTime'] }
}

let memory: ReturnType<typeof memoryRepository>

beforeEach(() => {
  memory = memoryRepository()
  reviewed = new Promise(resolve => (release = resolve))
  const index = defaultIndex()
  index.settings.ai = { provider: 'custom', baseUrl: 'https://api.exemplo.dev/v1', apiKey: 'test-key', model: 'default' }
  useLibraryStore.setState({ repo: memory.repo, accountId: 'local', ready: true, folders: [], files: [], index, opened: {}, openedAt: {}, localMedia: [], sharedView: null })
  useJobsStore.setState({ jobs: [], live: {}, proposals: [] })
  installFetch(provider)
})

afterEach(() => {
  release()
  vi.unstubAllGlobals()
})

describe('the note opens as soon as the transcription is out', () => {
  it('the note exists with the transcript while the review is still running, and is fixed in place when it ends', async () => {
    const id = await useJobsStore.getState().startNewContent(recordingRequest('reading'))
    expect(id).toBeTruthy()
    expect(memory.sidecars.get(id!)?.recording?.blocks[1].text).toBe('Sim, eu mando a proposta para a Mariana.')
    render(
      <MemoryRouter>
        <DocumentBody fileId={id!} />
      </MemoryRouter>,
    )
    await waitFor(() => expect(screen.getAllByRole('listitem')).toHaveLength(2))
    expect(screen.getByRole('status')).toHaveTextContent(/revisando a transcrição/i)
    release()
    await waitFor(() => expect(memory.contents.get(id!)).toContain('a proposta para a Marina.'))
    await waitFor(() => expect(useLibraryStore.getState().files.find(file => file.id === id)?.name).toBe('Lançamento em maio'))
    await waitFor(() => expect(screen.getByText(/a proposta para a/)).toHaveTextContent('Marina'))
    expect(useJobsStore.getState().jobs[0].status).toBe('done')
  })

  it('with the Ata asked, the transcript shows first and the Ata comes after', async () => {
    const id = await useJobsStore.getState().startNewContent(recordingRequest('meeting'))
    expect(id).toBeTruthy()
    expect(memory.contents.get(id!) ?? '').toBe('')
    release()
    await waitFor(() => expect(useLibraryStore.getState().files.find(file => file.id === id)?.status).toBe('ready'))
    expect(memory.contents.get(id!)).toContain('Lançar em maio')
    expect(memory.sidecars.get(id!)?.recording?.blocks[1].text).toBe('Sim, eu mando a proposta para a Marina.')
    expect(useLibraryStore.getState().files.find(file => file.id === id)?.name).not.toBe('Reunião 14-10-2026.webm')
  })
})
