// Spec 005, FR-011 (escolha C do dono, 23/11): a linha no pé da lateral diz o estado da hierarquia na conta: "Tudo na conta" com a fila
// vazia; "N mudanças esperando conexão" sem conexão com a conta; "Enviando N mudanças…" enquanto sobem. Sem a hierarquia, como hoje.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import 'fake-indexeddb/auto'
import { render, screen, waitFor } from '@testing-library/react'

const { mockEnv } = vi.hoisted(() => ({ mockEnv: { apiUrl: 'https://api.example.test' } }))
vi.mock('@/lib/env', async importOriginal => ({ env: { ...((await importOriginal()) as { env: object }).env, apiUrl: mockEnv.apiUrl } }))

import type { ServerMe } from '@/controllers/api.controller'
import { SyncPill } from '@/components/layout/Chrome'
import { type Account, LOCAL_ACCOUNT, useAccountStore } from '@/stores/account'
import { useLibraryStore } from '@/stores/library'
import { useServerAccount } from '@/stores/server-account'
import { useSyncStore } from '@/stores/sync'
import { API, FakeAppServer } from '@/test/storage/fake-app-server'
import { FakeDrive, installMemoryStorage, uniqueAccount } from '@/test/storage/fake-drive'

const token = vi.fn(async () => 'tok')
const library = () => useLibraryStore.getState()

let server: FakeAppServer
let account: string
let offline: boolean

const google = (id: string): Account => ({ id, kind: 'google', name: 'Ana', email: 'ana@example.com', picture: '', token: { accessToken: 'tok', expiresAt: Date.now() + 3600_000 } })
const me = (): ServerMe => ({
  user: { id: 'u1', email: 'ana@example.com', name: 'Ana', photoUrl: null, status: 'no-code', appEnabled: false, admin: false, deleteAt: null, hasPassword: false, hasGoogle: true, hierarchyAt: '2026-11-23T12:00:00Z' },
  requireCode: true,
  device: { id: 'd1', name: 'Chrome no Linux' },
  space: { notes: 0, media: 0, reserved: 0, limit: 0, warnAt: 0.9 },
})

beforeEach(() => {
  installMemoryStorage()
  new FakeDrive().install()
  const driveFetch = globalThis.fetch
  server = new FakeAppServer()
  server.appEnabled = false
  server.hierarchyAt = '2026-11-23T12:00:00Z'
  offline = false
  vi.stubGlobal('fetch', (input: string | URL | Request, init?: RequestInit) => {
    if (!String(input).startsWith(API)) return driveFetch(input, init)
    if (offline) return Promise.reject(new TypeError('Failed to fetch'))
    return server.fetch(input, init)
  })
  vi.stubGlobal('WebSocket', class { send() {} close() {} })
  account = uniqueAccount()
  useSyncStore.setState({ busy: false, conflicts: [], error: null, lastSyncAt: Date.now() })
  useAccountStore.setState({ accounts: [LOCAL_ACCOUNT, google(account)], activeId: account, reconnectId: null })
  useServerAccount.setState({ me: me(), status: 'signed-in' })
})

afterEach(() => {
  vi.unstubAllGlobals()
  useAccountStore.setState({ activeId: LOCAL_ACCOUNT.id })
  useServerAccount.setState({ me: null, status: 'unknown' })
})

describe('Linha no pé da lateral', () => {
  it('com a fila vazia: "Tudo na conta"', async () => {
    await library().connect(account, token)
    render(<SyncPill />)
    expect(await screen.findByText(/^Tudo na conta/)).toBeInTheDocument()
  })

  it('sem conexão com a conta, uma pasta nova espera: "1 mudança esperando conexão"; ao voltar, "Tudo na conta"', async () => {
    await library().connect(account, token)
    render(<SyncPill />)
    offline = true
    await library().createFolder({ name: 'Projeto Aurora' })
    expect(await screen.findByText('1 mudança esperando conexão')).toBeInTheDocument()
    offline = false
    await useSyncStore.getState().syncNow()
    await waitFor(() => expect(screen.getByText(/^Tudo na conta/)).toBeInTheDocument())
    expect([...server.rows.values()].some(row => row.name === 'Projeto Aurora')).toBe(true)
  })

  it('quando a internet volta, o que esperava sobe sozinho', async () => {
    await library().connect(account, token)
    render(<SyncPill />)
    offline = true
    await library().createFolder({ name: 'Contratos' })
    expect(await screen.findByText('1 mudança esperando conexão')).toBeInTheDocument()
    offline = false
    window.dispatchEvent(new Event('online'))
    await waitFor(() => expect([...server.rows.values()].some(row => row.name === 'Contratos')).toBe(true))
    await waitFor(() => expect(screen.getByText(/^Tudo na conta/)).toBeInTheDocument())
  })

  it('sem a hierarquia na conta (perfil Local), fica como hoje', async () => {
    useAccountStore.setState({ activeId: LOCAL_ACCOUNT.id })
    await library().connect(LOCAL_ACCOUNT.id)
    render(<SyncPill />)
    expect(screen.getByText('Local · sem nuvem')).toBeInTheDocument()
    expect(screen.queryByText(/Tudo na conta/)).toBeNull()
  })
})
