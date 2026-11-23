// Spec 005 (23/11, a janela "invalid_body" do dono): o texto do curso de uma pasta é conteúdo, não vai na linha da pasta no mapa
// (o servidor apaga e recusa corpo acima de 1 MB). Ele fica no lugar padrão da conta: App com a estrutura ligada, Google Drive sem
// ela. O que já existe continua sendo lido de onde está (a parte "course" do App, ou o .folder.json do Drive), e a migração passa.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import 'fake-indexeddb/auto'

const { mockEnv } = vi.hoisted(() => ({ mockEnv: { apiUrl: 'https://api.example.test' } }))
vi.mock('@/lib/env', async importOriginal => ({ env: { ...((await importOriginal()) as { env: object }).env, apiUrl: mockEnv.apiUrl } }))

import type { FolderMeta } from '@/types/domain'
import { newFolderMeta } from '@/lib/defaults'
import { AppRepository } from '@/lib/storage/app-repository'
import { CombinedRepository } from '@/lib/storage/combined-repository'
import { DriveRepository } from '@/lib/storage/drive-repository'
import { migrateHierarchy } from '@/lib/storage/hierarchy-migration'
import { HierarchyRepository } from '@/lib/storage/hierarchy-repository'
import { LocalRepository } from '@/lib/storage/local-repository'
import { MapCache } from '@/lib/storage/map-cache'
import { API, FakeAppServer } from '@/test/storage/fake-app-server'
import { FakeDrive, installMemoryStorage, uniqueAccount } from '@/test/storage/fake-drive'

const token = vi.fn(async () => 'tok')

let server: FakeAppServer
let account: string

/** A course whose material passes 1 MB, the case of the owner's library. */
const BIG = 'Módulo 1: fundamentos. '.repeat(60_000)

function course(name: string): FolderMeta {
  return { ...newFolderMeta({ name }), isCourse: true, courseOrigin: 'texto', courseDescription: `Curso ${name}`, courseMaterial: BIG }
}

function migrated(name: string, options: { app?: boolean } = {}) {
  const repo = new CombinedRepository(new DriveRepository(account, token, 'drive'), new LocalRepository(`study-helper-local-${account}-${name}`, account))
  repo.setHierarchy(new HierarchyRepository(account, new MapCache(`${account}-${name}`)))
  if (options.app) repo.setApp(new AppRepository(account))
  return repo
}

function today(options: { app?: boolean } = {}) {
  const repo = new CombinedRepository(new DriveRepository(account, token, 'drive'), new LocalRepository(`study-helper-local-${account}`, account))
  if (options.app) repo.setApp(new AppRepository(account))
  return repo
}

const folderNamed = (folders: FolderMeta[], name: string) => folders.find(folder => folder.name === name)!

beforeEach(() => {
  installMemoryStorage()
  new FakeDrive().install()
  const driveFetch = globalThis.fetch
  server = new FakeAppServer()
  server.appEnabled = false
  vi.stubGlobal('fetch', (input: string | URL | Request, init?: RequestInit) => (String(input).startsWith(API) ? server.fetch(input, init) : driveFetch(input, init)))
  vi.stubGlobal('WebSocket', class { send() {} close() {} })
  account = uniqueAccount()
})

afterEach(() => vi.unstubAllGlobals())

describe('Texto do curso de uma pasta', () => {
  it('sem a estrutura: vai para o Google Drive, não para a linha da pasta; outro aparelho lê', async () => {
    server.hierarchyAt = '2026-11-23T12:00:00Z'
    const a = migrated('a')
    await a.load()
    const calculo = course('Cálculo I')
    await a.saveFolder(calculo)
    expect(server.rows.get(calculo.id)?.meta).not.toHaveProperty('courseMaterial', BIG)
    const seen = await migrated('b').load()
    expect(folderNamed(seen.folders, 'Cálculo I')).toMatchObject({ isCourse: true, courseDescription: 'Curso Cálculo I', courseMaterial: BIG })
  })

  it('com a estrutura: vai para o App (parte "course"); outro aparelho lê', async () => {
    server.hierarchyAt = '2026-11-23T12:00:00Z'
    server.appEnabled = true
    const a = migrated('a', { app: true })
    await a.load()
    const claude = course('Claude Certified Architect')
    await a.saveFolder(claude)
    expect(server.rows.get(claude.id)?.parts.course).toBeTruthy()
    const seen = await migrated('b', { app: true }).load()
    expect(folderNamed(seen.folders, 'Claude Certified Architect')).toMatchObject({ courseDescription: 'Curso Claude Certified Architect', courseMaterial: BIG })
  })

  it('curso de hoje no Google Drive com material acima de 1 MB: a migração passa e o texto continua lido de onde está', async () => {
    const repo = today()
    await repo.load()
    await repo.saveFolder(course('Física II'))
    const snapshot = await repo.load()
    await expect(migrateHierarchy(repo, snapshot)).resolves.toEqual({ folders: 1, files: 0 })
    const seen = await migrated('b').load()
    expect(folderNamed(seen.folders, 'Física II')).toMatchObject({ courseDescription: 'Curso Física II', courseMaterial: BIG })
  })

  it('curso de hoje no App: depois da migração, o texto continua lido do App', async () => {
    server.appEnabled = true
    const repo = today({ app: true })
    await repo.load()
    await repo.saveFolder({ ...course('Inglês'), place: 'app' })
    const snapshot = await repo.load()
    await migrateHierarchy(repo, snapshot)
    const seen = await migrated('b', { app: true }).load()
    expect(folderNamed(seen.folders, 'Inglês')).toMatchObject({ courseDescription: 'Curso Inglês', courseMaterial: BIG })
  })
})
