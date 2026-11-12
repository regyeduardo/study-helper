import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter, Route, Routes, useLocation, useParams } from 'react-router-dom'

import type { FileSidecar, SharedItem } from '@/types/domain'
import { ConfirmDialog } from '@/components/dialogs/SimpleDialogs'
import { EntryPage } from '@/components/reader/EntryPage'
import { useMeetingMedia } from '@/components/reader/MediaPlayer'
import { defaultIndex, newFolderMeta } from '@/lib/defaults'
import { env } from '@/lib/env'
import { buildEntryShareContent } from '@/lib/share'
import { choiceOf, defaultChoice, entryShareTree } from '@/lib/share-entry'
import type { Repository } from '@/lib/storage/repository'
import { useSharedRoute } from '@/pages/shared'
import { type Account, LOCAL_ACCOUNT, useAccountStore } from '@/stores/account'
import { useJobsStore } from '@/stores/jobs'
import { useLibraryStore } from '@/stores/library'
import { useUiStore } from '@/stores/ui'

import { CONTENTS, ENTRY_NAME, entryFamily } from './entry-family'

const GOOGLE: Account = { id: 'google-1', kind: 'google', name: 'Bia', email: 'bia@example.com', picture: '', token: { accessToken: 'at-1', expiresAt: Date.now() + 3600_000 } }
const SHARE_ID = 'MidiaDaEntradaImportada1'
const MEDIA_URL = `https://share.test/media/${SHARE_ID}/e`
const SIZE = 2048
const BYTES = Uint8Array.from({ length: SIZE }, (_, index) => index % 251)

let sidecars: FileSidecar[]
let replies: Record<string, () => Response>
let opfs: Map<string, Blob>
let driveFiles: Map<string, Blob>
let putSource: ReturnType<typeof vi.fn>
let played: Blob[]

// jsdom's Blob is not Node's: it is read with the FileReader
function bufferOf(blob: Blob): Promise<ArrayBuffer> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result as ArrayBuffer)
    reader.onerror = () => reject(reader.error)
    reader.readAsArrayBuffer(blob)
  })
}

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })
}

/** Ana's link, as the Worker stores it: the media of the entrada is in the manifest. */
async function anasLink(): Promise<SharedItem> {
  const metas = sidecars.map(sidecar => sidecar.meta)
  const open = async (id: string) => ({ content: CONTENTS[id] ?? '', sidecar: sidecars.find(sidecar => sidecar.meta.id === id)! })
  const tree = entryShareTree(metas, 'e')
  const content = await buildEntryShareContent('e', metas, open, choiceOf(tree, defaultChoice(tree, true)))
  const day = 24 * 3600_000
  return {
    ...content,
    files: content.files.map(file => (file.id === 'e' ? { ...file, media: { url: MEDIA_URL, mime: 'video/mp4', size: SIZE } } : file)),
    version: 2,
    id: SHARE_ID,
    createdAt: new Date(Date.now() - 3600_000).toISOString(),
    expiresAt: new Date(Date.now() + 2 * day).toISOString(),
    mediaExpiresAt: new Date(Date.now() + 2 * day).toISOString(),
  }
}

/** The media comes in two halves: the first arrives at once, the second when the test lets it. */
function holdMedia(): () => void {
  let finish: () => void = () => undefined
  replies[`GET ${MEDIA_URL}`] = () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(BYTES.slice(0, SIZE / 2))
        finish = () => {
          controller.enqueue(BYTES.slice(SIZE / 2))
          controller.close()
        }
      },
    })
    return new Response(body, { headers: { 'Content-Length': String(SIZE), 'Content-Type': 'video/mp4' } })
  }
  return () => finish()
}

