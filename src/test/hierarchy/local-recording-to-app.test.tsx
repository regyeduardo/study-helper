// 23/11/2026 (dono: "Olha que situação tosca"): uma gravação só neste navegador, com a estrutura do app ligada.
// Levar para o App leva a nota e a mídia; a página da nota oferece "Salvar no App", não só o Drive.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import 'fake-indexeddb/auto'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'

const { mockEnv } = vi.hoisted(() => ({ mockEnv: { apiUrl: 'https://api.example.test' } }))
vi.mock('@/lib/env', async importOriginal => ({ env: { ...((await importOriginal()) as { env: object }).env, apiUrl: mockEnv.apiUrl } }))
vi.mock('@/routes', () => ({ router: { navigate: vi.fn() } }))
// jsdom has no browser folder: the copy in Mídias is a tiny file
vi.mock('@/lib/recording/media-library', async importOriginal => ({
  ...(await importOriginal<typeof import('@/lib/recording/media-library')>()),
  listLocalMedia: vi.fn(async () => []),
  readLocalMedia: vi.fn(),
}))

import type { ServerMe } from '@/controllers/api.controller'
import { SaveToDrive } from '@/components/library/SaveToDrive'
import { SyncLocalBanner, SyncLocalDialog } from '@/components/library/SyncLocal'
import { type LocalMedia, listLocalMedia, readLocalMedia } from '@/lib/recording/media-library'
import { CombinedRepository } from '@/lib/storage/combined-repository'
import { type Account, LOCAL_ACCOUNT, useAccountStore } from '@/stores/account'
import { useBlockingStore } from '@/stores/blocking'
import { useLibraryStore } from '@/stores/library'
import { usePlacesStore } from '@/stores/places'
import { useServerAccount } from '@/stores/server-account'
import { useUiStore } from '@/stores/ui'
import type { SourceMeta } from '@/types/domain'
import { FakeAppServer } from '@/test/storage/fake-app-server'
import { FakeDrive, installMemoryStorage, uniqueAccount } from '@/test/storage/fake-drive'

const token = vi.fn(async () => 'tok')
const library = () => useLibraryStore.getState()
const repo = () => library().repo as CombinedRepository
const originOf = (id: string) => library().files.find(file => file.id === id)?.origin

const BLOB = new File(['som da reunião'], 'Reunião 23-11-2026, 17-51-57.webm', { type: 'video/webm' })
const RECORDED: SourceMeta = { input: 'recording', name: BLOB.name, mime: 'video/webm', durationSeconds: 3707, sizeBytes: BLOB.size, storage: 'none' }

function google(id: string): Account {
  return { id, kind: 'google', name: 'Ana', email: 'ana@example.com', picture: '', token: { accessToken: 'at-1', expiresAt: Date.now() + 3600_000 } }
}

const freed: ServerMe = {
  user: { id: 'u1', email: 'ana@example.com', name: 'Ana', photoUrl: null, status: 'enabled', appEnabled: true, admin: false, deleteAt: null, hasPassword: false, hasGoogle: true },
  requireCode: true,
  device: { id: 'd1', name: 'Chrome no Linux' },
  space: { notes: 0, media: 0, reserved: 0, limit: 10 * 1024 ** 3, warnAt: 0.9 },
}

/** The recording of 23/11: a video note kept in this browser, its media in Mídias. */
async function localRecording() {
  const note = await library().createFile({ name: 'Reunião 23-11-2026, 17-51-57', type: 'video', kept: 'arquivo', folderId: null, place: 'local', origin: RECORDED }, '')
  const media: LocalMedia = { storedName: 'gravacao-1.webm', name: BLOB.name, mime: 'video/webm', durationSeconds: 3707, size: BLOB.size, createdAt: '2026-11-23T20:51:57.000Z', fileIds: [note.id] }
  useLibraryStore.setState({ localMedia: [media] })
  vi.mocked(listLocalMedia).mockResolvedValue([media])
  expect(repo().sideOf(note.id)).toBe('local')
  return note
}

