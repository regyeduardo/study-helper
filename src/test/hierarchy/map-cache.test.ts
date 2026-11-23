// Spec 005 (R7, data-model "Navegador"): a cópia do mapa no navegador, por conta, para a hierarquia abrir e mudar sem internet.
// Guarda as linhas, o último seq, a fila do que ainda não subiu (em ordem) e onde a migração parou.
import { beforeEach, describe, expect, it } from 'vitest'
import 'fake-indexeddb/auto'

import type { LibraryRow } from '@/controllers/library-api.controller'
import { MapCache } from '@/lib/storage/map-cache'
import { uniqueAccount } from '@/test/storage/fake-drive'

function row(id: string, fields: Partial<LibraryRow> = {}): LibraryRow {
  return {
    id,
    itemKind: 'folder',
    noteType: null,
    name: id,
    folderId: null,
    parentFileId: null,
    place: null,
    recording: false,
    position: 0,
    meta: {},
    driveRef: null,
    createdAt: '2026-11-23T10:00:00Z',
    updatedAt: '2026-11-23T10:00:00Z',
    trashedAt: null,
    trashedWith: null,
    parts: {},
    media: null,
    noteBytes: 0,
    mediaBytes: 0,
    removedAt: null,
    rev: 1,
    seq: 1,
    ...fields,
  }
}

let account: string

beforeEach(() => {
  account = uniqueAccount()
})

describe('cópia do mapa por conta', () => {
  it('guarda e lê as linhas com o seq; reabrir lê o mesmo', async () => {
    const cache = new MapCache(account)
    expect(await cache.hasCopy()).toBe(false)
    expect(await cache.seq()).toBe(0)
    await cache.saveRows([row('faculdade', { seq: 3 }), row('aula', { itemKind: 'file', place: 'drive', seq: 4 })], 4)
    const again = new MapCache(account)
    expect(await again.hasCopy()).toBe(true)
    expect(await again.seq()).toBe(4)
    expect((await again.rows()).map(item => item.id).sort()).toEqual(['aula', 'faculdade'])
  })

  it('uma linha nova substitui a velha pelo id; o seq só sobe', async () => {
    const cache = new MapCache(account)
    await cache.saveRows([row('faculdade', { name: 'Faculdade', seq: 3 })], 3)
    await cache.saveRows([row('faculdade', { name: 'Faculdade 2026', rev: 2, seq: 5 })], 5)
    await cache.saveRows([], 2)
    expect((await cache.rows()).map(item => item.name)).toEqual(['Faculdade 2026'])
    expect(await cache.seq()).toBe(5)
  })

  it('cada conta tem a sua cópia', async () => {
    const other = uniqueAccount()
    await new MapCache(account).saveRows([row('so-desta')], 1)
    expect(await new MapCache(other).rows()).toEqual([])
    expect(await new MapCache(other).hasCopy()).toBe(false)
  })
})

describe('fila do que ainda não subiu', () => {
  it('sai na ordem em que entrou e some ao ser enviada', async () => {
    const cache = new MapCache(account)
    const first = await cache.queue({ op: 'put', id: 'a', row: row('a'), baseRev: 0, at: '2026-11-23T10:00:00Z' })
    await cache.queue({ op: 'put', id: 'b', row: row('b'), baseRev: 0, at: '2026-11-23T10:00:01Z' })
    await cache.queue({ op: 'delete', id: 'c', baseRev: 4, at: '2026-11-23T10:00:02Z' })
    expect((await cache.outbox()).map(entry => `${entry.change.op}:${entry.change.id}`)).toEqual(['put:a', 'put:b', 'delete:c'])
    await cache.dequeue(first)
    expect((await new MapCache(account).outbox()).map(entry => entry.change.id)).toEqual(['b', 'c'])
  })

  it('uma mudança na fila pode ser trocada sem perder o lugar dela', async () => {
    const cache = new MapCache(account)
    const key = await cache.queue({ op: 'put', id: 'a', row: row('a', { name: 'Um' }), baseRev: 0, at: '2026-11-23T10:00:00Z' })
    await cache.queue({ op: 'put', id: 'b', row: row('b'), baseRev: 0, at: '2026-11-23T10:00:01Z' })
    await cache.replaceQueued(key, { op: 'put', id: 'a', row: row('a', { name: 'Dois' }), baseRev: 0, at: '2026-11-23T10:00:02Z' })
    const outbox = await cache.outbox()
    expect(outbox.map(entry => entry.change.id)).toEqual(['a', 'b'])
    expect(outbox[0].change.row?.name).toBe('Dois')
  })
})

describe('estado da migração', () => {
  it('guarda onde a migração parou, por conta', async () => {
    const cache = new MapCache(account)
    expect(await cache.migration()).toBeNull()
    await cache.setMigration({ step: 'enviando', backupId: 'b1', sent: ['f1', 'f2'], at: '2026-11-23T10:00:00Z' })
    expect(await new MapCache(account).migration()).toEqual({ step: 'enviando', backupId: 'b1', sent: ['f1', 'f2'], at: '2026-11-23T10:00:00Z' })
    expect(await new MapCache(uniqueAccount()).migration()).toBeNull()
  })
})

describe('esquecer a conta', () => {
  it('apaga a cópia, a fila e a migração', async () => {
    const cache = new MapCache(account)
    await cache.saveRows([row('a')], 1)
    await cache.queue({ op: 'delete', id: 'a', baseRev: 1, at: '2026-11-23T10:00:00Z' })
    await cache.setMigration({ step: 'feita', sent: [], at: '2026-11-23T10:00:00Z' })
    await cache.forget()
    const fresh = new MapCache(account)
    expect(await fresh.rows()).toEqual([])
    expect(await fresh.outbox()).toEqual([])
    expect(await fresh.migration()).toBeNull()
    expect(await fresh.hasCopy()).toBe(false)
  })
})