function serve(item: SharedItem) {
  const url = (path: string) => `GET https://files.test/shared/${item.id}/${encodeURIComponent(path)}`
  const pathOf = (name: string) => name.replace(/[\\/]/g, '-')
  replies[url('share.json')] = () =>
    json({ version: 2, id: item.id, kind: item.kind, title: item.title, createdAt: item.createdAt, expiresAt: item.expiresAt, mediaExpiresAt: item.mediaExpiresAt, folders: [], files: item.files.map(file => ({ id: file.id, path: pathOf(file.name), ...(file.media ? { media: { key: `shared-media/${item.id}/${file.id}`, mime: file.media.mime, size: file.media.size } } : {}) })) })
  for (const file of item.files) {
    replies[url(`${pathOf(file.name)}.md`)] = () => new Response(file.content)
    const meta = { ...file.meta, id: file.id, name: file.name, folderId: file.folderId, type: file.type, position: file.position, description: file.description, tags: file.tags }
    replies[url(`${pathOf(file.name)}.json`)] = () => json({ meta, questions: file.questions, attempts: [], highlights: file.highlights, ...(file.transcript !== undefined ? { transcript: file.transcript } : {}), ...(file.recording ? { recording: file.recording } : {}), ...(file.artifacts ? { artifacts: file.artifacts } : {}) })
  }
}

/** The browser's private folder keeping what is written, so that the player can read the media back. */
function installBrowserFolder() {
  opfs = new Map()
  const handle = (name: string) => ({
    // jsdom's File has no text(): the index of the media is read with the FileReader
    getFile: async () => {
      const file = new File(opfs.has(name) ? [opfs.get(name)!] : [], name)
      return Object.assign(file, { text: async () => new TextDecoder().decode(new Uint8Array(await bufferOf(file))) })
    },
    createWritable: async () => {
      const parts: BlobPart[] = []
      return { write: async (data: BlobPart) => void parts.push(data), close: async () => void opfs.set(name, new Blob(parts)) }
    },
  })
  Object.defineProperty(navigator, 'storage', {
    configurable: true,
    value: {
      getDirectory: async () => ({
        getFileHandle: async (name: string, options?: { create?: boolean }) => {
          if (!opfs.has(name) && !options?.create) throw new DOMException('missing', 'NotFoundError')
          return handle(name)
        },
        removeEntry: async (name: string) => void opfs.delete(name),
      }),
    },
  })
}

function driveRepository(): Repository {
  const kept = new Map(sidecars.map(sidecar => [sidecar.meta.id, sidecar]))
  const texts = new Map<string, string>()
  driveFiles = new Map()
  putSource = vi.fn(async (_fileId: string, blob: Blob) => {
    driveFiles.set('drive-nova', blob)
    return { ref: 'drive-nova' }
  })
  return {
    kind: 'drive',
    accountId: 'google-1',
    readContent: async (id: string) => texts.get(id) ?? '',
    readSidecar: async (id: string) => kept.get(id)!,
    saveFile: async (sidecar: FileSidecar, content?: string) => {
      kept.set(sidecar.meta.id, sidecar)
      if (content !== undefined) texts.set(sidecar.meta.id, content)
      return sidecar
    },
    saveFolder: async () => undefined,
    saveIndex: async () => undefined,
    fileSizes: async () => ({}),
    putSource,
    getSource: async (ref: string) => driveFiles.get(ref)!,
  } as unknown as Repository
}

beforeEach(() => {
  env.shareWorkerUrl = 'https://share.test'
  env.sharedFilesUrl = 'https://files.test'
  sidecars = entryFamily()
  replies = {}
  played = []
  replies[`GET ${MEDIA_URL}`] = () => new Response(BYTES, { headers: { 'Content-Length': String(SIZE), 'Content-Type': 'video/mp4' } })
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string, init: RequestInit = {}) => replies[`${init.method ?? 'GET'} ${String(input)}`]?.() ?? new Response('not found', { status: 404 })),
  )
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => undefined)
  Object.assign(URL, {
    createObjectURL: vi.fn((blob: Blob) => {
      played.push(blob)
      return `blob:tocar-${played.length}`
    }),
    revokeObjectURL: vi.fn(),
  })
  installBrowserFolder()
  useAccountStore.setState({ accounts: [LOCAL_ACCOUNT], activeId: LOCAL_ACCOUNT.id, reconnectId: null })
  useLibraryStore.setState({ repo: driveRepository(), accountId: 'local', ready: true, folders: [newFolderMeta({ id: 'trabalho', name: 'Trabalho da Bia' })], files: [], index: defaultIndex(), opened: {}, openedAt: {}, sizes: {}, localMedia: [], sharedView: null })
  useJobsStore.setState({ jobs: [], live: {}, proposals: [] })
  useUiStore.setState({ overlay: null, toasts: [] })
})

