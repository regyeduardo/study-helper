import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import 'fake-indexeddb/auto'

import type { SourceMeta } from '@/types/domain'
import { newFileMeta, newSidecar } from '@/lib/defaults'
import { DriveRepository } from '@/lib/storage/drive-repository'
import { useLibraryStore } from '@/stores/library'
import { useSyncStore } from '@/stores/sync'
import { FakeDrive, installMemoryStorage, uniqueAccount } from '@/test/storage/fake-drive'

const token = vi.fn(async () => 'tok')
const VIDEO: SourceMeta = { input: 'file', name: 'kickoff.mp4', sizeBytes: 1234, mime: 'video/mp4', durationSeconds: 60, storage: 'none', expiresAt: null }

let drive: FakeDrive
let account: string
const library = () => useLibraryStore.getState()

function strict(drive: FakeDrive) {
  const real = drive.fetch.getMockImplementation()!
  drive.fetch.mockImplementation(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = new URL(String(input))
    const id = /\/files\/([^/?]+)$/.exec(url.pathname)?.[1]
    if ((init.method ?? 'GET').toUpperCase() === 'PATCH' && id) {
      const file = drive.files.get(id)
      const add = url.searchParams.get('addParents')?.split(',') ?? []
      const remove = url.searchParams.get('removeParents')?.split(',') ?? []
      if (file && (add.length || remove.length)) {
        if (remove.some(parent => !file.parents.includes(parent))) return new Response(JSON.stringify({ error: { message: 'removeParents not a parent' } }), { status: 400 })
        const next = [...file.parents.filter(parent => !remove.includes(parent)), ...add.filter(parent => !file.parents.includes(parent))]
        if (next.length !== 1) return new Response(JSON.stringify({ error: { message: `parents=${next.length}` } }), { status: 403 })
      }
    }
    return real(input, init)
  })
}

beforeEach(async () => {
  installMemoryStorage()
  drive = new FakeDrive().install()
  drive.appDataGranted = true
  strict(drive)
  account = uniqueAccount()
  await library().connect(account, token)
})

afterEach(() => {
  useSyncStore.getState().stop()
  vi.unstubAllGlobals()
  useLibraryStore.setState({ repo: null })
})

const fresh = async () => (await new DriveRepository(account, token, 'appDataFolder').load()).files

describe('probe', () => {
  it('strict parents: move entrada and note, store and fresh', async () => {
    const a = await library().createFolder({ name: 'A' })
    const b = await library().createFolder({ name: 'B' })
    const entry = await library().createFile({ name: 'kickoff.mp4', role: 'entrada', kept: 'registro', type: 'reading', folderId: a.id, origin: VIDEO }, '')
    const note = await library().createFile({ name: 'Ata', type: 'meeting', folderId: a.id, parentFileId: entry.id }, '# Ata')
    await library().moveFiles([entry.id], b.id)
    await library().moveFiles([note.id], b.id)
    expect(library().files.find(f => f.id === entry.id)!.folderId).toBe(b.id)
    const files = await fresh()
    expect(files.find(f => f.id === entry.id)!.folderId).toBe(b.id)
    expect(files.find(f => f.id === note.id)!.folderId).toBe(b.id)
  })

  it('migrated entrada (old note with media) moves', async () => {
    const a = await library().createFolder({ name: 'A' })
    const b = await library().createFolder({ name: 'B' })
    const repo = library().repo!
    // an old note made from a video, before entradas: written text, not the transcription
    const old = newSidecar(newFileMeta({ name: 'Aula de kickoff', type: 'class', folderId: a.id, origin: VIDEO }))
    await repo.saveFile({ ...old, transcript: 'fala' }, '# Aula\n\ntexto escrito')
    const index = await (repo as DriveRepository).indexFromDrive()
    await repo.saveIndex({ ...index!, entriesMigratedAt: undefined })
    await library().connect(account, token)
    const entry = library().files.find(f => f.role === 'entrada')
    expect(entry).toBeDefined()
    await library().moveFiles([entry!.id], b.id)
    expect(library().files.find(f => f.id === entry!.id)!.folderId).toBe(b.id)
    const files = await fresh()
    expect(files.find(f => f.id === entry!.id)!.folderId).toBe(b.id)
  })

  it('move then sync', async () => {
    const a = await library().createFolder({ name: 'A' })
    const b = await library().createFolder({ name: 'B' })
    const entry = await library().createFile({ name: 'kickoff.mp4', role: 'entrada', kept: 'registro', type: 'reading', folderId: a.id, origin: VIDEO }, '')
    await library().connect(account, token)
    await library().openFile(entry.id)
    await library().moveFiles([entry.id], b.id)
    await useSyncStore.getState().syncNow()
    expect(useSyncStore.getState().error).toBeNull()
    expect(library().files.find(f => f.id === entry.id)!.folderId).toBe(b.id)
  })
})
