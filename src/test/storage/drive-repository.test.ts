import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import 'fake-indexeddb/auto'

import type { FileSidecar } from '@/types/domain'
import { DriveError, listDriveFilesController } from '@/controllers/drive.controller'
import { newFileMeta, newFolderMeta, newSidecar } from '@/lib/defaults'
import { DriveRepository, INDEX_NAME, ROOT_NAME } from '@/lib/storage/drive-repository'
import { KeyValueStore } from '@/lib/storage/idb'
import { useLibraryStore } from '@/stores/library'

import { FakeDrive, FOLDER, installMemoryStorage, readBlob, uniqueAccount } from './fake-drive'

let drive: FakeDrive
const token = vi.fn(async (_options?: { force?: boolean }) => 'tok')

function sidecarNamed(name: string, folderId: string | null = null): FileSidecar {
  return newSidecar(newFileMeta({ name, type: 'reading', folderId }))
}

async function openRepo(accountId = uniqueAccount()): Promise<DriveRepository> {
  const repo = new DriveRepository(accountId, token)
  await repo.load()
  return repo
}

beforeEach(() => {
  installMemoryStorage()
  drive = new FakeDrive().install()
  token.mockClear()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('DriveRepository: estrutura no Google Drive', () => {
  it('cria a pasta .sync-study-helper na raiz com devices/, sources/ e study-helper.json', async () => {
    await openRepo()
    const root = drive.root()!
    expect(root.name).toBe(ROOT_NAME)
    expect(root.appProperties).toEqual({ shKind: 'root', shId: 'root' })
    const children = drive.childrenOf(root.id)
    expect(children.find(file => file.name === 'devices')).toMatchObject({ mimeType: FOLDER, appProperties: { shKind: 'devices' } })
    expect(children.find(file => file.name === 'sources')).toMatchObject({ mimeType: FOLDER, appProperties: { shKind: 'sources' } })
    const index = children.find(file => file.name === INDEX_NAME)!
    expect(index.appProperties).toEqual({ shKind: 'index', shId: 'index' })
    expect(JSON.parse(index.content!)).toMatchObject({ version: 1, settings: expect.any(Object), activities: [] })
  })

  it('reaproveita a pasta existente em vez de criar outra', async () => {
    await openRepo()
    await openRepo()
    expect([...drive.files.values()].filter(file => file.name === ROOT_NAME)).toHaveLength(1)
    expect(drive.byApp('devices')).toHaveLength(1)
    expect(drive.byApp('sources')).toHaveLength(1)
    expect(drive.byApp('index')).toHaveLength(1)
  })

  it('pasta vira pasta de verdade com .folder.json dentro; nota vira .md com .json ao lado', async () => {
    const repo = await openRepo()
    const folder = newFolderMeta({ name: 'Química' })
    await repo.saveFolder(folder)
    const sidecar = sidecarNamed('Ligações', folder.id)
    await repo.saveFile(sidecar, '# Ligações\n\niônica')

    const driveFolder = drive.one('folder', folder.id)
    expect(driveFolder.mimeType).toBe(FOLDER)
    expect(drive.pathOf(driveFolder.id)).toBe(`${ROOT_NAME}/Química`)
    const folderMeta = drive.one('folder-meta', folder.id)
    expect(drive.pathOf(folderMeta.id)).toBe(`${ROOT_NAME}/Química/.folder.json`)
    expect(JSON.parse(folderMeta.content!)).toMatchObject({ id: folder.id, name: 'Química' })

    const md = drive.one('md', sidecar.meta.id)
    const json = drive.one('sidecar', sidecar.meta.id)
    expect(drive.pathOf(md.id)).toBe(`${ROOT_NAME}/Química/Ligações.md`)
    expect(drive.pathOf(json.id)).toBe(`${ROOT_NAME}/Química/Ligações.json`)
    expect(md.content).toBe('# Ligações\n\niônica')
    expect(JSON.parse(json.content!)).toMatchObject({ meta: { id: sidecar.meta.id, name: 'Ligações' }, questions: [], attempts: [], highlights: [] })
  })

  it('grava na hora: cada saveFile já chega ao Drive antes de retornar', async () => {
    const repo = await openRepo()
    const sidecar = sidecarNamed('Rápida')
    await repo.saveFile(sidecar, 'um')
    expect(drive.one('md', sidecar.meta.id).content).toBe('um')
    await repo.saveFile(sidecar, 'dois')
    expect(drive.one('md', sidecar.meta.id).content).toBe('dois')
  })

  it('mover e renomear nota usa addParents/removeParents e renomeia .md e .json juntos', async () => {
    const repo = await openRepo()
    const a = newFolderMeta({ name: 'A' })
    const b = newFolderMeta({ name: 'B' })
    await repo.saveFolder(a)
    await repo.saveFolder(b)
    const sidecar = sidecarNamed('Nota', a.id)
    await repo.saveFile(sidecar, 'x')
    drive.requests = []

    await repo.saveFile({ ...sidecar, meta: { ...sidecar.meta, folderId: b.id, name: 'Nota nova' } })

    const patches = drive.requests.filter(request => request.method === 'PATCH')
    const driveA = drive.one('folder', a.id).id
    const driveB = drive.one('folder', b.id).id
    expect(patches.length).toBeGreaterThanOrEqual(2)
    for (const patch of patches) {
      expect(patch.search.get('addParents')).toBe(driveB)
      expect(patch.search.get('removeParents')).toBe(driveA)
    }
    expect(drive.pathOf(drive.one('md', sidecar.meta.id).id)).toBe(`${ROOT_NAME}/B/Nota nova.md`)
    expect(drive.pathOf(drive.one('sidecar', sidecar.meta.id).id)).toBe(`${ROOT_NAME}/B/Nota nova.json`)
    expect(drive.one('md', sidecar.meta.id).content).toBe('x')

    const snapshot = await (await openRepo()).load()
    expect(snapshot.files.find(file => file.id === sidecar.meta.id)).toMatchObject({ name: 'Nota nova', folderId: b.id })
  })

  it('mover e renomear pasta e apagar nota e pasta', async () => {
    const repo = await openRepo()
    const a = newFolderMeta({ name: 'A' })
    const b = newFolderMeta({ name: 'B' })
    await repo.saveFolder(a)
    await repo.saveFolder(b)
    await repo.saveFolder({ ...b, name: 'B2', parentId: a.id })
    expect(drive.pathOf(drive.one('folder', b.id).id)).toBe(`${ROOT_NAME}/A/B2`)
    expect(JSON.parse(drive.one('folder-meta', b.id).content!)).toMatchObject({ name: 'B2', parentId: a.id })

    const sidecar = sidecarNamed('Some', b.id)
    await repo.saveFile(sidecar, 'x')
    await repo.removeFile(sidecar.meta.id)
    expect(drive.byApp('md', sidecar.meta.id)).toEqual([])
    expect(drive.byApp('sidecar', sidecar.meta.id)).toEqual([])

    await repo.removeFolder(b.id)
    expect(drive.byApp('folder', b.id)).toEqual([])
    const snapshot = await (await openRepo()).load()
    expect(snapshot.folders.map(folder => folder.id)).toEqual([a.id])
  })

  it('só enxerga arquivos criados pelo app (appProperties) dentro da pasta do app', async () => {
    const repo = await openRepo()
    const root = drive.root()!
    drive.add({ name: 'minha-nota-manual.md', mimeType: 'text/markdown', parents: [root.id], content: 'manual' })
    drive.add({ name: 'Pasta manual', mimeType: FOLDER, parents: [root.id] })
    const outside = drive.add({ name: 'fora', mimeType: FOLDER, parents: [] })
    drive.add({ name: 'Intrusa.md', mimeType: 'text/markdown', parents: [outside.id], content: 'x', appProperties: { shKind: 'md', shId: 'intrusa' } })
    const snapshot = await repo.load()
    expect(snapshot.files).toEqual([])
    expect(snapshot.folders).toEqual([])
  })

  it('lista com q=trashed=false e pede os campos de appProperties e md5', async () => {
    await openRepo()
    const list = drive.requests.find(request => request.method === 'GET' && request.path === '/drive/v3/files')!
    expect(list.search.get('q')).toBe('trashed=false')
    expect(list.search.get('fields')).toContain('appProperties')
    expect(list.search.get('fields')).toContain('md5Checksum')
  })

  it('fontes vão para sources/ e voltam', async () => {
    const repo = await openRepo()
    const stored = await repo.putSource('file-1', new Blob(['bytes do audio'], { type: 'audio/mpeg' }), 'aula.mp3')
    const file = drive.files.get(stored.ref)!
    expect(drive.pathOf(file.id)).toBe(`${ROOT_NAME}/sources/file-1-aula.mp3`)
    expect(file.appProperties).toEqual({ shKind: 'source', shId: 'file-1' })
    expect(await readBlob(await repo.getSource(stored.ref))).toBe('bytes do audio')
    await repo.removeSource(stored.ref)
    expect(drive.files.has(stored.ref)).toBe(false)
  })

  it('dispositivos ficam em devices/<id>.json e a lista usa modifiedTime como visto por último', async () => {
    const repo = await openRepo()
    await repo.heartbeat({ id: 'dev-1', name: 'Chrome · Linux', lastSeen: '2000-01-01T00:00:00.000Z', accountId: repo.accountId })
    const file = drive.one('device', 'dev-1')
    expect(drive.pathOf(file.id)).toBe(`${ROOT_NAME}/devices/dev-1.json`)
    await repo.heartbeat({ id: 'dev-1', name: 'Chrome · Linux', lastSeen: '2000-01-01T00:00:00.000Z', accountId: repo.accountId })
    expect(drive.byApp('device', 'dev-1')).toHaveLength(1)

    const other = await openRepo(repo.accountId)
    const devices = await other.listDevices()
    expect(devices).toEqual([{ id: 'dev-1', name: 'Chrome · Linux', accountId: repo.accountId, lastSeen: drive.one('device', 'dev-1').modifiedTime }])

    await other.removeDevice('dev-1')
    expect(drive.byApp('device')).toEqual([])
  })
})

describe('DriveRepository: cache do conteúdo aberto (IndexedDB por conta, por md5)', () => {
  it('não baixa de novo o que já está em cache com o mesmo md5', async () => {
    const account = uniqueAccount()
    const repo = await openRepo(account)
    const sidecar = sidecarNamed('Cacheada')
    await repo.saveFile(sidecar, 'conteúdo')
    const md = drive.one('md', sidecar.meta.id)

    drive.requests = []
    const reloaded = await openRepo(account)
    expect(await reloaded.readContent(sidecar.meta.id)).toBe('conteúdo')
    expect(drive.mediaDownloads()).toEqual([])

    const cache = new KeyValueStore(`study-helper-drive-${account}`)
    const entry = await cache.get<{ md5: string; value: string }>('cache', `md:${sidecar.meta.id}`)
    expect(entry).toEqual({ md5: drive.meta(md).md5Checksum, value: 'conteúdo' })
  })

  it('outra conta não aproveita o cache (cada conta tem o seu banco)', async () => {
    const account = uniqueAccount()
    const repo = await openRepo(account)
    const sidecar = sidecarNamed('Compartilhada')
    await repo.saveFile(sidecar, 'conteúdo')
    const md = drive.one('md', sidecar.meta.id)

    const other = await openRepo(uniqueAccount())
    drive.requests = []
    expect(await other.readContent(sidecar.meta.id)).toBe('conteúdo')
    expect(drive.mediaDownloads(md.id)).toHaveLength(1)
  })
})

describe('DriveRepository: mão dupla (editar o .md direto no Drive)', () => {
  it('ao recarregar, o texto editado no Drive volta para o app', async () => {
    const account = uniqueAccount()
    const repo = await openRepo(account)
    const sidecar = sidecarNamed('Editada fora')
    await repo.saveFile(sidecar, 'original')
    drive.editContent(drive.one('md', sidecar.meta.id).id, 'editado no Drive')

    const reloaded = await openRepo(account)
    expect(await reloaded.readContent(sidecar.meta.id)).toBe('editado no Drive')
  })

  it('pullChanges aponta a nota mudada e a biblioteca descarta a versão aberta', async () => {
    const account = uniqueAccount()
    await useLibraryStore.getState().connect(account, token)
    const meta = await useLibraryStore.getState().createFile({ name: 'Sincronizada', type: 'reading' }, 'antes')
    expect((await useLibraryStore.getState().openFile(meta.id)).content).toBe('antes')

    drive.editContent(drive.one('md', meta.id).id, 'depois')
    const repo = useLibraryStore.getState().repo!
    const changes = await repo.pullChanges()
    expect(changes.changedFileIds).toEqual([meta.id])
    useLibraryStore.getState().applySnapshot(changes.snapshot, changes.changedFileIds)
    expect((await useLibraryStore.getState().openFile(meta.id)).content).toBe('depois')
  })

  it('renomear o .md no Drive muda o nome da nota no app', async () => {
    const account = uniqueAccount()
    const repo = await openRepo(account)
    const sidecar = sidecarNamed('Antigo')
    await repo.saveFile(sidecar, 'x')
    drive.one('md', sidecar.meta.id).name = 'Novo.md'
    const snapshot = await repo.load()
    expect(snapshot.files.find(file => file.id === sidecar.meta.id)?.name).toBe('Novo')
  })
})

describe('drive.controller: token expirado', () => {
  it('um 401 refaz o pedido uma vez com token({ force: true })', async () => {
    token.mockImplementation(async options => (options?.force ? 'novo' : 'velho'))
    drive.queuedStatuses = [401]
    const files = await listDriveFilesController(token, 'trashed=false')
    expect(files).toEqual([])
    expect(token).toHaveBeenCalledTimes(2)
    expect(token).toHaveBeenLastCalledWith({ force: true })
    expect(drive.requests.map(request => request.authorization)).toEqual(['Bearer velho', 'Bearer novo'])
    token.mockImplementation(async () => 'tok')
  })

  it('não entra em laço: dois 401 seguidos viram erro', async () => {
    drive.queuedStatuses = [401, 401]
    const failure = await listDriveFilesController(token, 'trashed=false').catch(error => error)
    expect(failure).toBeInstanceOf(DriveError)
    expect((failure as DriveError).status).toBe(401)
    expect(drive.requests).toHaveLength(2)
  })

  it('outros erros não pedem token novo', async () => {
    drive.queuedStatuses = [500]
    await expect(listDriveFilesController(token, 'trashed=false')).rejects.toBeInstanceOf(DriveError)
    expect(token).toHaveBeenCalledTimes(1)
  })
})
