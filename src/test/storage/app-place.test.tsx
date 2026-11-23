// Entrega 4 (spec 003, história 2): o App vira um lugar da biblioteca só para a conta liberada com "Usar a estrutura do app" ligada.
// Sem isso, nada muda para quem usa Google Drive e Local.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import 'fake-indexeddb/auto'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

const { mockEnv } = vi.hoisted(() => ({ mockEnv: { apiUrl: 'https://api.example.test' } }))
vi.mock('@/lib/env', async importOriginal => ({ env: { ...((await importOriginal()) as { env: object }).env, apiUrl: mockEnv.apiUrl } }))

import type { ServerMe } from '@/controllers/api.controller'
import { PlacesPanel } from '@/components/dialogs/PlacesPanel'
import { CombinedRepository } from '@/lib/storage/combined-repository'
import { type Account, LOCAL_ACCOUNT, useAccountStore } from '@/stores/account'
import { useLibraryStore } from '@/stores/library'
import { usePlacesStore } from '@/stores/places'
import { useServerAccount } from '@/stores/server-account'
import { useUiStore } from '@/stores/ui'
import { FakeAppServer } from '@/test/storage/fake-app-server'
import { FakeDrive, installMemoryStorage, uniqueAccount } from '@/test/storage/fake-drive'

const token = vi.fn(async () => 'tok')
const library = () => useLibraryStore.getState()

let account: string
let drive: FakeDrive
let server: FakeAppServer

function google(id: string): Account {
  return { id, kind: 'google', name: 'Ana', email: 'ana@example.com', picture: '', token: { accessToken: 'at-1', expiresAt: Date.now() + 3600_000 } }
}

const freed = (appEnabled: boolean): ServerMe => ({
  user: { id: 'u1', email: 'ana@example.com', name: 'Ana', photoUrl: null, status: 'enabled', appEnabled, admin: false, deleteAt: null, hasPassword: false, hasGoogle: true },
  requireCode: true,
  device: { id: 'd1', name: 'Chrome no Linux' },
  space: { notes: 0, media: 0, reserved: 0, limit: 10 * 1024 ** 3, warnAt: 0.9 },
})

const driveNames = () => [...drive.files.values()].map(file => file.name)
const appNames = () => [...server.rows.values()].filter(row => !row.removedAt).map(row => (row.meta as { name?: string }).name)

beforeEach(() => {
  installMemoryStorage()
  drive = new FakeDrive().install()
  const driveFetch = globalThis.fetch
  server = new FakeAppServer()
  vi.stubGlobal('fetch', (input: string | URL | Request, init?: RequestInit) => (String(input).startsWith(mockEnv.apiUrl) ? server.fetch(input, init) : driveFetch(input, init)))
  // the live channel stays quiet here (app-live.test.ts covers it)
  vi.stubGlobal('WebSocket', class { send() {} close() {} })
  account = uniqueAccount()
  useUiStore.setState({ overlay: null, toasts: [] })
  usePlacesStore.setState({ running: false, progress: null, failed: [] })
  useAccountStore.setState({ accounts: [LOCAL_ACCOUNT, google(account)], activeId: account, reconnectId: null })
  useServerAccount.setState({ me: null, status: 'signed-out' })
})

afterEach(() => {
  vi.unstubAllGlobals()
  useAccountStore.setState({ activeId: LOCAL_ACCOUNT.id })
  useServerAccount.setState({ me: null, status: 'unknown' })
})

/** Locais (spec 005, opção E): with every note marked, the bar's "Levar para o App". */
const appButton = () => {
  fireEvent.click(screen.getByRole('checkbox', { name: 'Marcar tudo' }))
  return within(screen.getByRole('toolbar', { name: 'Notas marcadas' })).getByRole('button', { name: /^Levar para o App/ })
}

describe('o App como lugar', () => {
  it('sem a estrutura do app ligada, o App fica desligado e nada vai para lá', async () => {
    await library().connect(account, token)
    expect(library().appOn).toBe(false)
    const folder = await library().createFolder({ name: 'Faculdade' })
    await library().createFile({ name: 'Lista', type: 'class', folderId: folder.id }, 'questão')
    render(<MemoryRouter><PlacesPanel /></MemoryRouter>)
    const app = appButton()
    expect(app).toBeDisabled()
    expect(app).toHaveAccessibleName('Levar para o App (liberar com um código)')
    expect(server.calls).toEqual([])
    expect(driveNames().some(name => name.includes('Faculdade'))).toBe(true)
  })

  it('com a estrutura ligada, mover uma pasta para o App leva ela e as notas, e tira do Drive', async () => {
    useServerAccount.setState({ me: freed(true), status: 'signed-in' })
    await library().connect(account, token)
    expect(library().appOn).toBe(true)
    const faculdade = await library().createFolder({ name: 'Faculdade' })
    const lista = await library().createFile({ name: 'Lista de exercícios 3', type: 'class', folderId: faculdade.id }, 'questão 1')
    expect(appNames()).toEqual([])

    render(<MemoryRouter><PlacesPanel /></MemoryRouter>)
    const app = appButton()
    expect(app).toBeEnabled()
    expect(app).toHaveAccessibleName('Levar para o App')

    await usePlacesStore.getState().choosePlace([faculdade.id], 'app')
    expect(usePlacesStore.getState().failed.map(record => `${record.name}: ${record.reason}`)).toEqual([])
    expect(appNames().sort()).toEqual(['Faculdade', 'Lista de exercícios 3'])
    expect(driveNames().some(name => name.includes('Lista de exercícios 3'))).toBe(false)
    const repo = library().repo as CombinedRepository
    expect(repo.sideOf(lista.id)).toBe('app')
    expect(await repo.readContent(lista.id)).toBe('questão 1')
    expect(library().files.map(file => file.name)).toContain('Lista de exercícios 3')

    // a new note in a folder kept in the App goes to the App
    await library().createFile({ name: 'Lista 4', type: 'class', folderId: faculdade.id }, 'questão 2')
    expect(appNames()).toContain('Lista 4')
    expect(driveNames().some(name => name.includes('Lista 4'))).toBe(false)
  })

  it('a conta liberada depois de abrir a biblioteca: o App liga sozinho, e desliga também', async () => {
    await library().connect(account, token)
    expect(library().appOn).toBe(false)
    useServerAccount.setState({ me: freed(true), status: 'signed-in' })
    await waitFor(() => expect(library().appOn).toBe(true))
    expect((library().repo as CombinedRepository).app).not.toBeNull()
    useServerAccount.setState({ me: freed(false), status: 'signed-in' })
    await waitFor(() => expect(library().appOn).toBe(false))
    expect((library().repo as CombinedRepository).app).toBeNull()
  })
})
