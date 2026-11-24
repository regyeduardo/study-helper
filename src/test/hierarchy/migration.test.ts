// Spec 005, história 2 (FR-013 a FR-016): a hierarquia de hoje vai para a conta uma vez, com cópia antes, sem mover conteúdo,
// retomando de onde parou sem duplicar; as notas em Local ficam neste navegador; a contagem confere antes de marcar.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import 'fake-indexeddb/auto'

const { mockEnv } = vi.hoisted(() => ({ mockEnv: { apiUrl: 'https://api.example.test' } }))
vi.mock('@/lib/env', async importOriginal => ({ env: { ...((await importOriginal()) as { env: object }).env, apiUrl: mockEnv.apiUrl } }))

import type { FileMeta, FolderMeta } from '@/types/domain'
import { newFileMeta, newFolderMeta, newSidecar } from '@/lib/defaults'
import { AppRepository } from '@/lib/storage/app-repository'
import { CombinedRepository } from '@/lib/storage/combined-repository'
import { DriveRepository } from '@/lib/storage/drive-repository'
import { HierarchyRepository } from '@/lib/storage/hierarchy-repository'
import { MigrationCountError, migrateHierarchy } from '@/lib/storage/hierarchy-migration'
import { LocalRepository } from '@/lib/storage/local-repository'
import { MapCache } from '@/lib/storage/map-cache'
import { API, FakeAppServer } from '@/test/storage/fake-app-server'
import { FakeDrive, installMemoryStorage, uniqueAccount } from '@/test/storage/fake-drive'

const token = vi.fn(async () => 'tok')

let drive: FakeDrive
let server: FakeAppServer
let account: string
let failPutAfter: number | null

/** The library of today (before the migration): the account's Drive, this browser's Local and, with the structure, the App. */
function today(options: { app?: boolean } = {}) {
  const repo = new CombinedRepository(new DriveRepository(account, token, 'drive'), new LocalRepository(`study-helper-local-${account}`, account))
  if (options.app) repo.setApp(new AppRepository(account))
  return repo
}

/** Another device after the migration: the tree from the account's hierarchy. */
function migratedDevice(options: { app?: boolean } = {}) {
  const repo = new CombinedRepository(new DriveRepository(account, token, 'drive'), new LocalRepository(`study-helper-local-${account}-b`, account))
  repo.setHierarchy(new HierarchyRepository(account, new MapCache(`${account}-b`)))
  if (options.app) repo.setApp(new AppRepository(account))
  return repo
}

/** Faculdade › Cálculo I › Listas, with notes in the Drive (one with a child note), a Local note and a Local folder. */
async function library(repo: CombinedRepository) {
  await repo.load()
  const faculdade = newFolderMeta({ name: 'Faculdade' })
  const calculo = newFolderMeta({ name: 'Cálculo I', parentId: faculdade.id })
  const listas = newFolderMeta({ name: 'Listas', parentId: calculo.id })
  const rascunhos = newFolderMeta({ name: 'Rascunhos', place: 'local' })
  for (const folder of [faculdade, calculo, listas, rascunhos]) await repo.saveFolder(folder)
  const aula = newFileMeta({ name: 'Aula 12 — Integrais por partes', type: 'class', folderId: calculo.id })
  const explicacao = newFileMeta({ name: 'Explicação: integração por partes', type: 'class', folderId: calculo.id, parentFileId: aula.id })
  const lista = newFileMeta({ name: 'Lista de exercícios 3', type: 'class', folderId: listas.id })
  const ideia = newFileMeta({ name: 'Ideia solta', type: 'class', folderId: rascunhos.id, place: 'local' })
  for (const [meta, text] of [
    [aula, 'derivadas'],
    [explicacao, 'por partes'],
    [lista, 'exercícios'],
    [ideia, 'rascunho'],
  ] as [FileMeta, string][])
    await repo.saveFile(newSidecar(meta), text)
  const snapshot = await repo.load()
  return { folders: [faculdade, calculo, listas, rascunhos] as FolderMeta[], drive: [aula, explicacao, lista], ideia, snapshot }
}

const live = () => [...server.rows.values()].filter(row => !row.removedAt)

