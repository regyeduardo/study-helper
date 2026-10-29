import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'

import { ConfirmDialog } from '@/components/dialogs/SimpleDialogs'
import { SharedBadge } from '@/components/library/SharedBadge'
import { defaultIndex } from '@/lib/defaults'
import { mediaOf } from '@/lib/file-types'
import { importSharedItem, shareUrl } from '@/lib/share'
import type { Repository } from '@/lib/storage/repository'
import { type Account, LOCAL_ACCOUNT, useAccountStore } from '@/stores/account'
import { type TrackedTask, useJobsStore } from '@/stores/jobs'
import { useLibraryStore } from '@/stores/library'
import { useUiStore } from '@/stores/ui'
import type { FileSidecar, MeetingDocument, SharedFile, SharedItem } from '@/types/domain'

const GOOGLE: Account = { id: 'google-1', kind: 'google', name: 'Ana', email: 'ana@example.com', picture: '', token: { accessToken: 'at-1', expiresAt: Date.now() + 3600_000 } }

const SHARE_ID = 'ImportarMidiaImportar1'
const MEDIA_URL = `https://share.test/media/${SHARE_ID}/f1`
const SIZE = 1000

const ATA: MeetingDocument = { id: 'ata-1', kind: 'ata', parts: ['resumo'], markdown: '## Resumo\n\nFechamos a curva de vendas.', images: [], createdAt: '2026-09-28T12:00:00.000Z', models: {} }

function memoryRepository() {
  const sidecars = new Map<string, FileSidecar>()
  const contents = new Map<string, string>()
  const putSource = vi.fn(async () => ({ ref: 'drive-nova' }))
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
    putSource,
  } as unknown as Repository
  return { repo, putSource }
}

function installBrowserFolder(): Map<string, BlobPart[]> {
  const files = new Map<string, BlobPart[]>()
  const handle = (name: string) => ({
    getFile: async () => ({ text: async () => (files.get(name) ?? []).map(String).join('') }),
    createWritable: async () => {
      const parts: BlobPart[] = []
      return { write: async (data: BlobPart) => void parts.push(data), close: async () => void files.set(name, parts) }
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

function serveMedia() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string) => {
      if (String(input) !== MEDIA_URL) return new Response('not found', { status: 404 })
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array(600))
          controller.enqueue(new Uint8Array(SIZE - 600))
          controller.close()
        },
      })
      return new Response(body, { headers: { 'Content-Length': String(SIZE), 'Content-Type': 'video/mp4' } })
    }),
  )
}

function meetingFile(fields: Partial<SharedFile> = {}): SharedFile {
  return {
    id: 'f1',
    name: 'Reunião',
    folderId: null,
    type: 'meeting',
    position: 0,
    description: '',
    tags: [],
    content: '# Ata anterior',
    questions: [],
    highlights: [],
    transcript: 'Você [00:00]: Bom dia.',
    documents: [ATA],
    media: { url: MEDIA_URL, mime: '', size: SIZE },
    meta: { origin: { input: 'file', name: 'Reunião.mp4', mime: 'video/mp4', sizeBytes: SIZE, durationSeconds: 95, storage: 'drive', storedFileId: 'drive-da-ana' } },
    ...fields,
  }
}

function sharedItem(file: SharedFile = meetingFile(), fields: Partial<SharedItem> = {}): SharedItem {
  return {
    version: 2,
    id: SHARE_ID,
    kind: 'file',
    title: file.name,
    createdAt: new Date(Date.now() - 3600_000).toISOString(),
    expiresAt: new Date(Date.now() + 2 * 24 * 3600_000).toISOString(),
    mediaExpiresAt: new Date(Date.now() + 2 * 24 * 3600_000).toISOString(),
    folders: [],
    files: [file],
    ...fields,
  }
}

function tracker() {
  const updates: [string, number | null][] = []
  const done = vi.fn()
  const fail = vi.fn()
  const track = vi.fn((): TrackedTask => ({ update: (message, fraction) => void updates.push([message, fraction]), done, fail }))
  return { track, updates, done, fail }
}

function actions() {
  const library = useLibraryStore.getState()
  return { createFolder: library.createFolder, createFile: library.createFile, updateSidecar: library.updateSidecar }
}

function Confirm() {
  const overlay = useUiStore(state => state.overlay)
  return overlay?.kind === 'confirm' ? <ConfirmDialog overlay={overlay} /> : null
}

