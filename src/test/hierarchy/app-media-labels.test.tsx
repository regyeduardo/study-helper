// 24/11/2026 (dono: "Erro grave"): com a estrutura do app ligada (e a hierarquia já na conta, spec 005), a nota nasce no App e a mídia
// vai junto com ela. Toda janela que guarda ou mostra uma mídia diz onde ela vai ou está de verdade: "App" no App, "Google Drive" no Drive.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import 'fake-indexeddb/auto'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

const { mockEnv } = vi.hoisted(() => ({ mockEnv: { apiUrl: 'https://api.example.test' } }))
vi.mock('@/lib/env', async importOriginal => ({ env: { ...((await importOriginal()) as { env: object }).env, apiUrl: mockEnv.apiUrl } }))
vi.mock('@/routes', () => ({ router: { navigate: vi.fn() } }))
// jsdom has no browser folder: Mídias is a list in the store
vi.mock('@/lib/recording/media-library', async importOriginal => ({
  ...(await importOriginal<typeof import('@/lib/recording/media-library')>()),
  listLocalMedia: vi.fn(async () => []),
  readLocalMedia: vi.fn(),
  linkLocalMedia: vi.fn(async (storedName: string, fileId: string) => {
    const { useLibraryStore } = await import('@/stores/library')
    useLibraryStore.setState(state => ({ localMedia: state.localMedia.map(item => (item.storedName === storedName ? { ...item, fileIds: [...item.fileIds, fileId] } : item)) }))
  }),
}))

import type { ServerMe } from '@/controllers/api.controller'
import { MediaDialog } from '@/components/dialogs/MediaDialog'
import { NewContentDialog } from '@/components/dialogs/NewContentDialog'
import { SaveToDrive } from '@/components/library/SaveToDrive'
import { SharedBadge } from '@/components/library/SharedBadge'
import { NoteParts } from '@/components/reader/Details'
import { WelcomeEmpty } from '@/pages/workspace/container/shared'
import { type LocalMedia, readLocalMedia } from '@/lib/recording/media-library'
import { CombinedRepository } from '@/lib/storage/combined-repository'
import { storeSource } from '@/lib/storage/source-storage'
import { type Account, LOCAL_ACCOUNT, useAccountStore } from '@/stores/account'
import { useBlockingStore } from '@/stores/blocking'
import { useJobsStore } from '@/stores/jobs'
import { useLibraryStore } from '@/stores/library'
import { usePlacesStore } from '@/stores/places'
import { useServerAccount } from '@/stores/server-account'
import { useUiStore } from '@/stores/ui'
import type { SharedItem, SourceMeta } from '@/types/domain'
import { FakeAppServer } from '@/test/storage/fake-app-server'
import { FakeDrive, installMemoryStorage, uniqueAccount } from '@/test/storage/fake-drive'
import { installBlobShim } from '@/test/imports/blob-shim'

// Novo conteúdo reads the start of the picked file
installBlobShim()

const token = vi.fn(async () => 'tok')
const library = () => useLibraryStore.getState()
const repo = () => library().repo as CombinedRepository
const originOf = (id: string) => library().files.find(file => file.id === id)?.origin

const BLOB = new File(['som da reunião'], 'reuniao.webm', { type: 'video/webm' })
const SHARED_MEDIA = 'https://share.test/media/LinkLinkLinkLinkLink1/n1'

function google(id: string): Account {
  return { id, kind: 'google', name: 'Ana', email: 'ana@example.com', picture: '', token: { accessToken: 'at-1', expiresAt: Date.now() + 3600_000 } }
}

const freed: ServerMe = {
  user: { id: 'u1', email: 'ana@example.com', name: 'Ana', photoUrl: null, status: 'enabled', appEnabled: true, admin: false, deleteAt: null, hasPassword: false, hasGoogle: true, hierarchyAt: '2026-11-23T12:00:00Z' },
  requireCode: true,
  device: { id: 'd1', name: 'Chrome no Linux' },
  space: { notes: 0, media: 0, reserved: 0, limit: 10 * 1024 ** 3, warnAt: 0.9 },
}

/** A note of the App with its video kept in the App, the way a recording of the App is. */
async function appVideo() {
  const origin: SourceMeta = { input: 'recording', name: BLOB.name, mime: 'video/webm', sizeBytes: BLOB.size, durationSeconds: 60, storage: 'none' }
  const note = await library().createFile({ name: 'Reunião no App', type: 'video', kept: 'arquivo', folderId: null, origin }, '')
  const stored = await storeSource(BLOB, 'drive', note.id, repo(), '72h')
  await library().updateFile(note.id, { origin: { ...origin, ...stored } })
  expect(originOf(note.id)?.storedFileId).toMatch(/^app:/)
  return library().files.find(file => file.id === note.id)!
}

let account: string

