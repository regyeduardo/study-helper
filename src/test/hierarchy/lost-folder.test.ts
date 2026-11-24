// Spec 005, R6: uma nota em Local cuja pasta foi apagada de vez em outro aparelho aparece na raiz, com um aviso (uma vez).
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import 'fake-indexeddb/auto'
import { waitFor } from '@testing-library/react'

const { mockEnv } = vi.hoisted(() => ({ mockEnv: { apiUrl: 'https://api.example.test' } }))
vi.mock('@/lib/env', async importOriginal => ({ env: { ...((await importOriginal()) as { env: object }).env, apiUrl: mockEnv.apiUrl } }))

import type { ServerMe } from '@/controllers/api.controller'
import { newFileMeta, newSidecar } from '@/lib/defaults'
import { LocalRepository } from '@/lib/storage/local-repository'
import { type Account, LOCAL_ACCOUNT, useAccountStore } from '@/stores/account'
import { useLibraryStore } from '@/stores/library'
import { useServerAccount } from '@/stores/server-account'
import { useUiStore } from '@/stores/ui'
import { API, FakeAppServer } from '@/test/storage/fake-app-server'
import { FakeDrive, installMemoryStorage, uniqueAccount } from '@/test/storage/fake-drive'

const google = (id: string): Account => ({ id, kind: 'google', name: 'Ana', email: 'ana@example.com', picture: '', token: { accessToken: 'tok', expiresAt: Date.now() + 3600_000 } })
const me: ServerMe = {
  user: { id: 'u1', email: 'ana@example.com', name: 'Ana', photoUrl: null, status: 'no-code', appEnabled: false, admin: false, deleteAt: null, hasPassword: false, hasGoogle: true, hierarchyAt: '2026-11-23T12:00:00Z' },
  requireCode: true,
  device: { id: 'd1', name: 'Chrome' },
  space: { notes: 0, media: 0, reserved: 0, limit: 0, warnAt: 0.9 },
}

let account: string

beforeEach(() => {
  installMemoryStorage()
  new FakeDrive().install()
  const driveFetch = globalThis.fetch
  const server = new FakeAppServer()
  server.appEnabled = false
  server.hierarchyAt = '2026-11-23T12:00:00Z'
  vi.stubGlobal('fetch', (input: string | URL | Request, init?: RequestInit) => (String(input).startsWith(API) ? server.fetch(input, init) : driveFetch(input, init)))
  vi.stubGlobal('WebSocket', class { send() {} close() {} })
  account = uniqueAccount()
  useUiStore.setState({ overlay: null, toasts: [] })
  useAccountStore.setState({ accounts: [LOCAL_ACCOUNT, google(account)], activeId: account, reconnectId: null })
  useServerAccount.setState({ me, status: 'signed-in' })
})

afterEach(() => {
  vi.unstubAllGlobals()
  useAccountStore.setState({ activeId: LOCAL_ACCOUNT.id })
  useServerAccount.setState({ me: null, status: 'unknown' })
})

it('nota em Local numa pasta apagada em outro aparelho: aparece na raiz e o app avisa', async () => {
  // this browser's Local keeps a note in a folder the account's hierarchy no longer has
  const local = new LocalRepository(`study-helper-local-${account}`, account)
  await local.load()
  await local.saveFile(newSidecar(newFileMeta({ name: 'Rascunho do contrato', type: 'class', folderId: 'pasta-apagada', place: 'local' })), 'texto')
  await useLibraryStore.getState().connect(account, async () => 'tok')
  await waitFor(() => expect(useLibraryStore.getState().files.find(file => file.name === 'Rascunho do contrato')?.folderId).toBeNull())
  await waitFor(() => expect(useUiStore.getState().toasts.map(toast => toast.text)).toContain('1 nota em Local estava numa pasta apagada em outro aparelho: ela está na raiz da biblioteca.'))
})