function renderBadge(item: SharedItem) {
  useLibraryStore.getState().enterShared(item, {})
  render(
    <MemoryRouter initialEntries={[`/shared/${item.id}`]}>
      <Routes>
        <Route path="/shared/:shareId" element={<SharedBadge />} />
        <Route path="*" element={<div>biblioteca</div>} />
      </Routes>
      <Confirm />
    </MemoryRouter>,
  )
  fireEvent.click(screen.getByRole('button', { name: 'Importar para a minha biblioteca' }))
}

let memory: ReturnType<typeof memoryRepository>
let folder: Map<string, BlobPart[]>

beforeEach(() => {
  memory = memoryRepository()
  folder = installBrowserFolder()
  serveMedia()
  useAccountStore.setState({ accounts: [LOCAL_ACCOUNT], activeId: LOCAL_ACCOUNT.id, reconnectId: null })
  useLibraryStore.setState({ repo: memory.repo, accountId: 'local', ready: true, folders: [], files: [], index: defaultIndex(), opened: {}, openedAt: {}, localMedia: [], sharedView: null })
  useJobsStore.setState({ jobs: [], live: {}, proposals: [] })
  useUiStore.setState({ overlay: null, toasts: [] })
})

afterEach(() => {
  useLibraryStore.getState().leaveShared()
  useAccountStore.setState({ accounts: [LOCAL_ACCOUNT], activeId: LOCAL_ACCOUNT.id })
  vi.unstubAllGlobals()
})

describe('importar com a mídia e a Ata', () => {
  it('neste navegador: a nota vem com a Ata e o vídeo fica nas mídias do navegador, ligado à nota nova', async () => {
    const task = tracker()
    const result = await importSharedItem(sharedItem(), {}, actions(), { place: 'browser', repo: memory.repo, track: task.track })
    const note = useLibraryStore.getState().files.find(file => file.id === result.fileId)!
    expect((await useLibraryStore.getState().openFile(note.id)).sidecar.documents).toEqual([ATA])
    expect(note.origin).toMatchObject({ input: 'file', name: 'Reunião.mp4', mime: 'video/mp4', sizeBytes: SIZE, durationSeconds: 95, storage: 'none' })
    expect(note.origin).not.toHaveProperty('storedFileId')
    expect(mediaOf(note)).toBe('video')
    expect(fetch).toHaveBeenCalledWith(MEDIA_URL)
    await waitFor(() => expect(useLibraryStore.getState().localMedia).toHaveLength(1))
    const [kept] = useLibraryStore.getState().localMedia
    expect(kept).toMatchObject({ name: 'Reunião.mp4', fileIds: [note.id], mime: 'video/mp4', size: SIZE, durationSeconds: 95 })
    const written = folder.get(kept.storedName)![0] as File
    expect(written.size).toBe(SIZE)
    expect(written.type).toBe('video/mp4')
    expect(memory.putSource).not.toHaveBeenCalled()
    expect(task.track).toHaveBeenCalledWith('Guardar a mídia: Reunião')
    expect(task.updates).toContainEqual(['Baixando a mídia: 60%', 0.6])
    expect(task.updates).toContainEqual(['Baixando a mídia: 100%', 1])
    expect(task.done).toHaveBeenCalled()
    expect(task.fail).not.toHaveBeenCalled()
  })

  it('no Google Drive: a mídia vai pela fonte guardada do Drive e a origem aponta para ela', async () => {
    const task = tracker()
    const result = await importSharedItem(sharedItem(), {}, actions(), { place: 'drive', repo: memory.repo, track: task.track })
    const note = useLibraryStore.getState().files.find(file => file.id === result.fileId)!
    expect((await useLibraryStore.getState().openFile(note.id)).sidecar.documents).toEqual([ATA])
    expect(memory.putSource).toHaveBeenCalledWith(note.id, expect.any(File), 'Reunião.mp4')
    const sent = (memory.putSource.mock.calls[0] as unknown as [string, File])[1]
    expect(sent.size).toBe(SIZE)
    expect(sent.type).toBe('video/mp4')
    expect(note.origin).toMatchObject({ input: 'file', name: 'Reunião.mp4', mime: 'video/mp4', sizeBytes: SIZE, durationSeconds: 95, storage: 'drive', storedFileId: 'drive-nova', expiresAt: null })
    expect(mediaOf(note)).toBe('video')
    expect(useLibraryStore.getState().localMedia).toEqual([])
    expect(task.done).toHaveBeenCalled()
  })
})

