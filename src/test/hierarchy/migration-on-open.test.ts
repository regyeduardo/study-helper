// Spec 005, história 2 (FR-013): na primeira abertura com sessão, a hierarquia de hoje vai sozinha para a conta, na janela que trava o
// app ("Levando a biblioteca para a sua conta"); no fim, aviso com a contagem, e a biblioteca passa a vir da hierarquia da conta.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import 'fake-indexeddb/auto'
import { waitFor } from '@testing-library/react'

const { mockEnv } = vi.hoisted(() => ({ mockEnv: { apiUrl: 'https://api.example.test' } }))
vi.mock('@/lib/env', async importOriginal => ({ env: { ...((await importOriginal()) as { env: object }).env, apiUrl: mockEnv.apiUrl } }))

import { newFileMeta, newFolderMeta, newSidecar } from '@/lib/defaults'
import { CombinedRepository } from '@/lib/storage/combined-repository'
import { DriveRepository } from '@/lib/storage/drive-repository'
import { LocalRepository } from '@/lib/storage/local-repository'
import { type Account, LOCAL_ACCOUNT, useAccountStore } from '@/stores/account'
import { useBlockingStore } from '@/stores/blocking'
import { useLibraryStore } from '@/stores/library'
import { useServerAccount } from '@/stores/server-account'
import { useUiStore } from '@/stores/ui'
import { API, FakeAppServer } from '@/test/storage/fake-app-server'
import { FakeDrive, installMemoryStorage, uniqueAccount } from '@/test/storage/fake-drive'

const token = vi.fn(async () => 'tok')
const library = () => useLibraryStore.getState()

let server: FakeAppServer
let account: string
let titles: string[]

function google(id: string): Account {
  return { id, kind: 'google', name: 'Ana', email: 'ana@example.com', picture: '', token: { accessToken: 'tok', expiresAt: Date.now() + 3600_000 } }
}

/** The library of today in the account's Drive: Faculdade with two notes. */
async function driveLibrary() {
  const repo = new CombinedRepository(new DriveRepository(account, token, 'drive'), new LocalRepository(`study-helper-local-${account}-antes`, account))
  await repo.load()
  const faculdade = newFolderMeta({ name: 'Faculdade' })
  await repo.saveFolder(faculdade)
  for (const name of ['Aula 1', 'Aula 2']) await repo.saveFile(newSidecar(newFileMeta({ name, type: 'class', folderId: faculdade.id })), name)
}

beforeEach(() => {
  installMemoryStorage()
  new FakeDrive().install()
  const driveFetch = globalThis.fetch
  server = new FakeAppServer()
  server.appEnabled = false
  server.signedIn = true
  vi.stubGlobal('fetch', (input: string | URL | Request, init?: RequestInit) => (String(input).startsWith(API) ? server.fetch(input, init) : driveFetch(input, init)))
  vi.stubGlobal('WebSocket', class { send() {} close() {} })
  account = uniqueAccount()
  titles = []
  useBlockingStore.setState({ ops: [] })
  useBlockingStore.subscribe(state => state.ops.forEach(op => titles.includes(op.title) || titles.push(op.title)))
  useUiStore.setState({ overlay: null, toasts: [] })
  useAccountStore.setState({ accounts: [LOCAL_ACCOUNT, google(account)], activeId: account, reconnectId: null })
  useServerAccount.setState({ me: null, status: 'unknown' })
})

afterEach(() => {
  vi.unstubAllGlobals()
  useAccountStore.setState({ activeId: LOCAL_ACCOUNT.id })
  useServerAccount.setState({ me: null, status: 'unknown' })
})

describe('migração ao abrir', () => {
  it('leva a hierarquia de hoje para a conta, avisa a contagem e a biblioteca passa a vir da conta', async () => {
    await driveLibrary()
    await library().connect(account, token)
    await waitFor(() => expect(server.hierarchyAt).toBeTruthy())
    expect(titles).toContain('Levando a biblioteca para a sua conta')
    await waitFor(() => expect((library().repo as CombinedRepository).hierarchy).toBeTruthy())
    await waitFor(() => expect(useUiStore.getState().toasts.map(toast => toast.text)).toContain('Pronto: 1 pasta e 2 notas na sua conta. Nada mudou de lugar.'))
    expect(library().files.map(file => file.name).sort()).toEqual(['Aula 1', 'Aula 2'])
    expect(library().folders.map(folder => folder.name)).toEqual(['Faculdade'])
  })

  it('servidor que ainda não conhece a hierarquia (sem o campo) não migra nada', async () => {
    server.hierarchyAt = undefined as unknown as null
    await library().connect(account, token)
    await waitFor(() => expect(useServerAccount.getState().status).toBe('signed-in'))
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(server.backup).toBeFalsy()
    expect(titles).not.toContain('Levando a biblioteca para a sua conta')
  })

  it('sem conta (perfil Local), nada vai para o servidor', async () => {
    useAccountStore.setState({ activeId: LOCAL_ACCOUNT.id })
    await library().connect(LOCAL_ACCOUNT.id)
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(server.backup).toBeFalsy()
  })
})
