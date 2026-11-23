// Spec 005, história 1 (FR-004, SC-002): com a hierarquia na conta, toda sessão (com ou sem a estrutura do app) abre o canal ao vivo;
// quando outro aparelho muda a hierarquia, o servidor avisa e esta biblioteca traz a mudança em segundos.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import 'fake-indexeddb/auto'
import { waitFor } from '@testing-library/react'

const { mockEnv } = vi.hoisted(() => ({ mockEnv: { apiUrl: 'https://api.example.test' } }))
vi.mock('@/lib/env', async importOriginal => ({ env: { ...((await importOriginal()) as { env: object }).env, apiUrl: mockEnv.apiUrl } }))

import type { ServerMe } from '@/controllers/api.controller'
import { newFolderMeta } from '@/lib/defaults'
import { HierarchyRepository } from '@/lib/storage/hierarchy-repository'
import { MapCache } from '@/lib/storage/map-cache'
import { type Account, LOCAL_ACCOUNT, useAccountStore } from '@/stores/account'
import { useLibraryStore } from '@/stores/library'
import { useServerAccount } from '@/stores/server-account'
import { API, FakeAppServer } from '@/test/storage/fake-app-server'
import { FakeDrive, installMemoryStorage, uniqueAccount } from '@/test/storage/fake-drive'

const token = vi.fn(async () => 'tok')
const library = () => useLibraryStore.getState()

/** The live channel as the browser opens it: the test plays the server's side. */
class FakeSocket {
  static opened: FakeSocket[] = []
  onopen: (() => void) | null = null
  onmessage: ((event: { data: string }) => void) | null = null
  onclose: (() => void) | null = null
  sent: string[] = []
  constructor(readonly url: string) {
    FakeSocket.opened.push(this)
    setTimeout(() => this.onopen?.(), 0)
  }
  send(text: string) {
    this.sent.push(text)
  }
  close() {}
  serverSays(message: object) {
    this.onmessage?.({ data: JSON.stringify(message) })
  }
}

let server: FakeAppServer
let account: string

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
  vi.stubGlobal('fetch', (input: string | URL | Request, init?: RequestInit) => (String(input).startsWith(API) ? server.fetch(input, init) : driveFetch(input, init)))
  FakeSocket.opened = []
  vi.stubGlobal('WebSocket', FakeSocket)
  account = uniqueAccount()
  useAccountStore.setState({ accounts: [LOCAL_ACCOUNT, google(account)], activeId: account, reconnectId: null })
  useServerAccount.setState({ me: me(), status: 'signed-in' })
})

afterEach(() => {
  vi.unstubAllGlobals()
  useAccountStore.setState({ activeId: LOCAL_ACCOUNT.id })
  useServerAccount.setState({ me: null, status: 'unknown' })
})

describe('Canal ao vivo da hierarquia', () => {
  it('sem a estrutura do app, a sessão abre o canal ao vivo e diz o seq que já tem', async () => {
    await library().connect(account, token)
    await waitFor(() => expect(FakeSocket.opened.at(-1)?.url).toBe(`${API.replace(/^http/, 'ws')}/v1/live`))
    await waitFor(() => expect(FakeSocket.opened.at(-1)?.sent[0]).toMatch(/"type":"hello"/))
  })

  it('outro aparelho cria uma pasta: o aviso do servidor traz a pasta para esta biblioteca', async () => {
    await library().connect(account, token)
    await waitFor(() => expect(FakeSocket.opened.length).toBeGreaterThan(0))
    const other = new HierarchyRepository(account, new MapCache(`${account}-outro`))
    await other.load()
    await other.saveFolder(newFolderMeta({ name: 'Projeto Aurora' }))
    FakeSocket.opened.at(-1)!.serverSays({ type: 'map', seq: server.seq })
    await waitFor(() => expect(library().folders.map(folder => folder.name)).toContain('Projeto Aurora'), { timeout: 5000 })
  })
})