beforeEach(async () => {
  installMemoryStorage()
  new FakeDrive().install()
  const driveFetch = globalThis.fetch
  const server = new FakeAppServer()
  vi.stubGlobal('fetch', (input: string | URL | Request, init?: RequestInit) => (String(input).startsWith(mockEnv.apiUrl) ? server.fetch(input, init) : driveFetch(input, init)))
  vi.stubGlobal('WebSocket', class { send() {} close() {} })
  vi.mocked(readLocalMedia).mockResolvedValue(BLOB)
  const account = uniqueAccount()
  useUiStore.setState({ overlay: null, toasts: [] })
  usePlacesStore.setState({ running: false, progress: null, failed: [] })
  useBlockingStore.setState({ ops: [] })
  useAccountStore.setState({ accounts: [LOCAL_ACCOUNT, google(account)], activeId: account, reconnectId: null })
  useServerAccount.setState({ me: freed, status: 'signed-in' })
  await library().connect(account, token)
})

afterEach(() => {
  vi.unstubAllGlobals()
  useAccountStore.setState({ activeId: LOCAL_ACCOUNT.id })
  useServerAccount.setState({ me: null, status: 'unknown' })
})

describe('Gravação só neste navegador, com a estrutura do app ligada', () => {
  it('levar para o App leva a nota e a mídia', async () => {
    const note = await localRecording()
    await usePlacesStore.getState().choosePlace([note.id], 'app')
    expect(repo().sideOf(note.id)).toBe('app')
    await waitFor(() => expect(originOf(note.id)?.storedFileId).toMatch(/^app:/))
  })

  it('a página da nota oferece "Salvar no App", que leva a nota e a mídia para o App', async () => {
    const note = await localRecording()
    render(<SaveToDrive fileId={note.id} />)
    expect(screen.queryByRole('button', { name: /Salvar no meu Drive/ })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /Salvar no App/ }))
    const dialog = await screen.findByRole('dialog', { name: 'Salvar no App?' })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Salvar no App' }))
    await waitFor(() => expect(repo().sideOf(note.id)).toBe('app'))
    await waitFor(() => expect(originOf(note.id)?.storedFileId).toMatch(/^app:/))
  })

  // US5/AC6 (T142): ao abrir o app neste navegador com a estrutura ligada, a faixa "Sincronizar" leva cada mídia daqui para a sua nota no App
  it('"Sincronizar" oferece o App, já marcado, e leva a nota e a mídia para o App', async () => {
    const note = await localRecording()
    render(<SyncLocalBanner />)
    fireEvent.click(screen.getByRole('button', { name: 'Sincronizar' }))
    expect(useUiStore.getState().overlay).toMatchObject({ kind: 'sync-local' })
    render(<SyncLocalDialog />)
    const dialog = screen.getByRole('dialog', { name: 'Sincronizar' })
    const app = within(dialog).getByRole('radio', { name: /^App/ })
    expect(app).toBeEnabled()
    expect(app).toBeChecked()
    expect(within(dialog).getByText(/para o App\. Cada item só sai deste navegador/)).toBeInTheDocument()
    fireEvent.click(within(dialog).getByRole('button', { name: 'Sincronizar 1 nota' }))
    await waitFor(() => expect(repo().sideOf(note.id)).toBe('app'))
    await waitFor(() => expect(originOf(note.id)?.storedFileId).toMatch(/^app:/))
    expect(await within(dialog).findByText('Pronto: 1 nota no App.')).toBeInTheDocument()
  })

  it('"Sincronizar" ainda deixa escolher o Google Drive', async () => {
    const note = await localRecording()
    render(<SyncLocalDialog />)
    const dialog = screen.getByRole('dialog', { name: 'Sincronizar' })
    fireEvent.click(within(dialog).getByRole('radio', { name: /^Google Drive/ }))
    fireEvent.click(within(dialog).getByRole('button', { name: 'Sincronizar 1 nota' }))
    await waitFor(() => expect(repo().sideOf(note.id)).toBe('drive'))
  })
})
