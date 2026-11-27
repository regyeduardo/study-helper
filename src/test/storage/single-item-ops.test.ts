// Spec 007, T033 (research R4, H3): renomear, mover, apagar e restaurar uma nota do App mudam só a linha dela na hierarquia: um pedido
// só, sem ler a nota de novo quando ela está no aparelho. A medida de antes mostrou essas operações em ~2 s quase todos no aparelho, não
// na rede; a causa era o redesenho da lista inteira (T043). Este teste guarda que continuam sendo um pedido só.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import 'fake-indexeddb/auto'
import { waitFor } from '@testing-library/react'

const { mockEnv } = vi.hoisted(() => ({ mockEnv: { apiUrl: 'https://api.example.test' } }))
vi.mock('@/lib/env', async importOriginal => ({ env: { ...((await importOriginal()) as { env: object }).env, apiUrl: mockEnv.apiUrl } }))

import { CombinedRepository } from '@/lib/storage/combined-repository'
import { PartCache } from '@/lib/storage/part-cache'
import { type Account, LOCAL_ACCOUNT, useAccountStore } from '@/stores/account'
import { useLibraryStore } from '@/stores/library'
import { useServerAccount } from '@/stores/server-account'
import { useUiStore } from '@/stores/ui'
import { API, FakeAppServer } from '@/test/storage/fake-app-server'
import { FakeDrive, installMemoryStorage, uniqueAccount } from '@/test/storage/fake-drive'

const token = vi.fn(async () => 'tok')
const library = () => useLibraryStore.getState()
const repo = () => library().repo as CombinedRepository

let server: FakeAppServer
let account: string

const google = (id: string): Account => ({ id, kind: 'google', name: 'Ana', email: 'ana@example.com', picture: '', token: { accessToken: 'tok', expiresAt: Date.now() + 3600_000 } })

beforeEach(async () => {
  installMemoryStorage()
  new FakeDrive().install()
  const driveFetch = globalThis.fetch
  server = new FakeAppServer()
  server.hierarchyAt = '2026-11-23T12:00:00Z'
  vi.stubGlobal('fetch', (input: string | URL | Request, init?: RequestInit) => (String(input).startsWith(API) ? server.fetch(input, init) : driveFetch(input, init)))
  vi.stubGlobal('WebSocket', class { send() {} close() {} })
  account = uniqueAccount()
  useServerAccount.setState({ me: null, status: 'unknown' })
  useUiStore.setState({ overlay: null, toasts: [] })
  useAccountStore.setState({ accounts: [LOCAL_ACCOUNT, google(account)], activeId: account, reconnectId: null })
  await library().connect(account, token)
  await waitFor(() => expect(library().appOn && Boolean(repo().hierarchy)).toBe(true))
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  useAccountStore.setState({ activeId: LOCAL_ACCOUNT.id })
})

/** A note of the App with a big transcript, not opened on this device. */
async function bigNoteClosed() {
  const meta = await library().createFile({ name: 'Reunião longa', type: 'explanation', folderId: null }, 'texto da nota '.repeat(2000))
  await library().updateSidecar(meta.id, sidecar => ({ ...sidecar, transcript: 'Ana: fala longa. '.repeat(5000) }))
  useLibraryStore.setState({ opened: {} })
  server.calls.length = 0
  return meta
}

const partReads = () => server.calls.filter(call => call.method !== 'PUT' && /\/parts/.test(call.path))
const writes = () => server.calls.filter(call => call.method !== 'GET' && !/\/parts\/batch/.test(call.path))

describe('mudanças de um item', () => {
  it.each([
    ['renomear', { name: 'Reunião renomeada' }],
    ['mover', { folderId: null, position: 5 }],
    ['apagar', { deletedAt: '2026-11-24T10:00:00.000Z' }],
  ] as const)('%s, com a nota no aparelho, não lê a nota e faz um pedido só', async (_label, patch) => {
    const meta = await bigNoteClosed()
    await library().updateFile(meta.id, patch)
    expect(partReads()).toEqual([])
    expect(writes()).toHaveLength(1)
    const shown = library().files.find(file => file.id === meta.id)!
    for (const [key, value] of Object.entries(patch)) expect(shown[key as keyof typeof shown]).toEqual(value)
    // the server has the change, and the note's content is untouched
    expect(server.rows.get(meta.id)?.name).toBe('name' in patch ? patch.name : 'Reunião longa')
    expect(server.currentPart(meta.id, 'text')?.content).toBe('texto da nota '.repeat(2000))
  })

  // the phone, 26/11: a note made on another device and never opened here was read whole (parts/batch) before each of these, one trip
  // more on the mobile network (apagar and mover in 1.1-1.2 s, target 1 s); what changes is only the line of the hierarchy
  it.each([
    ['renomear', { name: 'Reunião renomeada' }],
    ['mover', { folderId: null, position: 5 }],
    ['apagar', { deletedAt: '2026-11-24T10:00:00.000Z' }],
  ] as const)('%s uma nota nunca aberta neste aparelho também não a lê: um pedido só', async (_label, patch) => {
    const meta = await bigNoteClosed()
    // this device opens the account again with nothing of the note kept
    await new PartCache(account).forget()
    await library().connect(account, token)
    await waitFor(() => expect(library().appOn && Boolean(repo().hierarchy)).toBe(true))
    expect(library().opened).toEqual({})
    server.calls.length = 0
    await library().updateFile(meta.id, patch)
    expect(partReads()).toEqual([])
    expect(server.calls.filter(call => /\/parts\/batch/.test(call.path))).toEqual([])
    expect(writes()).toHaveLength(1)
    const shown = library().files.find(file => file.id === meta.id)!
    for (const [key, value] of Object.entries(patch)) expect(shown[key as keyof typeof shown]).toEqual(value)
    // the note opens whole afterwards: its text and its transcript are where they were
    const opened = await library().openFile(meta.id)
    expect(opened.content).toBe('texto da nota '.repeat(2000))
    expect(opened.sidecar.transcript).toBe('Ana: fala longa. '.repeat(5000))
    expect(opened.sidecar.meta.folderId).toBe(shown.folderId)
  })

  it('restaurar da Lixeira também', async () => {
    const meta = await bigNoteClosed()
    await library().trashFiles([meta.id])
    server.calls.length = 0
    await library().restoreFile(meta.id)
    expect(partReads()).toEqual([])
    expect(library().files.find(file => file.id === meta.id)?.deletedAt).toBeNull()
  })

  it('uma mudança que não é só da hierarquia (favoritar) segue o caminho de sempre', async () => {
    const meta = await bigNoteClosed()
    await library().updateFile(meta.id, { favorite: true })
    expect(library().files.find(file => file.id === meta.id)?.favorite).toBe(true)
    expect(server.rows.get(meta.id)).toBeDefined()
  })
})