describe('onde guardar a mídia', () => {
  it('com o Drive, pergunta antes; "No Google Drive" guarda lá e abre a nota', async () => {
    useAccountStore.setState({ accounts: [LOCAL_ACCOUNT, GOOGLE], activeId: GOOGLE.id })
    renderBadge(sharedItem())
    expect(await screen.findByText('Onde guardar a mídia?')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Neste navegador' })).toBeInTheDocument()
    expect(useLibraryStore.getState().sharedView).not.toBeNull()
    expect(fetch).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'No Google Drive' }))
    expect(await screen.findByText('biblioteca')).toBeInTheDocument()
    const [note] = useLibraryStore.getState().files
    expect(memory.putSource).toHaveBeenCalledWith(note.id, expect.any(File), 'Reunião.mp4')
    expect(note.origin).toMatchObject({ storage: 'drive', storedFileId: 'drive-nova', mime: 'video/mp4' })
    expect(useJobsStore.getState().jobs[0]).toMatchObject({ title: 'Guardar a mídia: Reunião', status: 'done' })
  })

  it('com o Drive, "Neste navegador" guarda nas mídias do navegador', async () => {
    useAccountStore.setState({ accounts: [LOCAL_ACCOUNT, GOOGLE], activeId: GOOGLE.id })
    renderBadge(sharedItem())
    fireEvent.click(await screen.findByRole('button', { name: 'Neste navegador' }))
    expect(await screen.findByText('biblioteca')).toBeInTheDocument()
    const [note] = useLibraryStore.getState().files
    await waitFor(() => expect(useLibraryStore.getState().localMedia.map(item => item.fileIds)).toEqual([[note.id]]))
    expect(memory.putSource).not.toHaveBeenCalled()
  })

  it('sem o Drive, não pergunta: a mídia fica neste navegador', async () => {
    renderBadge(sharedItem())
    expect(await screen.findByText('biblioteca')).toBeInTheDocument()
    expect(screen.queryByText('Onde guardar a mídia?')).not.toBeInTheDocument()
    const [note] = useLibraryStore.getState().files
    await waitFor(() => expect(useLibraryStore.getState().localMedia.map(item => item.fileIds)).toEqual([[note.id]]))
    expect(note.origin).toMatchObject({ storage: 'none', mime: 'video/mp4' })
    expect(memory.putSource).not.toHaveBeenCalled()
  })
})

describe('nota sem mídia', () => {
  it('importa como hoje: sem pergunta, sem baixar nada, origem "compartilhado"', async () => {
    useAccountStore.setState({ accounts: [LOCAL_ACCOUNT, GOOGLE], activeId: GOOGLE.id })
    const item = sharedItem(meetingFile({ name: 'Aula 1', type: 'class', content: '# Aula 1', transcript: undefined, documents: undefined, media: undefined, meta: undefined }))
    renderBadge(item)
    expect(await screen.findByText('biblioteca')).toBeInTheDocument()
    expect(screen.queryByText('Onde guardar a mídia?')).not.toBeInTheDocument()
    expect(fetch).not.toHaveBeenCalled()
    const [note] = useLibraryStore.getState().files
    expect(note.origin).toEqual({ input: 'shared', name: 'Aula 1', url: shareUrl(SHARE_ID), storage: 'none' })
    expect((await useLibraryStore.getState().openFile(note.id)).sidecar).not.toHaveProperty('documents')
    expect(useJobsStore.getState().jobs).toEqual([])
    expect(useLibraryStore.getState().localMedia).toEqual([])
  })

  it('mídia já expirada no link: não pergunta nem baixa, a nota vem com a Ata', async () => {
    useAccountStore.setState({ accounts: [LOCAL_ACCOUNT, GOOGLE], activeId: GOOGLE.id })
    renderBadge(sharedItem(meetingFile(), { mediaExpiresAt: new Date(Date.now() - 1000).toISOString() }))
    expect(await screen.findByText('biblioteca')).toBeInTheDocument()
    expect(screen.queryByText('Onde guardar a mídia?')).not.toBeInTheDocument()
    expect(fetch).not.toHaveBeenCalled()
    const [note] = useLibraryStore.getState().files
    expect(note.origin).toMatchObject({ input: 'shared', storage: 'none' })
    expect((await useLibraryStore.getState().openFile(note.id)).sidecar.documents).toEqual([ATA])
  })
})