/** The same account before its hierarchy went to the account (spec 005): the library as it was, the structure on. */
async function beforeMigration() {
  useServerAccount.setState({ me: { ...freed, user: { ...freed.user, hierarchyAt: null } }, status: 'signed-in' })
  await library().connect(account, token)
  expect(repo().hierarchy).toBeFalsy()
  expect(library().appOn).toBe(true)
}

beforeEach(async () => {
  installMemoryStorage()
  new FakeDrive().install()
  const driveFetch = globalThis.fetch
  const server = new FakeAppServer()
  server.hierarchyAt = '2026-11-23T12:00:00Z'
  vi.stubGlobal('fetch', (input: string | URL | Request, init?: RequestInit) => {
    if (String(input) === SHARED_MEDIA) return Promise.resolve(new Response(BLOB, { headers: { 'Content-Type': 'video/webm', 'Content-Length': String(BLOB.size) } }))
    return String(input).startsWith(mockEnv.apiUrl) ? server.fetch(input, init) : driveFetch(input, init)
  })
  vi.stubGlobal('WebSocket', class { send() {} close() {} })
  vi.mocked(readLocalMedia).mockResolvedValue(BLOB)
  account = uniqueAccount()
  useUiStore.setState({ overlay: null, toasts: [] })
  usePlacesStore.setState({ running: false, progress: null, failed: [] })
  useBlockingStore.setState({ ops: [] })
  useAccountStore.setState({ accounts: [LOCAL_ACCOUNT, google(account)], activeId: account, reconnectId: null })
  useServerAccount.setState({ me: freed, status: 'signed-in' })
  await library().connect(account, token)
  expect(library().appOn).toBe(true)
  expect(repo().hierarchy).toBeTruthy()
})

afterEach(() => {
  library().leaveShared()
  vi.unstubAllGlobals()
  useAccountStore.setState({ activeId: LOCAL_ACCOUNT.id })
  useServerAccount.setState({ me: null, status: 'unknown' })
})

/** A link of someone else: one video note, with its media in the link. */
function sharedFile(): SharedItem {
  return {
    version: 2,
    id: 'LinkLinkLinkLinkLink1',
    kind: 'file',
    title: 'Reunião da Bia',
    createdAt: '2026-11-24T10:00:00.000Z',
    expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    folders: [],
    files: [{ id: 'n1', name: 'Reunião da Bia', folderId: null, type: 'video', position: 0, description: '', tags: [], content: '', questions: [], highlights: [], media: { url: SHARED_MEDIA, mime: 'video/webm', size: BLOB.size }, meta: { origin: { input: 'recording', name: BLOB.name, mime: 'video/webm', storage: 'none' } } }],
  }
}