afterEach(() => {
  useLibraryStore.getState().leaveShared()
  useAccountStore.setState({ accounts: [LOCAL_ACCOUNT], activeId: LOCAL_ACCOUNT.id })
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

function SharedPage() {
  const { shareId = '' } = useParams()
  const route = useSharedRoute(shareId)
  if (route.view === 'entry' && route.fileId) return <EntryPage fileId={route.fileId} />
  return <div>abrindo</div>
}

/** What the app does when the person opens the imported entrada: the page of the entrada, and the state of its media. */
function Imported() {
  const { fileId = '' } = useParams()
  const meta = useLibraryStore(state => state.files.find(file => file.id === fileId) ?? null)
  const media = useMeetingMedia(meta)
  return (
    <div>
      <span>{`midia ${media.available ? 'disponivel' : 'ausente'}`}</span>
      <span>{`url ${media.url ?? 'nenhuma'}`}</span>
      <span>{`tipo ${media.video ? 'video' : 'audio'}`}</span>
      {meta && <EntryPage fileId={fileId} />}
    </div>
  )
}

function Where() {
  return <div>{`aberto ${useLocation().pathname}`}</div>
}

function Confirm() {
  const overlay = useUiStore(state => state.overlay)
  return overlay?.kind === 'confirm' ? <ConfirmDialog overlay={overlay} /> : null
}

async function importLink() {
  serve(await anasLink())
  render(
    <MemoryRouter initialEntries={[`/shared/${SHARE_ID}`]}>
      <Routes>
        <Route path="/shared/:shareId" element={<SharedPage />} />
        <Route path="/arquivo/:fileId" element={<Imported />} />
      </Routes>
      <Confirm />
      <Where />
    </MemoryRouter>,
  )
  fireEvent.click(await screen.findByRole('button', { name: 'Importar para a minha biblioteca' }))
  const chooser = await screen.findByRole('dialog', { name: 'Importar para a minha biblioteca' })
  fireEvent.click(within(chooser).getByRole('treeitem', { name: /Trabalho da Bia/ }))
  fireEvent.click(within(chooser).getByRole('button', { name: 'Importar aqui' }))
}

const imported = () => useLibraryStore.getState().files.find(file => file.role === 'entrada')!

async function bytesOf(blob: Blob): Promise<number[]> {
  return [...new Uint8Array(await bufferOf(blob))]
}

describe('a entrada importada com mídia toca a mídia', () => {
  it('neste navegador: a mídia baixa inteira, fica guardada e o player da entrada recebe o mesmo vídeo', async () => {
    await importLink()
    expect(await screen.findByText('midia disponivel')).toBeInTheDocument()
    expect(fetch).toHaveBeenCalledWith(MEDIA_URL)
    const entry = imported()
    expect(entry).toMatchObject({ name: ENTRY_NAME, folderId: 'trabalho', kept: 'arquivo' })
    expect(entry.origin).toMatchObject({ input: 'file', name: 'planejamento.mp4', mime: 'video/mp4', storage: 'none' })
    expect(useLibraryStore.getState().localMedia.map(media => media.fileIds)).toEqual([[entry.id]])
    expect(await screen.findByText('tipo video')).toBeInTheDocument()
    await waitFor(() => expect(screen.getByText(/^url blob:tocar-/)).toBeInTheDocument())
    const blob = played[played.length - 1]
    expect(blob.size).toBe(SIZE)
    expect((blob as File).type).toBe('video/mp4')
    expect(await bytesOf(blob)).toEqual([...BYTES])
    expect(screen.getByRole('region', { name: 'Player da gravação' })).toBeInTheDocument()
    expect(putSource).not.toHaveBeenCalled()
    expect(useJobsStore.getState().jobs[0]).toMatchObject({ title: 'Guardar a mídia: ' + ENTRY_NAME, status: 'done' })
  })

  it('no Google Drive: o vídeo vai para o Drive de quem importa e o player o busca lá', async () => {
    useAccountStore.setState({ accounts: [LOCAL_ACCOUNT, GOOGLE], activeId: GOOGLE.id })
    await importLink()
    fireEvent.click(await screen.findByRole('button', { name: 'No Google Drive' }))
    expect(await screen.findByText('midia disponivel')).toBeInTheDocument()
    const entry = imported()
    expect(putSource).toHaveBeenCalledWith(entry.id, expect.any(File), 'planejamento.mp4')
    expect(entry.origin).toMatchObject({ input: 'file', mime: 'video/mp4', storage: 'drive', storedFileId: 'drive-nova' })
    expect(entry.kept).toBe('arquivo')
    expect(useLibraryStore.getState().localMedia).toEqual([])
    expect(await bytesOf(driveFiles.get('drive-nova')!)).toEqual([...BYTES])
    expect(screen.getByRole('region', { name: 'Player da gravação' })).toBeInTheDocument()
  })
})

describe('a mídia demora ou não vem', () => {
  it('enquanto baixa, a pessoa continua no link, com o andamento, e nada é criado pela metade', async () => {
    const finish = holdMedia()
    await importLink()
    const button = await screen.findByRole('button', { name: 'Baixando a mídia… 50%' })
    expect(button).toBeDisabled()
    expect(useLibraryStore.getState().sharedView).not.toBeNull()
    // still the link: what the store shows is the link itself, and nothing was imported yet
    expect(useLibraryStore.getState().files.some(file => file.sharedFrom)).toBe(false)
    expect(screen.getByRole('heading', { level: 1, name: ENTRY_NAME })).toBeInTheDocument()
    expect(screen.queryByText('Entrada não encontrada.')).not.toBeInTheDocument()
    finish()
    expect(await screen.findByText('midia disponivel')).toBeInTheDocument()
    expect(imported().kept).toBe('arquivo')
    expect(useUiStore.getState().toasts.map(toast => toast.text)).toEqual(['Importado para a sua biblioteca'])
    await waitFor(() => expect(played.length).toBeGreaterThan(0))
    expect(await bytesOf(played[played.length - 1])).toEqual([...BYTES])
  })

  it('se a mídia não baixa, a entrada vem só como registro e o aviso diz que a mídia não veio', async () => {
    replies[`GET ${MEDIA_URL}`] = () => new Response('erro', { status: 500 })
    await importLink()
    expect(await screen.findByText('midia ausente')).toBeInTheDocument()
    expect(imported().kept).toBe('registro')
    expect(screen.getByText(/Guardado só como registro/)).toBeInTheDocument()
    expect(useUiStore.getState().toasts.map(toast => toast.text)).toEqual(['Importado, mas a mídia não veio: Não consegui baixar a mídia compartilhada.'])
    expect(useLibraryStore.getState().localMedia).toEqual([])
    expect(useLibraryStore.getState().files.map(file => file.name).sort()).toEqual([ENTRY_NAME, 'Ata', 'Aula', 'Explicação: contratos'].sort())
  })

  it('se o Drive não guarda a mídia, a entrada vem só como registro e o aviso diz o motivo', async () => {
    useAccountStore.setState({ accounts: [LOCAL_ACCOUNT, GOOGLE], activeId: GOOGLE.id })
    putSource.mockRejectedValueOnce(new Error('Não cabe no limite do Drive.'))
    await importLink()
    fireEvent.click(await screen.findByRole('button', { name: 'No Google Drive' }))
    expect(await screen.findByText('midia ausente')).toBeInTheDocument()
    expect(imported().kept).toBe('registro')
    expect(useUiStore.getState().toasts.map(toast => toast.text)).toEqual(['Importado, mas a mídia não veio: Não cabe no limite do Drive.'])
    expect(useJobsStore.getState().jobs[0]).toMatchObject({ status: 'error' })
  })
})
