import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { Blob as NodeBlob, File as NodeFile } from 'node:buffer'
import { MemoryRouter } from 'react-router-dom'

import { DocumentBody } from '@/components/reader/DocumentArticle'
import { defaultIndex } from '@/lib/defaults'
import { PROMPTS } from '@/lib/generation/prompts.data'
import { transcribe } from '@/lib/transcription'
import { listLocalMedia } from '@/lib/recording/media-library'
import type { Repository } from '@/lib/storage/repository'
import { useJobsStore, type NewContentRequest } from '@/stores/jobs'
import { useLibraryStore } from '@/stores/library'
import { useUiStore } from '@/stores/ui'
import { type CapturedRequest, installFetch, openAiStream, systemPromptOf } from '@/test/ai/fake-provider'
import type { FileSidecar, RecordingData } from '@/types/domain'

const { heard } = vi.hoisted(() => ({
  heard: {
    blocks: [
      { speaker: 'mic', start: 0, end: 3, text: 'Vamos lançar em maio?' },
      { speaker: 'speaker_0', start: 4, end: 8, text: 'Vamos lançar em maio, eu mando a proposta para a Mariana.' },
      { speaker: 'mic', start: 9, end: 10, text: 'Valeu, Bruno.' },
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

function provider(request: CapturedRequest): Response {
  const system = systemPromptOf(request)
  if (system === PROMPTS.POLISH_PROMPT) return openAiStream(JSON.stringify({ titulo: '', nomes: [{ falante: 'Falante 2', nome: 'Bruno', citacao: 'Valeu, Bruno.' }], correcoes: [{ fala: 2, de: 'Mariana', para: 'Marina' }] }))
  if (system === PROMPTS.SPEAKER_NAMES_PROMPT) return openAiStream(JSON.stringify({ nomes: [{ falante: 'Falante 2', nome: 'Bruno', citacao: 'Valeu, Bruno.' }] }))
  if (system === PROMPTS.TRANSCRIPT_REVIEW_PROMPT) return openAiStream(JSON.stringify({ correcoes: [{ fala: 2, de: 'Mariana', para: 'Marina' }] }))
  if (system === PROMPTS.MINUTES_EXTRACT_PROMPT) return openAiStream(JSON.stringify({ assunto: 'Lançamento', temas: [{ tema: 'Data', pontos: [{ texto: 'Lançar em maio', citacao: 'Vamos lançar em maio, eu mando', hora: '00:04' }] }], passos: [] }))
  return new Response(`unexpected ${system.slice(0, 40)}`, { status: 500 })
}

function recordingRequest(agent: NewContentRequest['agent']): NewContentRequest {
  const file = new NodeFile([new Uint8Array(4)], 'Reunião 08-10-2026.webm', { type: 'audio/webm' }) as unknown as File
  return { agent, input: { kind: 'recording', file }, name: '', description: '', folderId: null, prompt: '', storage: 'none', litterboxTime: '72h' as NewContentRequest['litterboxTime'] }
}

async function noteFrom(agent: NewContentRequest['agent']): Promise<string> {
  const id = await useJobsStore.getState().startNewContent(recordingRequest(agent))
  await waitFor(() => expect(useLibraryStore.getState().files.find(file => file.id === id)?.status).toBe('ready'))
  return id!
}

const tabs = () => screen.getAllByRole('tab').map(tab => `${tab.textContent}${tab.getAttribute('aria-selected') === 'true' ? '*' : ''}`)
const open = (id: string) =>
  render(
    <MemoryRouter>
      <DocumentBody fileId={id} />
    </MemoryRouter>,
  )

let memory: ReturnType<typeof memoryRepository>

beforeEach(() => {
  memory = memoryRepository()
  const index = defaultIndex()
  index.settings.ai = { provider: 'custom', baseUrl: 'https://api.llm7.io/v1', apiKey: 'llm7-test-key', model: 'default' }
  useLibraryStore.setState({ repo: memory.repo, accountId: 'local', ready: true, folders: [], files: [], index, opened: {}, openedAt: {}, localMedia: [], sharedView: null })
  useJobsStore.setState({ jobs: [], live: {}, proposals: [] })
  installFetch(provider)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('"O que gerar" chooses only the second tab', () => {
  it('"Só a transcrição" gives a note with the Transcrição tab alone, already named and reviewed', async () => {
    const id = await noteFrom('reading')
    const recording = memory.sidecars.get(id)!.recording as RecordingData
    expect(recording.speakers).toEqual([
      { id: 'mic', name: 'Você', suggested: false },
      { id: 'speaker_0', name: 'Bruno', suggested: true },
    ])
    expect(recording.blocks[1]).toMatchObject({ text: 'Vamos lançar em maio, eu mando a proposta para a Marina.', original: 'Vamos lançar em maio, eu mando a proposta para a Mariana.' })
    expect(memory.contents.get(id)).toBe('Você [00:00]: Vamos lançar em maio?\nBruno [00:04]: Vamos lançar em maio, eu mando a proposta para a Marina.\nVocê [00:09]: Valeu, Bruno.')
    open(id)
    await waitFor(() => expect(screen.getAllByRole('listitem')).toHaveLength(3))
    expect(tabs()).toEqual(['Transcrição*'])
    expect(screen.queryByTestId('markdown')).not.toBeInTheDocument()
  })

  it('asking for the Ata later, in the note, opens the checkboxes of the parts first', async () => {
    const id = await noteFrom('reading')
    open(id)
    fireEvent.click(await screen.findByRole('button', { name: 'Gerar a Ata' }))
    expect(useUiStore.getState().overlay).toEqual({ kind: 'ata-parts', fileId: id })
    expect(useJobsStore.getState().jobs.filter(job => job.status === 'running')).toHaveLength(0)
  })

  it('"Ata de reunião" gives the two tabs at once, the Ata pointing to the speech', async () => {
    const id = await noteFrom('meeting')
    expect(memory.contents.get(id)).toContain('[▸ 00:04](#t=4)')
    open(id)
    await waitFor(() => expect(tabs()).toEqual(['Transcrição', 'Ata*']))
    expect(screen.queryByRole('button', { name: 'Gerar a Ata' })).not.toBeInTheDocument()
  })

  it('"Ata de reunião" with the parts chosen keeps the transcription and starts the Ata with those parts', async () => {
    const generateAta = vi.fn(async () => undefined)
    useJobsStore.setState({ generateAta })
    const id = await useJobsStore.getState().startNewContent({ ...recordingRequest('meeting'), ataParts: ['resumo', 'tarefas'] })
    await waitFor(() => expect(generateAta).toHaveBeenCalledWith(id, ['resumo', 'tarefas']))
    expect(useLibraryStore.getState().files.find(file => file.id === id)).toMatchObject({ type: 'reading', status: 'ready' })
    expect(memory.contents.get(id!)).toContain('Bruno [00:04]:')
  })

  it('renaming a speaker in the note is saved and reaches the Ata', async () => {
    const id = await noteFrom('reading')
    open(id)
    fireEvent.click((await screen.findAllByRole('button', { name: 'Renomear Bruno' }))[0])
    fireEvent.change(screen.getByRole('textbox', { name: 'Nome do falante' }), { target: { value: 'Bruno Lima' } })
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Nome do falante' }), { key: 'Enter' })
    await waitFor(() => expect(memory.sidecars.get(id)!.recording?.speakers[1]).toEqual({ id: 'speaker_0', name: 'Bruno Lima', suggested: false }))
    await waitFor(() => expect(memory.contents.get(id)).toContain('Bruno Lima [00:04]:'))
    expect(memory.contents.get(id)).toContain('Você [00:09]: Valeu, Bruno.')
  })

  it('"Refazer a Ata" opens the checkboxes of the parts, without writing anything yet', async () => {
    const id = await noteFrom('meeting')
    const before = memory.contents.get(id)
    open(id)
    await waitFor(() => expect(tabs()).toEqual(['Transcrição', 'Ata*']))
    fireEvent.click(screen.getByRole('button', { name: 'Refazer a Ata' }))
    expect(useUiStore.getState().overlay).toEqual({ kind: 'ata-parts', fileId: id })
    expect(memory.contents.get(id)).toBe(before)
  })
})

function installBrowserFolder(): Map<string, Blob> {
  const files = new Map<string, Blob>()
  const handle = (name: string) => ({
    getFile: async () => {
      const blob = files.get(name)
      if (!blob) throw new DOMException('missing', 'NotFoundError')
      return new NodeFile([blob as never], name)
    },
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

describe('a video sent by "Novo conteúdo"', () => {
  it('stays in Mídias, linked to the note, so the note has the player', async () => {
    const files = installBrowserFolder()
    const video = new NodeFile([new Uint8Array(8)], 'aula.mp4', { type: 'video/mp4' }) as unknown as File
    const id = await useJobsStore.getState().startNewContent({ ...recordingRequest('reading'), input: { kind: 'file', file: video } })
    await waitFor(async () => expect(await listLocalMedia()).toHaveLength(1))
    const [kept] = await listLocalMedia()
    expect(kept).toMatchObject({ name: 'aula.mp4', mime: 'video/mp4', size: 8, fileIds: [id] })
    expect(files.get(kept.storedName)?.size).toBe(8)
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: () => 'blob:aula', revokeObjectURL: () => undefined }))
    open(id!)
    expect(await screen.findByRole('region', { name: 'Player da gravação' })).toBeInTheDocument()
  })
})
