// Spec 005 (FR-002, FR-003, R4): toda conta Google abre a sessão no servidor sozinha ao conectar, com o token que o app já tem, sem
// código e sem tela nova; a biblioteca não espera por isso. Sem conta (perfil Local), nada vai ao servidor.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import 'fake-indexeddb/auto'
import { waitFor } from '@testing-library/react'

const { mockEnv } = vi.hoisted(() => ({ mockEnv: { apiUrl: 'https://api.example.test' } }))
vi.mock('@/lib/env', async importOriginal => {
  const real = ((await importOriginal()) as { env: Record<string, unknown> }).env
  return {
    env: {
      ...real,
      get apiUrl() {
        return mockEnv.apiUrl
      },
    },
  }
})

import { type Account, LOCAL_ACCOUNT, useAccountStore } from '@/stores/account'
import { useLibraryStore } from '@/stores/library'
import { useServerAccount } from '@/stores/server-account'
import { API, FakeAppServer } from '@/test/storage/fake-app-server'
import { FakeDrive, installMemoryStorage, uniqueAccount } from '@/test/storage/fake-drive'

const token = vi.fn(async () => 'token-da-ana')
const library = () => useLibraryStore.getState()

let account: string
let server: FakeAppServer
let toServer: string[]

function google(id: string): Account {
  return { id, kind: 'google', name: 'Ana', email: 'ana@example.com', picture: '', token: { accessToken: 'token-da-ana', expiresAt: Date.now() + 3600_000 } }
}

beforeEach(() => {
  installMemoryStorage()
  new FakeDrive().install()
  const driveFetch = globalThis.fetch
  server = new FakeAppServer()
  server.signedIn = false
  server.acceptGoogle = true
  toServer = []
  vi.stubGlobal('fetch', (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    if (url.startsWith(API)) return server.fetch(input, init)
    if (url.includes('/v1/')) toServer.push(url)
    return driveFetch(input, init)
  })
  vi.stubGlobal('WebSocket', class { send() {} close() {} })
  mockEnv.apiUrl = API
  account = uniqueAccount()
  useAccountStore.setState({ accounts: [LOCAL_ACCOUNT, google(account)], activeId: account, reconnectId: null })
  useServerAccount.setState({ me: null, status: 'unknown' })
})

afterEach(() => {
  vi.unstubAllGlobals()
  useAccountStore.setState({ activeId: LOCAL_ACCOUNT.id })
  useServerAccount.setState({ me: null, status: 'unknown' })
})

describe('sessão no servidor ao conectar', () => {
  it('conta Google abre a sessão sozinha, com o token que o app já tem, sem pedir código', async () => {
    await library().connect(account, token)
    expect(library().ready).toBe(true)
    await waitFor(() => expect(useServerAccount.getState().status).toBe('signed-in'))
    expect(server.googleTokens).toEqual(['token-da-ana'])
    expect(server.calls.some(call => call.path === '/v1/code/use')).toBe(false)
  })

  it('já com sessão no servidor, não abre outra', async () => {
    server.signedIn = true
    await library().connect(account, token)
    await waitFor(() => expect(useServerAccount.getState().status).toBe('signed-in'))
    expect(server.googleTokens).toEqual([])
  })

  it('servidor fora do ar não impede a biblioteca de abrir', async () => {
    server.offline = true
    await library().connect(account, token)
    expect(library().ready).toBe(true)
    expect(library().loadError).toBeNull()
    await waitFor(() => expect(useServerAccount.getState().status).toBe('offline'))
    expect(server.googleTokens).toEqual([])
  })

  it('sem conta (perfil Local), nada vai ao servidor', async () => {
    useAccountStore.setState({ activeId: LOCAL_ACCOUNT.id })
    await library().connect(LOCAL_ACCOUNT.id)
    await library().createFolder({ name: 'Rascunhos' })
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(server.calls).toEqual([])
    expect(useServerAccount.getState().status).toBe('unknown')
  })

  it('sem servidor configurado, não chama nada', async () => {
    mockEnv.apiUrl = ''
    await library().connect(account, token)
    expect(library().ready).toBe(true)
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(server.calls).toEqual([])
    expect(toServer).toEqual([])
  })
})
