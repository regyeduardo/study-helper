import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import 'fake-indexeddb/auto'

import { defaultIndex, newFileMeta, newFolderMeta, newSidecar } from '@/lib/defaults'
import { LocalRepository } from '@/lib/storage/local-repository'
import { useLibraryStore } from '@/stores/library'

import { FakeDrive, installMemoryStorage, uniqueAccount } from './fake-drive'

function freshRepo(): LocalRepository {
  return new LocalRepository(`study-helper-local-test-${crypto.randomUUID()}`)
}

describe('LocalRepository (perfil Local, IndexedDB)', () => {
  it('cria nota e pasta e elas continuam lá depois de reabrir', async () => {
    const name = `study-helper-local-test-${crypto.randomUUID()}`
    const repo = new LocalRepository(name)
    await repo.load()
    const folder = newFolderMeta({ name: 'Biologia' })
    await repo.saveFolder(folder)
    const sidecar = newSidecar(newFileMeta({ name: 'Célula', type: 'reading', folderId: folder.id }))
    await repo.saveFile(sidecar, '# Célula\n\nconteúdo')

    const reopened = new LocalRepository(name)
    const snapshot = await reopened.load()
    expect(snapshot.folders.map(item => item.name)).toEqual(['Biologia'])
    expect(snapshot.files).toHaveLength(1)
    expect(snapshot.files[0]).toMatchObject({ id: sidecar.meta.id, name: 'Célula', folderId: folder.id })
    expect(await reopened.readContent(sidecar.meta.id)).toBe('# Célula\n\nconteúdo')
    expect((await reopened.readSidecar(sidecar.meta.id)).meta.name).toBe('Célula')
  })

  it('edita, move e apaga nota e pasta', async () => {
    const repo = freshRepo()
    await repo.load()
    const a = newFolderMeta({ name: 'A' })
    const b = newFolderMeta({ name: 'B' })
    await repo.saveFolder(a)
    await repo.saveFolder(b)
    const sidecar = newSidecar(newFileMeta({ name: 'Nota', type: 'reading', folderId: a.id }))
    await repo.saveFile(sidecar, 'v1')

    await repo.saveFile({ ...sidecar, meta: { ...sidecar.meta, name: 'Nota editada', folderId: b.id } }, 'v2')
    await repo.saveFolder({ ...b, name: 'B2', parentId: a.id })
    let snapshot = await repo.load()
    expect(snapshot.files[0]).toMatchObject({ name: 'Nota editada', folderId: b.id })
    expect(await repo.readContent(sidecar.meta.id)).toBe('v2')
    expect(snapshot.folders.find(item => item.id === b.id)).toMatchObject({ name: 'B2', parentId: a.id })

    await repo.removeFile(sidecar.meta.id)
    await repo.removeFolder(b.id)
    snapshot = await repo.load()
    expect(snapshot.files).toEqual([])
    expect(snapshot.folders.map(item => item.id)).toEqual([a.id])
    expect(await repo.readContent(sidecar.meta.id)).toBe('')
    await expect(repo.readSidecar(sidecar.meta.id)).rejects.toThrow()
  })

  it('salva o índice (configurações) e cria um padrão na primeira abertura', async () => {
    const repo = freshRepo()
    const first = await repo.load()
    expect(first.index.settings).toEqual(defaultIndex().settings)
    await repo.saveIndex({ ...first.index, tags: ['prova'] })
    expect((await repo.load()).index.tags).toEqual(['prova'])
  })

  it('guarda e devolve fontes (blobs) e apaga depois', async () => {
    const repo = freshRepo()
    await repo.load()
    const stored = await repo.putSource('file-1', new Blob(['audio']))
    expect(await repo.getSource(stored.ref)).toBeTruthy()
    await repo.removeSource(stored.ref)
    await expect(repo.getSource(stored.ref)).rejects.toThrow()
  })
})

describe('separação de dados por conta', () => {
  beforeEach(() => {
    installMemoryStorage()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('cada conta do Google tem o seu próprio banco de cache e o perfil Local tem outro', async () => {
    const drive = new FakeDrive().install()
    const token = vi.fn(async () => 'tok')
    const first = uniqueAccount('a')
    const second = uniqueAccount('b')

    await useLibraryStore.getState().connect(first, token)
    const created = await useLibraryStore.getState().createFile({ name: 'Só da conta A', type: 'reading' }, 'texto A')

    await useLibraryStore.getState().connect(second, token)
    expect(useLibraryStore.getState().repo?.accountId).toBe(second)

    const names = (await indexedDB.databases()).map(item => item.name)
    expect(names).toContain(`study-helper-drive-${first}`)
    expect(names).toContain(`study-helper-drive-${second}`)
    expect(drive.one('md', created.id)).toBeTruthy()
  })

  it('o perfil Local não vê as notas de uma conta do Google e vice-versa', async () => {
    new FakeDrive().install()
    const token = vi.fn(async () => 'tok')
    const google = uniqueAccount('g')

    await useLibraryStore.getState().connect('local')
    const before = useLibraryStore.getState().files.map(file => file.id)
    const localFile = await useLibraryStore.getState().createFile({ name: 'Nota local', type: 'reading' }, 'local')

    await useLibraryStore.getState().connect(google, token)
    expect(useLibraryStore.getState().files.map(file => file.id)).not.toContain(localFile.id)
    const googleFile = await useLibraryStore.getState().createFile({ name: 'Nota google', type: 'reading' }, 'google')

    await useLibraryStore.getState().connect('local')
    const ids = useLibraryStore.getState().files.map(file => file.id)
    expect(ids).toEqual([...before, localFile.id])
    expect(ids).not.toContain(googleFile.id)
    await useLibraryStore.getState().deleteFileForever(localFile.id)
  })
})
