// A lista de links vive no índice da biblioteca, que vários aparelhos escrevem no mesmo Drive: nenhum aparelho pode perder o link de outro.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import 'fake-indexeddb/auto'

import type { ShareRecord } from '@/types/domain'
import { DriveRepository } from '@/lib/storage/drive-repository'

import { FakeDrive, installMemoryStorage, uniqueAccount } from '../storage/fake-drive'

const DAY = 24 * 3600_000
const token = vi.fn(async (_options?: { force?: boolean }) => 'tok')
let drive: FakeDrive

function record(fields: Partial<ShareRecord> = {}): ShareRecord {
  return { id: 'LinkLinkLinkLinkLink1', kind: 'entrada', itemId: 'e', title: 'Entrada', bytes: 100, withExams: true, createdAt: new Date(Date.now() - DAY).toISOString(), expiresAt: new Date(Date.now() + 2 * DAY).toISOString(), ...fields }
}

async function aparelho() {
  const repo = new DriveRepository(uniqueAccount(), token)
  return { repo, snapshot: await repo.load() }
}

beforeEach(() => {
  installMemoryStorage()
  drive = new FakeDrive().install()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('links compartilhados entre aparelhos', () => {
  it('o link feito em um aparelho aparece no outro, e o outro, ao gravar outra coisa, não o apaga', async () => {
    const a = await aparelho()
    const b = await aparelho()
    await a.repo.saveIndex({ ...a.snapshot.index, shares: [record()] })
    // b read the index before a wrote the link and saves a tag now
    await b.repo.saveIndex({ ...b.snapshot.index, tags: ['aula'] })
    const fresh = await aparelho()
    expect(fresh.snapshot.index.shares.map(share => share.id)).toEqual(['LinkLinkLinkLinkLink1'])
    expect(fresh.snapshot.index.tags).toEqual(['aula'])
  })

  it('o link atualizado no mesmo link em um aparelho (prazo novo) não volta ao prazo velho quando o outro grava', async () => {
    const a = await aparelho()
    const stale = record()
    await a.repo.saveIndex({ ...a.snapshot.index, shares: [stale] })
    const b = await aparelho()
    expect(b.snapshot.index.shares).toHaveLength(1)
    const renewed = record({ expiresAt: new Date(Date.now() + 3 * DAY).toISOString(), updatedAt: new Date().toISOString() })
    await a.repo.saveIndex({ ...a.snapshot.index, shares: [renewed] })
    await b.repo.saveIndex({ ...b.snapshot.index, tags: ['aula'] })
    const fresh = await aparelho()
    expect(fresh.snapshot.index.shares).toEqual([renewed])
  })

  it('o link apagado em um aparelho não volta quando o outro, que ainda o tinha, grava', async () => {
    const a = await aparelho()
    await a.repo.saveIndex({ ...a.snapshot.index, shares: [record()] })
    const b = await aparelho()
    expect(b.snapshot.index.shares).toHaveLength(1)
    await a.repo.saveIndex({ ...a.snapshot.index, shares: [] })
    await b.repo.saveIndex({ ...b.snapshot.index, tags: ['aula'] })
    expect((await aparelho()).snapshot.index.shares).toEqual([])
  })
})
