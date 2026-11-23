// Spec 005, história 4 (FR-010, SC-006): ligar a estrutura do app só libera o lugar App; desligar não mexe nas pastas.
// A hierarquia fica idêntica, item a item (mesmas pastas, nomes, pastas de cima e posições).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import 'fake-indexeddb/auto'
import { waitFor } from '@testing-library/react'

const { mockEnv } = vi.hoisted(() => ({ mockEnv: { apiUrl: 'https://api.example.test' } }))
vi.mock('@/lib/env', async importOriginal => ({ env: { ...((await importOriginal()) as { env: object }).env, apiUrl: mockEnv.apiUrl } }))

import type { ServerMe } from '@/controllers/api.controller'
import { CombinedRepository } from '@/lib/storage/combined-repository'
import { type Account, LOCAL_ACCOUNT, useAccountStore } from '@/stores/account'
import { useBlockingStore } from '@/stores/blocking'
import { useLibraryStore } from '@/stores/library'
import { usePlacesStore } from '@/stores/places'
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

const me = (appEnabled: boolean): ServerMe => ({
  user: { id: 'u1', email: 'ana@example.com', name: 'Ana', photoUrl: null, status: 'enabled', appEnabled, admin: false, deleteAt: null, hasPassword: false, hasGoogle: true, hierarchyAt: '2026-11-23T12:00:00Z' },
  requireCode: true,
  device: { id: 'd1', name: 'Chrome no Linux' },
  space: { notes: 0, media: 0, reserved: 0, limit: 10 * 1024 ** 3, warnAt: 0.9 },
})

/** The hierarchy as it is: every folder and note with its name, folder above and position. */
function tree() {
  const { folders, files } = library()
  return {
    folders: folders.map(folder => ({ id: folder.id, name: folder.name, parentId: folder.parentId, position: folder.position })).sort((a, b) => a.id.localeCompare(b.id)),
    files: files.map(file => ({ id: file.id, name: file.name, folderId: file.folderId, position: file.position })).sort((a, b) => a.id.localeCompare(b.id)),
  }
}

async function turn(on: boolean) {
  server.appEnabled = on
  useServerAccount.setState({ me: me(on) })
  await waitFor(() => expect(library().appOn).toBe(on))
  await waitFor(() => expect(useBlockingStore.getState().ops).toHaveLength(0))
}

beforeEach(async () => {
  installMemoryStorage()
  new FakeDrive().install()
  const driveFetch = globalThis.fetch
  server = new FakeAppServer()
  server.appEnabled = false
  server.hierarchyAt = '2026-11-23T12:00:00Z'
  vi.stubGlobal('fetch', (input: string | URL | Request, init?: RequestInit) => (String(input).startsWith(API) ? server.fetch(input, init) : driveFetch(input, init)))
  vi.stubGlobal('WebSocket', class { send() {} close() {} })
  account = uniqueAccount()
  useUiStore.setState({ overlay: null, toasts: [] })
  useBlockingStore.setState({ ops: [] })
  usePlacesStore.setState({ running: false, progress: null, failed: [] })
  useAccountStore.setState({ accounts: [LOCAL_ACCOUNT, google(account)], activeId: account, reconnectId: null })
  useServerAccount.setState({ me: me(false), status: 'signed-in' })
  await library().connect(account, token)
  expect(repo().hierarchy).toBeTruthy()
  const faculdade = await library().createFolder({ name: 'Faculdade' })
  const calculo = await library().createFolder({ name: 'Cálculo I', parentId: faculdade.id })
  await library().createFolder({ name: 'Trabalho' })
  await library().createFile({ name: 'Aula 12', type: 'class', folderId: calculo.id }, 'integrais')
  await library().createFile({ name: 'Lista 3', type: 'class', folderId: calculo.id }, 'exercícios')
})

afterEach(() => {
  vi.unstubAllGlobals()
  useAccountStore.setState({ activeId: LOCAL_ACCOUNT.id })
  useServerAccount.setState({ me: null, status: 'unknown' })
})

describe('Ligar e desligar a estrutura do app', () => {
  it('ligar não muda a hierarquia e libera o App como lugar das notas', async () => {
    const before = tree()
    await turn(true)
    expect(tree()).toEqual(before)
    const aula = library().files.find(file => file.name === 'Aula 12')!
    await usePlacesStore.getState().choosePlace([aula.id], 'app')
    expect(repo().sideOf(aula.id)).toBe('app')
    expect(tree()).toEqual(before)
  })

  it('desligar sem nada no App deixa a hierarquia idêntica', async () => {
    await turn(true)
    const before = tree()
    await turn(false)
    expect(tree()).toEqual(before)
    expect(library().folders.map(folder => folder.name).sort()).toEqual(['Cálculo I', 'Faculdade', 'Trabalho'])
  })
})
