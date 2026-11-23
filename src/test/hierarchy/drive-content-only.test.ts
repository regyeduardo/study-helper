// Spec 005 (R5, FR-015): depois da migração, o Google Drive só guarda conteúdo. Criar, renomear, mover e apagar pasta não mexe no
// Drive; nota nova no Drive vai para a pasta plana do espaço do app, e o mapa guarda o driveRef; mover uma nota de pasta não a move no
// Drive; a nota antiga continua onde está no Drive e abre igual.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import 'fake-indexeddb/auto'

const { mockEnv } = vi.hoisted(() => ({ mockEnv: { apiUrl: 'https://api.example.test' } }))
vi.mock('@/lib/env', async importOriginal => ({ env: { ...((await importOriginal()) as { env: object }).env, apiUrl: mockEnv.apiUrl } }))

import { newFileMeta, newFolderMeta, newSidecar } from '@/lib/defaults'
import { CombinedRepository } from '@/lib/storage/combined-repository'
import { DriveRepository } from '@/lib/storage/drive-repository'
import { HierarchyRepository } from '@/lib/storage/hierarchy-repository'
import { LocalRepository } from '@/lib/storage/local-repository'
import { MapCache } from '@/lib/storage/map-cache'
import { API, FakeAppServer } from '@/test/storage/fake-app-server'
import { FakeDrive, installMemoryStorage, uniqueAccount } from '@/test/storage/fake-drive'

const token = vi.fn(async () => 'tok')

let drive: FakeDrive
let server: FakeAppServer
let account: string

function device(name = 'a', options: { migrated?: boolean } = { migrated: true }) {
  const driveRepo = new DriveRepository(account, token, 'drive')
  const local = new LocalRepository(`study-helper-local-${account}-${name}`, account)
  const repo = new CombinedRepository(driveRepo, local)
  const hierarchy = new HierarchyRepository(account, new MapCache(`${account}-${name}`))
  if (options.migrated) repo.setHierarchy(hierarchy)
  return { repo, driveRepo, hierarchy }
}

/** What changed in the Drive (reading does not count). */
const driveWrites = () => drive.requests.filter(request => request.method !== 'GET')
const mdOf = (id: string) => drive.one('md', id)

