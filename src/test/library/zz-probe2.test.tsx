import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import 'fake-indexeddb/auto'
import type { SourceMeta } from '@/types/domain'
import { useLibraryStore } from '@/stores/library'
import { FakeDrive, installMemoryStorage, uniqueAccount } from '@/test/storage/fake-drive'

const token = vi.fn(async () => 'tok')
const VIDEO: SourceMeta = { input: 'file', name: 'kickoff.mp4', sizeBytes: 1234, mime: 'video/mp4', durationSeconds: 60, storage: 'none', expiresAt: null }
let drive: FakeDrive
const library = () => useLibraryStore.getState()
beforeEach(async () => {
  installMemoryStorage()
  drive = new FakeDrive().install()
  drive.appDataGranted = true
  await library().connect(uniqueAccount(), token)
})
afterEach(() => { vi.unstubAllGlobals(); useLibraryStore.setState({ repo: null }) })
describe('log', () => {
  it('requests of a move', async () => {
    const a = await library().createFolder({ name: 'A' })
    const b = await library().createFolder({ name: 'B' })
    const entry = await library().createFile({ name: 'kickoff.mp4', role: 'entrada', kept: 'registro', type: 'reading', folderId: a.id, origin: VIDEO }, '')
    drive.requests = []
    await library().moveFiles([entry.id], b.id)
    for (const r of drive.requests) console.log(r.method, r.path, r.search.toString())
    expect(true).toBe(true)
  })
})
