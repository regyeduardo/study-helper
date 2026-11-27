// Spec 007, história 1 (T028, research R3): abrir a conta num aparelho que já a abriu mostra a biblioteca do retrato guardado nele, sem
// esperar a rede; logo em seguida o que mudou desde o seq do retrato aparece: o canal ao vivo diz esse seq e o servidor responde "map"
// quando tem mais; sem o canal, o app pergunta na hora (e a cada 15 s). Nada mudou, nada a fazer: abrir não refaz a biblioteca à toa.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import 'fake-indexeddb/auto'
import { act, waitFor } from '@testing-library/react'

const { mockEnv } = vi.hoisted(() => ({ mockEnv: { apiUrl: 'https://api.example.test' } }))
vi.mock('@/lib/env', async importOriginal => ({ env: { ...((await importOriginal()) as { env: object }).env, apiUrl: mockEnv.apiUrl } }))

import type { ServerMe } from '@/controllers/api.controller'
import { newFolderMeta } from '@/lib/defaults'
import { HierarchyRepository } from '@/lib/storage/hierarchy-repository'
import { MapCache } from '@/lib/storage/map-cache'
import { type Account, LOCAL_ACCOUNT, useAccountStore } from '@/stores/account'
import { useLibraryStore } from '@/stores/library'
import { useServerAccount } from '@/stores/server-account'
import { useSyncStore } from '@/stores/sync'
import { API, FakeAppServer } from '@/test/storage/fake-app-server'
import { FakeDrive, installMemoryStorage, uniqueAccount } from '@/test/storage/fake-drive'

const token = vi.fn(async () => 'tok')
const library = () => useLibraryStore.getState()
const folderNames = () => library().folders.filter(folder => !folder.deletedAt).map(folder => folder.name).sort()

let server: FakeAppServer
let account: string
let live: 'up' | 'down'
/** How long the server takes to answer the session (as in the app, it can come after the library opened). */
let slowMe = 0

/** The live channel as the server runs it: at "hello" it answers "map" when it has more than the seq the device says; or it is down. */
class LiveSocket {
  onopen: (() => void) | null = null
  onmessage: ((event: { data: string }) => void) | null = null
  onclose: (() => void) | null = null
  constructor() {
    setTimeout(() => (live === 'up' ? this.onopen?.() : this.onclose?.()), 0)
  }
  send(data: string) {
    const hello = JSON.parse(data) as { type: string; seq: number }
    if (hello.type === 'hello' && hello.seq < server.seq) setTimeout(() => this.onmessage?.({ data: JSON.stringify({ type: 'map', seq: server.seq }) }), 0)
  }
  close() {}
}

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
  slowMe = 0
  vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
    if (!String(input).startsWith(API)) return driveFetch(input, init)
    if (slowMe && String(input).endsWith('/v1/me')) await new Promise(resolve => setTimeout(resolve, slowMe))
    return server.fetch(input, init)
  })
  vi.stubGlobal('WebSocket', LiveSocket)
  live = 'up'
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

/** A device that opened the account and made "Faculdade"; then another device made "Viagens" while this one was closed. */
async function closedWhileAnotherChanged(): Promise<number> {
  await library().connect(account, token)
  await library().createFolder({ name: 'Faculdade' }, 'block')
  await useSyncStore.getState().syncNow()
  await waitFor(async () => expect(await new MapCache(account).seq()).toBeGreaterThan(0))
  const other = new HierarchyRepository(account, new MapCache(`${account}-outro`))
  await other.load()
  await other.saveFolder(newFolderMeta({ name: 'Viagens' }))
  return new MapCache(account).seq()
}

/** What the library shows at the moment it is ready, after opening again. */
async function openAgain(): Promise<string[]> {
  server.calls.length = 0
  const atReady: string[][] = []
  const stop = useLibraryStore.subscribe((state, before) => {
    if (state.ready && !before.ready) atReady.push(state.folders.filter(folder => !folder.deletedAt).map(folder => folder.name).sort())
  })
  await library().connect(account, token)
  stop()
  return atReady[0]
}

const sinceAsked = () => server.calls.filter(call => call.path === '/v1/library/map').map(call => new URLSearchParams(call.query).get('since'))

