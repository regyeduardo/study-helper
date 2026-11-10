import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import 'fake-indexeddb/auto'

import type { FolderMeta } from '@/types/domain'
import { newFolderMeta } from '@/lib/defaults'
import { DriveRepository } from '@/lib/storage/drive-repository'
import { LocalRepository } from '@/lib/storage/local-repository'
import { mergeFolder } from '@/lib/sync/merge'
import { useLibraryStore } from '@/stores/library'
import { FakeDrive, installMemoryStorage, uniqueAccount } from '@/test/storage/fake-drive'

const token = vi.fn(async () => 'tok')
let drive: FakeDrive

async function driveRepo(name = 'dev'): Promise<DriveRepository> {
  const repo = new DriveRepository(uniqueAccount(name), token)
  await repo.load()
  return repo
}

async function localRepo(): Promise<LocalRepository> {
  const repo = new LocalRepository(`study-helper-local-test-${crypto.randomUUID()}`)
  await repo.load()
  return repo
}

/** A folder as the app saved it before favorites and colors existed. */
function oldFolder(): FolderMeta {
  const folder = newFolderMeta({ name: 'Cálculo I', description: 'Limites e derivadas' })
  delete (folder as Partial<FolderMeta>).favorite
  delete (folder as Partial<FolderMeta>).color
  return folder
}

const folderIn = async (repo: { load(): Promise<{ folders: FolderMeta[] }> }, id: string) => (await repo.load()).folders.find(folder => folder.id === id)

beforeEach(() => {
  installMemoryStorage()
  drive = new FakeDrive().install()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('favorito e cor da pasta são gravados', () => {
  it('no navegador, pela biblioteca', async () => {
    const repo = await localRepo()
    const folder = newFolderMeta({ name: 'Cálculo I' })
    await repo.saveFolder(folder)
    useLibraryStore.setState({ repo, sharedView: null, folders: [folder] })
    await useLibraryStore.getState().updateFolder(folder.id, { favorite: true, color: 'laranja' })
    expect(useLibraryStore.getState().folders[0]).toMatchObject({ favorite: true, color: 'laranja' })
    expect(await folderIn(repo, folder.id)).toMatchObject({ name: 'Cálculo I', favorite: true, color: 'laranja' })
  })

  it('no Drive, e outro aparelho lê os dois campos', async () => {
    const repo = await driveRepo()
    const folder = newFolderMeta({ name: 'Física II', favorite: true, color: 'roxo' })
    await repo.saveFolder(folder)
    expect(await folderIn(await driveRepo('outro'), folder.id)).toMatchObject({ name: 'Física II', favorite: true, color: 'roxo' })
  })
})

describe('pasta antiga, sem os campos', () => {
  it('continua válida nos dois repositórios, sem favorito e na cor padrão', async () => {
    for (const repo of [await localRepo(), await driveRepo()]) {
      const folder = oldFolder()
      await repo.saveFolder(folder)
      const loaded = await folderIn(repo, folder.id)
      expect(loaded).toMatchObject({ id: folder.id, name: 'Cálculo I', description: 'Limites e derivadas', deletedAt: null })
      expect(loaded?.favorite).toBeUndefined()
      expect(loaded?.color).toBeUndefined()
    }
  })

  it('ganhar uma cor não mexe no resto da pasta', async () => {
    const repo = await localRepo()
    const folder = oldFolder()
    await repo.saveFolder(folder)
    useLibraryStore.setState({ repo, sharedView: null, folders: [folder] })
    await useLibraryStore.getState().updateFolder(folder.id, { color: 'verde' })
    expect(await folderIn(repo, folder.id)).toMatchObject({ name: 'Cálculo I', description: 'Limites e derivadas', color: 'verde' })
  })
})

describe('dois aparelhos juntam favorito e cor', () => {
  it('cada um muda um campo e os dois ficam, nos dois sentidos', async () => {
    const a = await driveRepo('a')
    const folder = newFolderMeta({ name: 'Cálculo I' })
    await a.saveFolder(folder)
    const b = await driveRepo('b')

    await a.saveFolder({ ...folder, favorite: true })
    await b.saveFolder({ ...folder, color: 'verde' })
    expect(await folderIn(await driveRepo('c'), folder.id)).toMatchObject({ favorite: true, color: 'verde' })

    await a.saveFolder({ ...folder, favorite: false })
    expect(await folderIn(await driveRepo('d'), folder.id)).toMatchObject({ favorite: false, color: 'verde' })
  })

  it('mergeFolder: o lado que mudou vence; campo novo do outro lado não se perde', () => {
    const base = oldFolder()
    const mine = { ...base, color: 'azul' as const, updated: { ...base.updated, at: '2026-11-07T10:00:00.000Z' } }
    const theirs = { ...base, favorite: true, description: 'Mudada lá' }
    expect(mergeFolder(base, mine, theirs)).toEqual({ ...base, favorite: true, color: 'azul', description: 'Mudada lá', updated: mine.updated })
    expect(mergeFolder(base, { ...base, color: 'cinza' }, { ...base, color: 'vermelho' }).color).toBe('cinza')
    expect(mergeFolder(base, { ...base, favorite: true, color: 'roxo' }, { ...base, favorite: false })).toMatchObject({ favorite: true, color: 'roxo' })
  })
})
