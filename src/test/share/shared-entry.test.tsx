import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter, Route, Routes, useLocation, useParams } from 'react-router-dom'

import type { FileSidecar, SharedItem } from '@/types/domain'
import { ConfirmDialog } from '@/components/dialogs/SimpleDialogs'
import { EntryPage } from '@/components/reader/EntryPage'
import { defaultIndex, newFolderMeta } from '@/lib/defaults'
import { env } from '@/lib/env'
import { buildEntryShareContent } from '@/lib/share'
import { choiceOf, defaultChoice, entryShareTree, toggleChoice } from '@/lib/share-entry'
import { useSharedRoute } from '@/pages/shared'
import { type Account, LOCAL_ACCOUNT, useAccountStore } from '@/stores/account'
import { useJobsStore } from '@/stores/jobs'
import { useLibraryStore } from '@/stores/library'
import { useUiStore } from '@/stores/ui'

import { CONTENTS, ENTRY_NAME, entryFamily, memoryRepository } from './entry-family'

const GOOGLE: Account = { id: 'google-1', kind: 'google', name: 'Bia', email: 'bia@example.com', picture: '', token: { accessToken: 'at-1', expiresAt: Date.now() + 3600_000 } }
const SHARE_ID = 'FamiliaFamiliaFamilia1'
const MEDIA_URL = `https://share.test/media/${SHARE_ID}/e`
const SIZE = 1000

let sidecars: FileSidecar[]
let memory: ReturnType<typeof memoryRepository>
let replies: Record<string, () => Response>

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })
}

/** Ana's link: the entrada with its media and transcription, the Ata with its map; the Aula left out. */
async function anasLink(): Promise<SharedItem> {
  const metas = sidecars.map(sidecar => sidecar.meta)
  const open = async (id: string) => ({ content: CONTENTS[id] ?? '', sidecar: sidecars.find(sidecar => sidecar.meta.id === id)! })
  const tree = entryShareTree(metas, 'e')
  const content = await buildEntryShareContent('e', metas, open, choiceOf(tree, toggleChoice(tree, defaultChoice(tree, true), 'aula')))
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

/** The link as the Worker keeps it: a manifest, and each item as Markdown plus its sidecar. */
function serve(item: SharedItem) {
  const url = (path: string) => `GET https://files.test/shared/${item.id}/${encodeURIComponent(path)}`
  // like the Worker's safeName: a slash in the name never makes a folder
  const pathOf = (name: string) => name.replace(/[\\/]/g, '-')
  replies[url('share.json')] = () =>
    json({ version: 2, id: item.id, kind: item.kind, title: item.title, createdAt: item.createdAt, expiresAt: item.expiresAt, mediaExpiresAt: item.mediaExpiresAt, folders: [], files: item.files.map(file => ({ id: file.id, path: pathOf(file.name), ...(file.media ? { media: { key: `shared-media/${item.id}/${file.id}`, mime: file.media.mime, size: file.media.size } } : {}) })) })
  for (const file of item.files) {
    replies[url(`${pathOf(file.name)}.md`)] = () => new Response(file.content)
    const meta = { ...file.meta, id: file.id, name: file.name, folderId: file.folderId, type: file.type, position: file.position, description: file.description, tags: file.tags }
    replies[url(`${pathOf(file.name)}.json`)] = () => json({ meta, questions: file.questions, attempts: [], highlights: file.highlights, ...(file.transcript !== undefined ? { transcript: file.transcript } : {}), ...(file.recording ? { recording: file.recording } : {}), ...(file.artifacts ? { artifacts: file.artifacts } : {}) })
  }
}

function installBrowserFolder() {
  const written = new Map<string, BlobPart[]>()
  const handle = (name: string) => ({
    getFile: async () => ({ text: async () => (written.get(name) ?? []).map(String).join('') }),
    createWritable: async () => {
      const parts: BlobPart[] = []
      return { write: async (data: BlobPart) => void parts.push(data), close: async () => void written.set(name, parts) }
    },
  })
  Object.defineProperty(navigator, 'storage', { configurable: true, value: { getDirectory: async () => ({ getFileHandle: async (name: string) => handle(name), removeEntry: async () => undefined }) } })
}

beforeEach(() => {
  env.shareWorkerUrl = 'https://share.test'
  env.sharedFilesUrl = 'https://files.test'
  sidecars = entryFamily()
  replies = {}
  replies[`GET ${MEDIA_URL}`] = () => new Response(new Uint8Array(SIZE), { headers: { 'Content-Length': String(SIZE), 'Content-Type': 'video/mp4' } })
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string, init: RequestInit = {}) => replies[`${init.method ?? 'GET'} ${String(input)}`]?.() ?? new Response('not found', { status: 404 })),
  )
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => undefined)
  installBrowserFolder()
  // Bia's own library: one folder of hers, nothing of Ana's
  memory = memoryRepository()
  useAccountStore.setState({ accounts: [LOCAL_ACCOUNT], activeId: LOCAL_ACCOUNT.id, reconnectId: null })
  useLibraryStore.setState({ repo: memory.repo, accountId: 'local', ready: true, folders: [newFolderMeta({ id: 'trabalho', name: 'Trabalho da Bia' })], files: [], index: defaultIndex(), opened: {}, openedAt: {}, sizes: {}, localMedia: [], sharedView: null })
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
  return <div>{route.view === 'doc' ? `nota ${route.fileId}` : 'abrindo'}</div>
}