describe('importar um link com mídia, com a estrutura ligada', () => {
  it('a janela oferece o App, não o Google Drive, e a mídia fica mesmo no App', async () => {
    library().enterShared(sharedFile(), {})
    render(
      <MemoryRouter>
        <SharedBadge button />
      </MemoryRouter>,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Importar para a minha biblioteca' }))
    const dialog = await screen.findByRole('alertdialog', { name: 'Onde guardar a mídia?' })
    expect(within(dialog).queryByRole('button', { name: 'No Google Drive' })).toBeNull()
    expect(within(dialog).getByText(/No App ela fica na sua conta/)).toBeInTheDocument()
    fireEvent.click(within(dialog).getByRole('button', { name: 'No App' }))
    await waitFor(() => expect(library().files.find(file => file.name === 'Reunião da Bia')?.origin?.storedFileId).toMatch(/^app:/))
  })

  it('antes de a hierarquia ir para a conta também: a nota nasce no App, e a janela diz App', async () => {
    await beforeMigration()
    library().enterShared(sharedFile(), {})
    render(
      <MemoryRouter>
        <SharedBadge button />
      </MemoryRouter>,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Importar para a minha biblioteca' }))
    const dialog = await screen.findByRole('alertdialog', { name: 'Onde guardar a mídia?' })
    expect(within(dialog).queryByRole('button', { name: 'No Google Drive' })).toBeNull()
    fireEvent.click(within(dialog).getByRole('button', { name: 'No App' }))
    await waitFor(() => expect(library().files.find(file => file.name === 'Reunião da Bia')?.origin?.storedFileId).toMatch(/^app:/))
  })
})

describe('nota nova, com a estrutura ligada (dono, 24/11: "Então corrija")', () => {
  it('antes de a hierarquia ir para a conta, a nota nova nasce no App, também numa pasta do Drive, e continua lá ao abrir de novo', async () => {
    await beforeMigration()
    const folder = await library().createFolder({ name: 'Faculdade' })
    const solta = await library().createFile({ name: 'Solta', type: 'class', folderId: null }, 'texto solto')
    const naPasta = await library().createFile({ name: 'Na pasta', type: 'class', folderId: folder.id }, 'texto da pasta')
    expect(repo().sideOf(solta.id)).toBe('app')
    expect(repo().sideOf(naPasta.id)).toBe('app')
    const again = await repo().load()
    expect(again.files.find(file => file.id === naPasta.id)).toMatchObject({ folderId: folder.id })
    expect(repo().sideOf(naPasta.id)).toBe('app')
    expect(await repo().readContent(naPasta.id)).toBe('texto da pasta')
  })

  it('a nota com lugar escolhido nasce nele: "Google Drive" é Google Drive', async () => {
    await beforeMigration()
    const drive = await library().createFile({ name: 'No Drive', type: 'class', folderId: null, place: 'drive' }, 'texto')
    expect(repo().sideOf(drive.id)).toBe('drive')
  })

  it('gravação salva escolhendo "Google Drive" vai para o Google Drive, com a mídia, e não para o App', async () => {
    const id = await useJobsStore.getState().saveRecording({ file: BLOB, storedName: null, durationSeconds: 60, folderId: null, storage: 'drive', place: 'drive', litterboxTime: '72h', marks: [], transcribe: false })
    expect(repo().sideOf(id)).toBe('drive')
    await waitFor(() => expect(originOf(id)?.storedFileId).toBeTruthy())
    expect(originOf(id)?.storedFileId).not.toMatch(/^app:/)
  })

  it('gravação salva escolhendo "App" vai para o App', async () => {
    const id = await useJobsStore.getState().saveRecording({ file: BLOB, storedName: null, durationSeconds: 60, folderId: null, storage: 'drive', place: 'app', litterboxTime: '72h', marks: [], transcribe: false })
    expect(repo().sideOf(id)).toBe('app')
    await waitFor(() => expect(originOf(id)?.storedFileId).toMatch(/^app:/))
  })
})

describe('Mídias neste computador, com a estrutura ligada', () => {
  it('uma mídia solta diz "Salvar no App" e vai mesmo para o App', async () => {
    const media: LocalMedia = { storedName: 'solta.webm', name: BLOB.name, mime: 'video/webm', durationSeconds: 60, size: BLOB.size, createdAt: '2026-11-24T10:00:00.000Z', fileIds: [] }
    useLibraryStore.setState({ localMedia: [media] })
    render(<SaveToDrive media={media} />)
    expect(screen.queryByRole('button', { name: /Salvar no meu Drive/ })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /Salvar no App/ }))
    const dialog = await screen.findByRole('dialog', { name: 'Salvar no App?' })
    expect(within(dialog).getByText(/Para ir ao App/)).toBeInTheDocument()
    fireEvent.click(within(dialog).getByRole('button', { name: 'Salvar no App' }))
    await waitFor(() => expect(library().files.find(file => file.name === 'reuniao')?.origin?.storedFileId).toMatch(/^app:/))
  })

  it('a mídia guardada no App aparece como "No App", não como Google Drive', async () => {
    await appVideo()
    render(
      <MemoryRouter>
        <MediaDialog />
      </MemoryRouter>,
    )
    expect(await screen.findByText('Só no App')).toBeInTheDocument()
    expect(screen.getByText('No App')).toBeInTheDocument()
    expect(screen.queryByText('Só no Google Drive')).toBeNull()
    expect(screen.queryByText('No Google Drive')).toBeNull()
  })
})

describe('outros lugares que dizem onde a mídia está', () => {
  it('Novo conteúdo: o arquivo guardado com a nota vai para o App, e a janela diz App (sem pedir o Google Drive)', async () => {
    render(
      <MemoryRouter>
        <NewContentDialog />
      </MemoryRouter>,
    )
    fireEvent.click(screen.getByRole('button', { name: /Arquivo/ }))
    fireEvent.change(document.getElementById('nc-file') as HTMLInputElement, { target: { files: [new File(['notas'], 'notas.txt', { type: 'text/plain' })] } })
    const where = within(await screen.findByRole('radiogroup', { name: 'Onde guardar o arquivo' }))
    const options = where.getAllByRole('radio').map(radio => radio.querySelector('b')!.textContent)
    expect(options).toEqual(['App'])
    expect(where.getByRole('radio', { name: /^App/ })).toHaveAttribute('aria-checked', 'true')
    expect(screen.queryByText(/Google Drive/)).toBeNull()
  })

  it('as partes da nota dizem que a mídia está no App', async () => {
    const note = await appVideo()
    render(<NoteParts meta={note} />)
    expect(screen.getByText(/App/)).toBeInTheDocument()
    expect(screen.queryByText(/Google Drive/)).toBeNull()
  })

  it('a biblioteca vazia diz que tudo vai para o App', () => {
    render(<WelcomeEmpty />)
    expect(screen.getByText(/vai para o App/)).toBeInTheDocument()
    expect(screen.queryByText(/Google Drive/)).toBeNull()
  })
})
