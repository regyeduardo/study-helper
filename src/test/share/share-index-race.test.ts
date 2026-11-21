import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import 'fake-indexeddb/auto'

import type { ShareRecord } from '@/types/domain'
import { LocalRepository } from '@/lib/storage/local-repository'
import { useLibraryStore } from '@/stores/library'

import { installMemoryStorage } from '../storage/fake-drive'

const DAY = 24 * 3600_000

function record(id: string): ShareRecord {
  return { id, kind: 'file', itemId: 'nota-1', title: 'Nota', bytes: 100, withExams: false, createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 3 * DAY).toISOString() }
}

beforeEach(() => {
  installMemoryStorage()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('a lista de links não perde um link que está sendo guardado', () => {
  it('uma sincronização que termina no meio da gravação da lista não apaga o link da memória', async () => {
    const repo = new LocalRepository(`study-helper-share-race-${crypto.randomUUID()}`)
    const snapshot = await repo.load()
    useLibraryStore.setState({ repo, index: snapshot.index, folders: [], files: [], opened: {}, ready: true, loadError: null })
    let finish = () => undefined as void
    vi.spyOn(repo, 'saveIndex').mockImplementation(() => new Promise<void>(resolve => (finish = resolve)))
    const saving = useLibraryStore.getState().saveShare(record('LinkLinkLinkLinkLink1'))
    // the sync read the Drive before the new list was written there: its index does not have the link yet
    useLibraryStore.getState().applySnapshot(snapshot)
    expect(useLibraryStore.getState().index.shares.map(share => share.id)).toEqual(['LinkLinkLinkLinkLink1'])
    finish()
    await saving
    expect(useLibraryStore.getState().index.shares.map(share => share.id)).toEqual(['LinkLinkLinkLinkLink1'])
  })

  it('sem gravação em andamento, a sincronização traz o índice do Drive como sempre (links de outro aparelho entram)', async () => {
    const repo = new LocalRepository(`study-helper-share-race-${crypto.randomUUID()}`)
    const snapshot = await repo.load()
    useLibraryStore.setState({ repo, index: snapshot.index, folders: [], files: [], opened: {}, ready: true, loadError: null })
    useLibraryStore.getState().applySnapshot({ ...snapshot, index: { ...snapshot.index, shares: [record('DeOutroAparelho00001')] } })
    expect(useLibraryStore.getState().index.shares.map(share => share.id)).toEqual(['DeOutroAparelho00001'])
  })
})