beforeEach(() => {
  installMemoryStorage()
  drive = new FakeDrive().install()
  const driveFetch = globalThis.fetch
  server = new FakeAppServer()
  server.appEnabled = false
  vi.stubGlobal('fetch', (input: string | URL | Request, init?: RequestInit) => (String(input).startsWith(API) ? server.fetch(input, init) : driveFetch(input, init)))
  account = uniqueAccount()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('pastas não existem no Drive', () => {
  it('criar, renomear, mover e apagar pasta não mexe no Drive; a hierarquia da conta muda', async () => {
    const { repo } = device()
    await repo.load()
    const before = driveWrites().length
    const faculdade = newFolderMeta({ name: 'Faculdade' })
    const calculo = newFolderMeta({ name: 'Cálculo' })
    await repo.saveFolder(faculdade)
    await repo.saveFolder(calculo)
    await repo.saveFolder({ ...faculdade, name: 'Faculdade 2026' })
    await repo.saveFolder({ ...calculo, parentId: faculdade.id })
    await repo.saveFolder({ ...faculdade, name: 'Faculdade 2026', deletedAt: '2026-11-23T12:00:00Z' })
    await repo.removeFolder(calculo.id)
    expect(driveWrites().length).toBe(before)
    expect(drive.byApp('folder')).toEqual([])
    expect(server.rows.get(faculdade.id)).toMatchObject({ name: 'Faculdade 2026', trashedAt: '2026-11-23T12:00:00Z' })
    expect(server.rows.get(calculo.id)?.removedAt).not.toBeNull()
  })
})

describe('nota no Drive é só conteúdo', () => {
  it('nota nova vai para a pasta plana do espaço do app; o mapa guarda o driveRef e a pasta da hierarquia', async () => {
    const { repo } = device()
    await repo.load()
    const faculdade = newFolderMeta({ name: 'Faculdade' })
    const calculo = newFolderMeta({ name: 'Cálculo', parentId: faculdade.id })
    await repo.saveFolder(faculdade)
    await repo.saveFolder(calculo)
    const aula = newFileMeta({ name: 'Aula 1', type: 'class', folderId: calculo.id })
    await repo.saveFile(newSidecar(aula), 'derivadas')

    const md = mdOf(aula.id)
    const flat = drive.files.get(md.parents[0])!
    expect(flat.appProperties?.shKind).toBe('notes')
    expect(flat.parents).toEqual([drive.root()!.id])
    expect(drive.one('sidecar', aula.id).parents).toEqual(md.parents)
    expect(server.rows.get(aula.id)).toMatchObject({ place: 'drive', driveRef: md.id, folderId: calculo.id })

    // another device: the tree from the account, the content from the Drive
    const other = device('b')
    const seen = await other.repo.load()
    expect(seen.files.map(file => [file.name, file.folderId])).toEqual([['Aula 1', calculo.id]])
    expect(await other.repo.readContent(aula.id)).toBe('derivadas')
    expect((await other.repo.readSidecar(aula.id)).meta).toMatchObject({ name: 'Aula 1', folderId: calculo.id })
  })

  it('mover e renomear a nota muda só a hierarquia: o arquivo não sai da pasta plana', async () => {
    const { repo } = device()
    await repo.load()
    const faculdade = newFolderMeta({ name: 'Faculdade' })
    await repo.saveFolder(faculdade)
    const aula = newFileMeta({ name: 'Aula 1', type: 'class', folderId: null })
    await repo.saveFile(newSidecar(aula), 'derivadas')
    const parents = mdOf(aula.id).parents
    const before = driveWrites().length

    const sidecar = await repo.readSidecar(aula.id)
    await repo.saveFile({ ...sidecar, meta: { ...sidecar.meta, name: 'Aula 1 — limites', folderId: faculdade.id } })
    expect(driveWrites().length).toBe(before)
    expect(mdOf(aula.id).parents).toEqual(parents)
    expect(server.rows.get(aula.id)).toMatchObject({ name: 'Aula 1 — limites', folderId: faculdade.id })
    expect((await repo.load()).files.find(file => file.id === aula.id)).toMatchObject({ name: 'Aula 1 — limites', folderId: faculdade.id })
    expect((await repo.readSidecar(aula.id)).meta).toMatchObject({ name: 'Aula 1 — limites', folderId: faculdade.id })

    // a change of content goes to the Drive, still in the flat folder
    await repo.saveFile(await repo.readSidecar(aula.id), 'derivadas e limites')
    expect(mdOf(aula.id).parents).toEqual(parents)
    expect(mdOf(aula.id).content).toBe('derivadas e limites')
  })

  it('a nota antiga continua onde está no Drive e abre igual', async () => {
    // before the migration: the folder and the note are folders and files in the Drive
    const old = device('a', { migrated: false })
    await old.repo.load()
    const faculdade = newFolderMeta({ name: 'Faculdade' })
    await old.repo.saveFolder(faculdade)
    const aula = newFileMeta({ name: 'Aula 1', type: 'class', folderId: faculdade.id })
    await old.repo.saveFile(newSidecar(aula), 'derivadas')
    const where = mdOf(aula.id).parents
    // the migration puts them in the account (what T028–T030 do)
    await old.hierarchy.load()
    await old.hierarchy.saveFolder(faculdade)
    await old.hierarchy.saveFile(aula, 'drive', mdOf(aula.id).id)

    const { repo } = device('b')
    const seen = await repo.load()
    expect(seen.files.map(file => [file.name, file.folderId])).toEqual([['Aula 1', faculdade.id]])
    expect(await repo.readContent(aula.id)).toBe('derivadas')
    await repo.saveFile(await repo.readSidecar(aula.id), 'derivadas, revisto')
    expect(mdOf(aula.id).parents).toEqual(where)
    expect(mdOf(aula.id).content).toBe('derivadas, revisto')
    expect(drive.byApp('notes')).toEqual([])
  })
})

describe('o Drive fora do ar', () => {
  it('a hierarquia continua aparecendo inteira', async () => {
    const { repo } = device()
    await repo.load()
    const faculdade = newFolderMeta({ name: 'Faculdade' })
    await repo.saveFolder(faculdade)
    await repo.saveFile(newSidecar(newFileMeta({ name: 'Aula 1', type: 'class', folderId: faculdade.id })), 'derivadas')
    drive.driveFileGranted = false
    const seen = await device('b').repo.load()
    expect(seen.folders.map(folder => folder.name)).toEqual(['Faculdade'])
    expect(seen.files.map(file => file.name)).toEqual(['Aula 1'])
  })
})