beforeEach(() => {
  installMemoryStorage()
  drive = new FakeDrive().install()
  const driveFetch = globalThis.fetch
  server = new FakeAppServer()
  server.appEnabled = false
  failPutAfter = null
  let puts = 0
  vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
    if (!String(input).startsWith(API)) return driveFetch(input, init)
    if (init?.method === 'PUT' && String(input).includes('/v1/library/items/') && failPutAfter !== null && ++puts > failPutAfter) throw new TypeError('Failed to fetch')
    return server.fetch(input, init)
  })
  vi.stubGlobal('WebSocket', class { send() {} close() {} })
  account = uniqueAccount()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('migração da hierarquia', () => {
  it('guarda a cópia, leva pastas e notas do Drive, deixa Local no navegador e marca no fim', async () => {
    const repo = today()
    const { folders, drive: notes, ideia, snapshot } = await library(repo)
    const driveFilesBefore = drive.files.size
    const count = await migrateHierarchy(repo, snapshot)
    expect(count).toEqual({ folders: 4, files: 3 })
    expect(server.backup).toMatchObject({ folders: 4, files: 3 })
    expect(live().filter(row => row.itemKind === 'folder').map(row => row.id).sort()).toEqual(folders.map(folder => folder.id).sort())
    expect(live().filter(row => row.itemKind === 'folder').every(row => row.place === null)).toBe(true)
    expect(live().filter(row => row.itemKind === 'file').map(row => row.id).sort()).toEqual(notes.map(note => note.id).sort())
    expect(live().filter(row => row.itemKind === 'file').every(row => row.place === 'drive' && row.driveRef)).toBe(true)
    expect(server.rows.has(ideia.id)).toBe(false)
    expect(server.hierarchyAt).toBeTruthy()
    // no content moved: the Drive has the same files, and every note opens from where it was
    expect(drive.files.size).toBe(driveFilesBefore)
    expect(await repo.readContent(notes[0].id)).toBe('derivadas')
    expect(await repo.readContent(ideia.id)).toBe('rascunho')
  })

  it('outro aparelho, depois, vê a mesma hierarquia e abre as notas do Drive', async () => {
    const repo = today()
    const { drive: notes, ideia, snapshot } = await library(repo)
    await migrateHierarchy(repo, snapshot)
    const other = migratedDevice()
    const seen = await other.load()
    expect(seen.folders.map(folder => folder.name).sort()).toEqual(['Cálculo I', 'Faculdade', 'Listas', 'Rascunhos'])
    expect(seen.files.map(file => file.name).sort()).toEqual(notes.map(note => note.name).sort())
    expect(seen.files.some(file => file.id === ideia.id)).toBe(false)
    expect(seen.files.find(file => file.id === notes[1].id)?.parentFileId).toBe(notes[0].id)
    expect(await other.readContent(notes[2].id)).toBe('exercícios')
  })

  it('interrompida no meio, continua de onde parou sem duplicar', async () => {
    const repo = today()
    const { snapshot } = await library(repo)
    failPutAfter = 3
    await expect(migrateHierarchy(repo, snapshot)).rejects.toThrow()
    expect(server.hierarchyAt).toBeNull()
    const backup = server.backup!.id
    failPutAfter = null
    const count = await migrateHierarchy(repo, snapshot)
    expect(count).toEqual({ folders: 4, files: 3 })
    expect(server.backup!.id).toBe(backup)
    expect(live()).toHaveLength(7)
    expect(server.hierarchyAt).toBeTruthy()
  })

  it('com a estrutura ligada, as notas do App já estão na conta e não são mandadas de novo', async () => {
    server.appEnabled = true
    const repo = today({ app: true })
    await repo.load()
    const atas = newFolderMeta({ name: 'Atas', place: 'app' })
    await repo.saveFolder(atas)
    const ata = newFileMeta({ name: 'Ata do kickoff', type: 'class', folderId: atas.id })
    await repo.saveFile(newSidecar(ata), 'decisões')
    // in the Google Drive by choice: with the structure on, a note made without a place is born in the App
    const plano = newFileMeta({ name: 'Plano 2027', type: 'class', folderId: null, place: 'drive' })
    await repo.saveFile(newSidecar(plano), 'plano')
    const snapshot = await repo.load()
    expect(repo.sideOf(ata.id)).toBe('app')
    expect(repo.sideOf(plano.id)).toBe('drive')
    const putsBefore = server.calls.filter(call => call.method === 'PUT' && call.path === `/v1/library/items/${ata.id}`).length
    await migrateHierarchy(repo, snapshot)
    expect(server.calls.filter(call => call.method === 'PUT' && call.path === `/v1/library/items/${ata.id}`)).toHaveLength(putsBefore)
    expect(server.rows.get(ata.id)).toMatchObject({ place: 'app' })
    expect(server.rows.get(plano.id)).toMatchObject({ place: 'drive' })
    expect(server.rows.get(atas.id)).toMatchObject({ itemKind: 'folder' })
    expect(server.hierarchyAt).toBeTruthy()
  })

  it('contagem que não bate não marca nada e diz por quê', async () => {
    const repo = today()
    const { snapshot } = await library(repo)
    // an extra row on the map that this browser does not have
    server.rows.set('estranha', { ...structuredClone([...server.rows.values()][0] ?? {}), id: 'estranha', itemKind: 'folder', name: 'Estranha', place: null, removedAt: null } as never)
    await expect(migrateHierarchy(repo, snapshot)).rejects.toBeInstanceOf(MigrationCountError)
    expect(server.hierarchyAt).toBeNull()
  })
})