function Where() {
  return <div>{`aberto ${useLocation().pathname}`}</div>
}

function Confirm() {
  const overlay = useUiStore(state => state.overlay)
  return overlay?.kind === 'confirm' ? <ConfirmDialog overlay={overlay} /> : null
}

function renderLink(path = `/shared/${SHARE_ID}`) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/shared/:shareId" element={<SharedPage />} />
        <Route path="/shared/:shareId/arquivo/:fileId" element={<SharedPage />} />
        <Route path="/arquivo/:fileId" element={<Where />} />
      </Routes>
      <Confirm />
    </MemoryRouter>,
  )
}

describe('quem abre o link vê a mesma página da entrada, só leitura', () => {
  it('o original, a transcrição e a árvore só com o escolhido; "Importar…" no lugar de "Gerar desta entrada"', async () => {
    serve(await anasLink())
    renderLink()
    expect(await screen.findByRole('heading', { level: 1, name: ENTRY_NAME })).toBeInTheDocument()
    const original = screen.getByRole('region', { name: 'Original' })
    expect(within(original).getByRole('region', { name: 'Player da gravação' })).toBeInTheDocument()
    expect(await within(screen.getByRole('region', { name: 'Transcrição' })).findByText('Vamos fechar o portal novo até março.')).toBeInTheDocument()
    expect(within(screen.getByRole('region', { name: 'Transcrição' })).queryByRole('button', { name: /^Renomear/ })).not.toBeInTheDocument()
    expect(within(screen.getByRole('region', { name: 'Transcrição' })).queryByRole('button', { name: 'Refazer a transcrição' })).not.toBeInTheDocument()
    const family = screen.getByRole('region', { name: 'O que nasceu daqui' })
    expect(await within(family).findByRole('link', { name: 'Ata' })).toBeInTheDocument()
    expect(within(family).getByText('Portal novo')).toBeInTheDocument()
    expect(within(family).queryByText('Aula')).not.toBeInTheDocument()
    expect(within(family).queryByText('Cartões da reunião')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Importar para a minha biblioteca' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Gerar desta entrada' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Mais ações' })).not.toBeInTheDocument()
    expect(screen.queryByText('Reuniões da Ana')).not.toBeInTheDocument()
    expect(screen.queryByText('Biblioteca')).not.toBeInTheDocument()
  })

  it('a nota da árvore abre a leitura dela no link, e o endereço da entrada volta à página da entrada', async () => {
    serve(await anasLink())
    renderLink()
    fireEvent.click(await screen.findByRole('link', { name: 'Ata' }))
    expect(await screen.findByText('nota ata')).toBeInTheDocument()
  })

  it('sem nenhuma nota no link, a página diz que veio só a entrada, sem mandar gerar', async () => {
    const item = await anasLink()
    serve({ ...item, files: item.files.filter(file => file.id === 'e') })
    renderLink()
    const family = await screen.findByRole('region', { name: 'O que nasceu daqui' })
    expect(within(family).getByText('Nenhuma nota veio no link')).toBeInTheDocument()
    expect(within(family).getByText('Quem compartilhou mandou só a entrada.')).toBeInTheDocument()
    expect(within(family).queryByText(/Gere uma/)).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Gerar desta entrada' })).not.toBeInTheDocument()
  })

  it('o endereço da própria entrada no link abre a página dela', async () => {
    serve(await anasLink())
    renderLink(`/shared/${SHARE_ID}/arquivo/e`)
    expect(await screen.findByRole('heading', { level: 1, name: ENTRY_NAME })).toBeInTheDocument()
  })
})

describe('importar o link de uma entrada', () => {
  async function startImport() {
    serve(await anasLink())
    renderLink()
    fireEvent.click(await screen.findByRole('button', { name: 'Importar para a minha biblioteca' }))
    return screen.findByRole('dialog', { name: 'Importar para a minha biblioteca' })
  }

  const imported = () => {
    const files = useLibraryStore.getState().files
    const entry = files.find(file => file.role === 'entrada')!
    return { files, entry }
  }

  it('escolhe a pasta no seletor, com as pastas de quem importa; sem conta Google, a mídia fica neste navegador', async () => {
    const chooser = await startImport()
    fireEvent.click(within(chooser).getByRole('treeitem', { name: /Trabalho da Bia/ }))
    fireEvent.click(within(chooser).getByRole('button', { name: 'Importar aqui' }))
    await waitFor(() => expect(screen.getByText(/^aberto \/arquivo\//)).toBeInTheDocument())
    expect(screen.queryByText('Onde guardar a mídia?')).not.toBeInTheDocument()
    expect(useLibraryStore.getState().sharedView).toBeNull()
    const { files, entry } = imported()
    expect(screen.getByText(`aberto /arquivo/${entry.id}`)).toBeInTheDocument()
    expect(entry).toMatchObject({ name: ENTRY_NAME, folderId: 'trabalho', sharedFrom: SHARE_ID })
    expect(files.find(file => file.name === 'Ata')).toMatchObject({ parentFileId: entry.id, folderId: 'trabalho' })
    expect(files.map(file => file.name).sort()).toEqual([ENTRY_NAME, 'Ata'].sort())
    await waitFor(() => expect(useLibraryStore.getState().localMedia.map(media => media.fileIds)).toEqual([[entry.id]]))
    expect(memory.putSource).not.toHaveBeenCalled()
  })

  it('com conta Google, depois da pasta pergunta onde guardar a mídia; "No Google Drive" manda para o Drive', async () => {
    useAccountStore.setState({ accounts: [LOCAL_ACCOUNT, GOOGLE], activeId: GOOGLE.id })
    const chooser = await startImport()
    fireEvent.click(within(chooser).getByRole('button', { name: 'Importar aqui' }))
    expect(await screen.findByText('Onde guardar a mídia?')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Neste navegador' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'No Google Drive' }))
    await waitFor(() => expect(screen.getByText(/^aberto \/arquivo\//)).toBeInTheDocument())
    const { entry } = imported()
    expect(entry.folderId).toBeNull()
    expect(memory.putSource).toHaveBeenCalledWith(entry.id, expect.any(File), 'planejamento.mp4')
  })

  it('cria uma pasta no lugar, na biblioteca de quem importa, e a família vai para ela', async () => {
    const chooser = await startImport()
    fireEvent.change(within(chooser).getByRole('textbox', { name: 'Nome da pasta nova' }), { target: { value: 'Da família' } })
    fireEvent.click(within(chooser).getByRole('button', { name: 'Criar' }))
    expect(await within(chooser).findByRole('treeitem', { name: /Da família/, selected: true })).toBeInTheDocument()
    expect(memory.folders.size).toBe(1)
    fireEvent.click(within(chooser).getByRole('button', { name: 'Importar aqui' }))
    await waitFor(() => expect(screen.getByText(/^aberto \/arquivo\//)).toBeInTheDocument())
    const folder = useLibraryStore.getState().folders.find(item => item.name === 'Da família')!
    expect(folder).toBeDefined()
    expect(imported().entry.folderId).toBe(folder.id)
  })

  it('"Voltar" fecha o seletor e o link continua aberto, sem importar nada', async () => {
    const chooser = await startImport()
    fireEvent.click(within(chooser).getByRole('button', { name: 'Voltar' }))
    expect(screen.queryByRole('dialog', { name: 'Importar para a minha biblioteca' })).not.toBeInTheDocument()
    expect(useLibraryStore.getState().sharedView).not.toBeNull()
    expect(screen.getByRole('heading', { level: 1, name: ENTRY_NAME })).toBeInTheDocument()
  })
})
