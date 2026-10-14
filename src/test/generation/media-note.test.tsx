import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { Blob as NodeBlob, File as NodeFile } from 'node:buffer'
import { MemoryRouter } from 'react-router-dom'

vi.mock('@/lib/transcription', () => ({
  ENGINES: [],
  transcribe: vi.fn(async () => ({
    text: 'Você [00:00]: Vamos falar de limites.',
    engine: 'deepinfra',
    language: 'pt',
    durationSeconds: 364,
    speakers: 1,
    recording: { blocks: [{ speaker: 'mic', start: 0, end: 3, text: 'Vamos falar de limites.' }], speakers: [{ id: 'mic', name: 'Você', suggested: false }], marks: [] },
  })),
}))

vi.mock('@/components/reader/GithubMarkdownView', () => ({
  default: ({ markdown }: { markdown: string }) => <div data-testid="markdown">{markdown}</div>,
}))

import { DocumentBody } from '@/components/reader/DocumentArticle'
import { defaultIndex } from '@/lib/defaults'
import { PROMPTS } from '@/lib/generation/prompts.data'
import { listLocalMedia } from '@/lib/recording/media-library'
import type { Repository } from '@/lib/storage/repository'
import { transcribe } from '@/lib/transcription'
import { useJobsStore } from '@/stores/jobs'
import { useLibraryStore } from '@/stores/library'
import { type CapturedRequest, installFetch, openAiStream, systemPromptOf } from '@/test/ai/fake-provider'
import type { FileSidecar } from '@/types/domain'

function memoryRepository() {
  const sidecars = new Map<string, FileSidecar>()
  const contents = new Map<string, string>()
  const repo = {
    kind: 'local',
    accountId: 'local',
    readContent: async (id: string) => contents.get(id) ?? '',
    readSidecar: async (id: string) => sidecars.get(id)!,
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

function installBrowserFolder(): Map<string, Blob> {
  const files = new Map<string, Blob>()
  const handle = (name: string) => ({
    getFile: async () => new NodeFile([files.get(name) as never], name),
    createWritable: async () => {
      const parts: BlobPart[] = []
      return { write: async (data: BlobPart) => void parts.push(data), close: async () => void files.set(name, new NodeBlob(parts as never) as unknown as Blob) }
    },
  })
  const folder = {
    getFileHandle: async (name: string, options?: { create?: boolean }) => {
      if (!files.has(name) && !options?.create) throw new DOMException('missing', 'NotFoundError')
      return handle(name)
    },
    removeEntry: async (name: string) => void files.delete(name),
  }
  Object.defineProperty(navigator, 'storage', { configurable: true, value: { getDirectory: async () => folder } })
  return files
}

const asked: string[] = []

function provider(request: CapturedRequest): Response {
  const system = systemPromptOf(request)
  asked.push(system.slice(0, 30))
  if (system === PROMPTS.POLISH_PROMPT) return openAiStream(JSON.stringify({ titulo: 'Conversa sobre limites', nomes: [], correcoes: [] }))
  if (system === PROMPTS.SPEAKER_NAMES_PROMPT) return openAiStream(JSON.stringify({ nomes: [] }))
  if (system === PROMPTS.TITLE_PROMPT) return openAiStream(JSON.stringify({ titulo: 'Conversa sobre limites' }))
  if (system === PROMPTS.TRANSCRIPT_REVIEW_PROMPT) return openAiStream(JSON.stringify({ correcoes: [] }))
  return new Response('unexpected', { status: 500 })
}

let memory: ReturnType<typeof memoryRepository>

async function savedAudio(): Promise<string> {
  const folder = installBrowserFolder()
  folder.set('gravacao-1.webm', new NodeBlob([new Uint8Array(8)]) as unknown as Blob)
  folder.set('midias.json', new NodeBlob([JSON.stringify([{ storedName: 'gravacao-1.webm', name: 'Conversa no corredor.webm', mime: 'audio/webm', durationSeconds: 364, size: 8, createdAt: '2026-10-14T12:00:00Z', fileIds: [] }])]) as unknown as Blob)
  const file = new NodeFile([new Uint8Array(8)], 'Conversa no corredor.webm', { type: 'audio/webm' }) as unknown as File
  const id = await useJobsStore.getState().saveRecording({ file, storedName: 'gravacao-1.webm', durationSeconds: 364, folderId: null, storage: 'none', litterboxTime: '72h' as never, marks: [], transcribe: false })
  useLibraryStore.setState({ localMedia: await listLocalMedia() })
  return id
}

beforeEach(() => {
  asked.length = 0
  memory = memoryRepository()
  const index = defaultIndex()
  index.settings.ai = { provider: 'custom', baseUrl: 'https://api.exemplo.dev/v1', apiKey: 'test-key', model: 'default' }
  useLibraryStore.setState({ repo: memory.repo, accountId: 'local', ready: true, folders: [], files: [], index, opened: {}, openedAt: {}, localMedia: [], sharedView: null })
  useJobsStore.setState({ jobs: [], live: {}, proposals: [] })
  vi.mocked(transcribe).mockClear()
  installFetch(provider)
  vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: vi.fn(() => 'blob:gravacao'), revokeObjectURL: vi.fn() }))
})

afterEach(() => {
  vi.unstubAllGlobals()
})

const show = (id: string) =>
  render(
    <MemoryRouter>
      <DocumentBody fileId={id} />
    </MemoryRouter>,
  )

describe('an audio note without transcription is only the media', () => {
  it('shows the player, the media line and Transcrever agora, without calling any AI', async () => {
    const id = await savedAudio()
    show(id)
    expect(await screen.findByRole('region', { name: 'Player da gravação' })).toBeInTheDocument()
    expect(screen.getByText(/^Áudio · 6 min · gravado em .* · sem transcrição$/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Transcrever agora' })).toBeInTheDocument()
    expect(screen.queryByRole('tab', { name: 'Transcrição' })).not.toBeInTheDocument()
    expect(asked).toEqual([])
    expect(transcribe).not.toHaveBeenCalled()
  })

  it('Transcrever agora transcribes the kept media and the note shows the transcript, named by the subject', async () => {
    const id = await savedAudio()
    show(id)
    fireEvent.click(await screen.findByRole('button', { name: 'Transcrever agora' }))
    await waitFor(() => expect(transcribe).toHaveBeenCalledTimes(1))
    expect((vi.mocked(transcribe).mock.calls[0][0] as File).name).toBe('Conversa no corredor.webm')
    await waitFor(() => expect(screen.getByRole('tab', { name: 'Transcrição' })).toBeInTheDocument())
    expect(screen.getByText('Vamos falar de limites.')).toBeInTheDocument()
    expect(screen.getByText(/· com transcrição/)).toBeInTheDocument()
    await waitFor(() => expect(useLibraryStore.getState().files.find(file => file.id === id)?.name).toBe('Conversa sobre limites'))
    expect(memory.contents.get(id)).toContain('Vamos falar de limites.')
  })
})