describe('abrir a conta pelo retrato do mapa', () => {
  it('mostra o retrato na hora; o canal ao vivo diz o seq e o que outro aparelho fez chega, pedindo só o que mudou', async () => {
    const copySeq = await closedWhileAnotherChanged()
    expect(await openAgain()).toEqual(['Faculdade'])
    await waitFor(() => expect(folderNames()).toEqual(['Faculdade', 'Viagens']))
    expect(sinceAsked()[0]).toBe(String(copySeq))
    expect(sinceAsked()).not.toContain('0')
  })

  it('sem o canal ao vivo, o app pergunta na hora, sem esperar 15 s', async () => {
    await closedWhileAnotherChanged()
    live = 'down'
    expect(await openAgain()).toEqual(['Faculdade'])
    await waitFor(() => expect(folderNames()).toEqual(['Faculdade', 'Viagens']), { timeout: 2000 })
  })

  // as the app really opens (26/11, measure of the phone): the library opens before the session answers; when it arrives, the App and the
  // hierarchy are turned on, and the App used to read the library again without the hierarchy, fetching the whole map and holding the
  // window "Abrindo a biblioteca do App" at every opening
  it('com a sessão chegando depois de abrir, o App liga sem buscar o mapa inteiro de novo', async () => {
    useServerAccount.setState({ me: { ...me(), user: { ...me().user, status: 'enabled', appEnabled: true } }, status: 'signed-in' })
    server.appEnabled = true
    await library().connect(account, token)
    await library().createFolder({ name: 'Faculdade' }, 'block')
    await useSyncStore.getState().syncNow()
    await waitFor(async () => expect(await new MapCache(account).seq()).toBeGreaterThan(0))

    // the next opening: the session answers only after the library opened (on the phone, 1.7 s)
    useServerAccount.setState({ me: null, status: 'unknown' })
    slowMe = 150
    server.calls.length = 0
    await library().connect(account, token)
    expect(library().appOn).toBe(false)
    await waitFor(() => expect(library().appOn).toBe(true))
    await waitFor(() => expect((library().repo as unknown as { hierarchy: unknown }).hierarchy).toBeTruthy())
    await new Promise(resolve => setTimeout(resolve, 100))
    expect(folderNames()).toEqual(['Faculdade'])
    expect(sinceAsked()).not.toContain('0')
  })

  // the phone, 26/11: a new device brought the whole map (1.1 MB) three times at once, the loads of the opening, of the hierarchy and of
  // the App sharing the mobile network (2.5 s each)
  it('num aparelho novo, com a sessão chegando depois de abrir, o mapa inteiro vem uma vez só', async () => {
    const other = new HierarchyRepository(account, new MapCache(`${account}-outro`))
    await other.load()
    await other.saveFolder(newFolderMeta({ name: 'Faculdade' }))
    server.appEnabled = true
    useServerAccount.setState({ me: null, status: 'unknown' })
    slowMe = 150
    server.calls.length = 0
    // as App.tsx: the sync starts when the library opened
    await library().connect(account, token)
    useSyncStore.getState().start()
    try {
      await waitFor(() => expect(library().appOn).toBe(true))
      await waitFor(() => expect(folderNames()).toEqual(['Faculdade']))
      await new Promise(resolve => setTimeout(resolve, 300))
      expect(sinceAsked().filter(since => since === '0')).toHaveLength(1)
    } finally {
      useSyncStore.getState().stop()
    }
  })

  it('nada mudou: abrir não pede o mapa nem refaz a biblioteca', async () => {
    await library().connect(account, token)
    await library().createFolder({ name: 'Faculdade' }, 'block')
    await useSyncStore.getState().syncNow()
    await waitFor(async () => expect(await new MapCache(account).seq()).toBe(server.seq))
    expect(await openAgain()).toEqual(['Faculdade'])
    const shown = library().files
    await new Promise(resolve => setTimeout(resolve, 100))
    expect(sinceAsked()).toEqual([])
    expect(library().files).toBe(shown)
  })
})

describe('sincronizar sem novidade', () => {
  // the sync of the opening (and the one every 5 min) asked the map and, with nothing new, still swapped the whole library: every list
  // and every row was drawn again, on top of what the person did right after opening (26/11, measure of the phone: the Gravações screen)
  it('não refaz a biblioteca: as mesmas listas, as mesmas notas e o mesmo índice', async () => {
    await library().connect(account, token)
    await library().createFolder({ name: 'Faculdade' }, 'block')
    await library().createFile({ name: 'Resumo', type: 'class', folderId: null, status: 'ready' }, '# Resumo')
    await useSyncStore.getState().syncNow()
    await new Promise(resolve => setTimeout(resolve, 50))
    const { files, folders, index, opened, sizes } = library()
    await useSyncStore.getState().syncNow()
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(library().files).toBe(files)
    expect(library().folders).toBe(folders)
    expect(library().index).toBe(index)
    expect(library().opened).toBe(opened)
    expect(library().sizes).toBe(sizes)
  })

  it('o que outro aparelho mudou chega, e o que não mudou continua o mesmo objeto (não se desenha de novo)', async () => {
    await library().connect(account, token)
    await library().createFolder({ name: 'Faculdade' }, 'block')
    const viagens = await library().createFolder({ name: 'Viagens' }, 'block')
    await useSyncStore.getState().syncNow()
    const faculdade = library().folders.find(folder => folder.name === 'Faculdade')
    const other = new HierarchyRepository(account, new MapCache(`${account}-outro`))
    await other.load()
    await other.saveFolder({ ...other.snapshot().folders.find(folder => folder.id === viagens.id)!, name: 'Férias' })
    await useSyncStore.getState().syncNow()
    expect(folderNames()).toEqual(['Faculdade', 'Férias'])
    expect(library().folders.find(folder => folder.name === 'Faculdade')).toBe(faculdade)
  })
})
