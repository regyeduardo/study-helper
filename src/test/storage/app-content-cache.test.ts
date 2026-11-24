// Spec 003, história 6 (T143, US6/AC1, AC2, AC6): o conteúdo das notas do App fica guardado neste navegador (IndexedDB), não só na
// memória: abre na hora, sem pedir de novo ao servidor, e lê sem internet depois de recarregar. O cache tem limite; cheio, sai o que
// foi usado há mais tempo, e nunca sai o que ainda espera para subir.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import 'fake-indexeddb/auto'

const { mockEnv } = vi.hoisted(() => ({ mockEnv: { apiUrl: 'https://api.example.test' } }))
vi.mock('@/lib/env', async importOriginal => ({ env: { ...((await importOriginal()) as { env: object }).env, apiUrl: mockEnv.apiUrl } }))

import type { Highlight } from '@/types/domain'
import { newFileMeta, newSidecar } from '@/lib/defaults'
import { AppRepository } from '@/lib/storage/app-repository'
import { CombinedRepository } from '@/lib/storage/combined-repository'
import { DriveRepository } from '@/lib/storage/drive-repository'
import { HierarchyRepository } from '@/lib/storage/hierarchy-repository'
import { LocalRepository } from '@/lib/storage/local-repository'
import { MapCache } from '@/lib/storage/map-cache'
import { type HeldNote, PartCache } from '@/lib/storage/part-cache'
import { API, FakeAppServer } from '@/test/storage/fake-app-server'
import { FakeDrive, installMemoryStorage, uniqueAccount } from '@/test/storage/fake-drive'

const token = vi.fn(async () => 'tok')

let server: FakeAppServer
let account: string

/** This browser, opened again: new repositories over the same IndexedDB (what a reload does). */
function open() {
  const repo = new CombinedRepository(new DriveRepository(account, token, 'drive'), new LocalRepository(`study-helper-local-${account}`, account))
  repo.setHierarchy(new HierarchyRepository(account, new MapCache(account)))
  repo.setApp(new AppRepository(account))
  return repo
}

const partReads = () => server.calls.filter(call => call.method === 'GET' && call.path.includes('/parts'))

beforeEach(() => {
  installMemoryStorage()
  const drive = new FakeDrive().install()
  const driveFetch = globalThis.fetch
  server = new FakeAppServer()
  server.hierarchyAt = '2026-11-23T12:00:00Z'
  vi.stubGlobal('fetch', (input: string | URL | Request, init?: RequestInit) => (String(input).startsWith(API) ? server.fetch(input, init) : driveFetch(input, init)))
  void drive
  account = uniqueAccount()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('cache do conteúdo do App', () => {
  it('depois de recarregar, a nota do App abre sem pedir o conteúdo de novo ao servidor', async () => {
    const first = open()
    await first.load()
    const aula = newFileMeta({ name: 'Aula 1', type: 'class', folderId: null })
    await first.saveFile(newSidecar(aula), 'derivadas')
    expect(first.sideOf(aula.id)).toBe('app')

    const again = open()
    await again.load()
    const before = partReads().length
    expect(await again.readContent(aula.id)).toBe('derivadas')
    expect(partReads().length).toBe(before)
  })

  it('sem internet, depois de recarregar, a nota do App abre com o texto e as marcações', async () => {
    const first = open()
    await first.load()
    const aula = newFileMeta({ name: 'Aula 1', type: 'class', folderId: null })
    const highlight: Highlight = { id: 'h1', kind: 'highlight', quote: 'derivadas', text: '', color: 'yellow', startOffset: 0, endOffset: 9, createdAt: '2026-11-24T10:00:00.000Z', updatedAt: '2026-11-24T10:00:00.000Z' }
    await first.saveFile({ ...newSidecar(aula), highlights: [highlight] }, 'derivadas')

    server.offline = true
    const again = open()
    const snapshot = await again.load()
    expect(snapshot.files.map(file => file.name)).toEqual(['Aula 1'])
    expect(await again.readContent(aula.id)).toBe('derivadas')
    expect((await again.readSidecar(aula.id)).highlights).toEqual([highlight])
  })

  it('o que veio do servidor também fica: lida uma vez com internet, abre depois sem ela', async () => {
    const writer = open()
    await writer.load()
    const aula = newFileMeta({ name: 'Ata', type: 'meeting', folderId: null })
    await writer.saveFile(newSidecar(aula), 'decidimos o prazo')
    // another browser of the same account: nothing of this note in its cache yet
    await new PartCache(account).forget()

    const reader = open()
    await reader.load()
    expect(await reader.readContent(aula.id)).toBe('decidimos o prazo')
    server.offline = true
    const offline = open()
    await offline.load()
    expect(await offline.readContent(aula.id)).toBe('decidimos o prazo')
  })
})

describe('limite do cache', () => {
  it('cheio, sai o que foi usado há mais tempo', async () => {
    const cache = new PartCache(account, { limitBytes: 100 })
    await cache.put('a', 'text', 'v1', 'a'.repeat(40))
    await cache.put('b', 'text', 'v1', 'b'.repeat(40))
    // "a" opened again: now "b" is the one used longest ago
    expect(await cache.get('a', 'text', 'v1')).toBe('a'.repeat(40))
    await cache.put('c', 'text', 'v1', 'c'.repeat(40))
    expect(await cache.get('b', 'text', 'v1')).toBeUndefined()
    expect(await cache.get('a', 'text', 'v1')).toBe('a'.repeat(40))
    expect(await cache.get('c', 'text', 'v1')).toBe('c'.repeat(40))
    expect(await cache.bytes()).toBeLessThanOrEqual(100)
  })

  it('nunca sai o que espera para subir, mesmo sendo o mais antigo', async () => {
    const cache = new PartCache(account, { limitBytes: 100 })
    const sidecar = { meta: { id: 'rascunho' } } as unknown as HeldNote['sidecar']
    await cache.hold({ id: 'rascunho', sidecar, content: 'r'.repeat(60), at: '2026-11-24T10:00:00.000Z' })
    await cache.put('a', 'text', 'v1', 'a'.repeat(60))
    await cache.put('b', 'text', 'v1', 'b'.repeat(60))
    expect(await cache.get('a', 'text', 'v1')).toBeUndefined()
    expect((await cache.held()).map(note => note.content)).toEqual(['r'.repeat(60)])
    // clearing the copy (leaving the account) does not take it either: it exists nowhere else
    await cache.forget()
    expect((await cache.held()).map(note => note.id)).toEqual(['rascunho'])
  })

  it('uma versão velha não serve: só a versão pedida abre do cache', async () => {
    const cache = new PartCache(account)
    await cache.put('a', 'text', 'v1', 'antes')
    expect(await cache.get('a', 'text', 'v2')).toBeUndefined()
    await cache.put('a', 'text', 'v2', 'depois')
    expect(await cache.get('a', 'text', 'v2')).toBe('depois')
    expect(await cache.get('a', 'text', 'v1')).toBeUndefined()
  })
})
