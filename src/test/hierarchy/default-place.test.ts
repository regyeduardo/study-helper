// Spec 005 (FR-006, FR-020, R6, R9): depois da migração (hierarchyAt), a árvore vem da hierarquia da conta e o conteúdo vai ao lugar da
// nota. Nota nova nasce no lugar escolhido ou no lugar padrão (App com a estrutura ligada; Google Drive com login Google; Local sem
// conta), nunca no "lugar da pasta". Nota em Local fica inteira neste navegador, numa pasta da hierarquia, e nunca vai ao servidor.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import 'fake-indexeddb/auto'
import { waitFor } from '@testing-library/react'

const { mockEnv } = vi.hoisted(() => ({ mockEnv: { apiUrl: 'https://api.example.test' } }))
vi.mock('@/lib/env', async importOriginal => ({ env: { ...((await importOriginal()) as { env: object }).env, apiUrl: mockEnv.apiUrl } }))

import type { ServerMe } from '@/controllers/api.controller'
import { newFileMeta, newFolderMeta, newSidecar } from '@/lib/defaults'
import { AppRepository } from '@/lib/storage/app-repository'
import { CombinedRepository } from '@/lib/storage/combined-repository'
import { DriveRepository } from '@/lib/storage/drive-repository'
import { HierarchyRepository } from '@/lib/storage/hierarchy-repository'
import { LocalRepository } from '@/lib/storage/local-repository'
import { MapCache } from '@/lib/storage/map-cache'
import { defaultPlace } from '@/lib/storage/place'
import { type Account, LOCAL_ACCOUNT, useAccountStore } from '@/stores/account'
import { useLibraryStore } from '@/stores/library'
import { useServerAccount } from '@/stores/server-account'
import { API, FakeAppServer } from '@/test/storage/fake-app-server'
import { FakeDrive, installMemoryStorage, uniqueAccount } from '@/test/storage/fake-drive'

const token = vi.fn(async () => 'tok')

let drive: FakeDrive
let server: FakeAppServer
let account: string

/** One device of a migrated account: its Drive (only content), this browser's Local and the account's hierarchy. */
function device(name = 'a', options: { app?: boolean } = {}) {
  const driveRepo = new DriveRepository(account, token, 'drive')
  const local = new LocalRepository(`study-helper-local-${account}-${name}`, account)
  const repo = new CombinedRepository(driveRepo, local)
  repo.setHierarchy(new HierarchyRepository(account, new MapCache(`${account}-${name}`)))
  if (options.app) repo.setApp(new AppRepository(account))
  return { repo, driveRepo, local }
}

const driveNames = () => [...drive.files.values()].map(file => file.name)
const mentions = (id: string) => server.calls.some(call => call.path.includes(id) || call.query.includes(id))

beforeEach(() => {
  installMemoryStorage()
  drive = new FakeDrive().install()
  const driveFetch = globalThis.fetch
  server = new FakeAppServer()
  server.appEnabled = false
  vi.stubGlobal('fetch', (input: string | URL | Request, init?: RequestInit) => (String(input).startsWith(API) ? server.fetch(input, init) : driveFetch(input, init)))
  vi.stubGlobal('WebSocket', class { send() {} close() {} })
  account = uniqueAccount()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('lugar padrão', () => {
  it('App com a estrutura ligada; Google Drive com login Google; Local sem conta', () => {
    expect(defaultPlace({ appOn: true, signedIn: true })).toBe('app')
    expect(defaultPlace({ appOn: false, signedIn: true })).toBe('drive')
    expect(defaultPlace({ appOn: false, signedIn: false })).toBe('local')
  })

  it('com a estrutura ligada, a nota nova nasce no App, mesmo numa pasta que antes era "Local"', async () => {
    server.appEnabled = true
    const { repo } = device('a', { app: true })
    await repo.load()
    const rascunhos = newFolderMeta({ name: 'Rascunhos', place: 'local' })
    await repo.saveFolder(rascunhos)
    const aula = newFileMeta({ name: 'Aula 1', type: 'class', folderId: rascunhos.id })
    const saved = await repo.saveFile(newSidecar(aula), 'derivadas')
    expect(repo.sideOf(aula.id)).toBe('app')
    expect(saved.meta.place).toBe('app')
    expect(server.rows.get(rascunhos.id)).toMatchObject({ itemKind: 'folder', place: null })
    expect(server.rows.get(aula.id)).toMatchObject({ itemKind: 'file', place: 'app', folderId: rascunhos.id })
    const other = device('b', { app: true })
    const seen = await other.repo.load()
    expect(seen.files.map(file => [file.name, file.folderId, file.place])).toEqual([['Aula 1', rascunhos.id, 'app']])
    expect(await other.repo.readContent(aula.id)).toBe('derivadas')
  })

  it('sem a estrutura, com Google, a nota nova nasce no Google Drive, numa pasta que antes era "Local"', async () => {
    const { repo } = device()
    await repo.load()
    const rascunhos = newFolderMeta({ name: 'Rascunhos', place: 'local' })
    await repo.saveFolder(rascunhos)
    const aula = newFileMeta({ name: 'Aula 1', type: 'class', folderId: rascunhos.id })
    await repo.saveFile(newSidecar(aula), 'derivadas')
    expect(repo.sideOf(aula.id)).toBe('drive')
    expect(server.rows.get(aula.id)).toMatchObject({ place: 'drive', folderId: rascunhos.id })
    expect(driveNames()).toContain('Aula 1.md')
    expect(driveNames()).not.toContain('Rascunhos')
  })

  it('o lugar escolhido na hora vale: Local fica neste navegador, na pasta da hierarquia, e nada vai ao servidor nem ao Drive', async () => {
    const { repo, local } = device()
    await repo.load()
    const faculdade = newFolderMeta({ name: 'Faculdade' })
    await repo.saveFolder(faculdade)
    const ideia = newFileMeta({ name: 'Ideia do TCC', type: 'class', folderId: faculdade.id, place: 'local' })
    await repo.saveFile(newSidecar(ideia), 'texto só daqui')
    expect(repo.sideOf(ideia.id)).toBe('local')
    expect((await local.load()).files.map(file => file.name)).toEqual(['Ideia do TCC'])
    expect(server.rows.has(ideia.id)).toBe(false)
    expect(mentions(ideia.id)).toBe(false)
    expect(driveNames().some(name => name.includes('Ideia do TCC'))).toBe(false)
    // renamed and moved, it still never leaves this browser
    await repo.saveFile(newSidecar({ ...ideia, name: 'Ideia do TCC 2', folderId: null }))
    expect(mentions(ideia.id)).toBe(false)

    const again = await repo.load()
    expect(again.files.find(file => file.id === ideia.id)).toMatchObject({ name: 'Ideia do TCC 2', folderId: null })
    expect(await repo.readContent(ideia.id)).toBe('texto só daqui')
    // another device of the account sees the folder, not the note
    const seen = await device('b').repo.load()
    expect(seen.folders.map(folder => folder.name)).toEqual(['Faculdade'])
    expect(seen.files).toEqual([])
  })

  it('nota em Local cuja pasta foi apagada de vez em outro aparelho aparece na raiz', async () => {
    const a = device('a')
    await a.repo.load()
    const projeto = newFolderMeta({ name: 'Projeto' })
    await a.repo.saveFolder(projeto)
    const ideia = newFileMeta({ name: 'Ideia', type: 'class', folderId: projeto.id, place: 'local' })
    await a.repo.saveFile(newSidecar(ideia), 'só daqui')

    const b = device('b')
    await b.repo.load()
    await b.repo.removeFolder(projeto.id)

    // spec 007 (R3, T028): opening shows the copy at once; the folder deleted elsewhere goes with what changed since its seq
    await a.repo.load()
    const seen = (await a.repo.pullChanges()).snapshot
    expect(seen.folders).toEqual([])
    expect(seen.files.find(file => file.id === ideia.id)?.folderId).toBeNull()
    expect(a.repo.lostFolder.has(ideia.id)).toBe(true)
  })
})

describe('na biblioteca', () => {
  const google = (id: string): Account => ({ id, kind: 'google', name: 'Ana', email: 'ana@example.com', picture: '', token: { accessToken: 'tok', expiresAt: Date.now() + 3600_000 } })
  const migrated = (): ServerMe => ({
    user: { id: 'u1', email: 'ana@example.com', name: 'Ana', photoUrl: null, status: 'no-code', appEnabled: false, admin: false, deleteAt: null, hasPassword: false, hasGoogle: true, hierarchyAt: '2026-11-23T12:00:00Z' },
    requireCode: false,
    device: { id: 'd1', name: 'Chrome no Linux' },
    space: { notes: 0, media: 0, reserved: 0, limit: 0, warnAt: 0.9 },
  })

  afterEach(() => {
    useAccountStore.setState({ activeId: LOCAL_ACCOUNT.id })
    useServerAccount.setState({ me: null, status: 'unknown' })
  })

  it('conta migrada: pasta nova vai para a hierarquia da conta, sem lugar e sem pasta no Drive; nota nova vai ao Drive', async () => {
    useAccountStore.setState({ accounts: [LOCAL_ACCOUNT, google(account)], activeId: account, reconnectId: null })
    useServerAccount.setState({ me: migrated(), status: 'signed-in' })
    await useLibraryStore.getState().connect(account, token)
    const repo = useLibraryStore.getState().repo as CombinedRepository
    expect(repo.hierarchy).toBeTruthy()
    const folder = await useLibraryStore.getState().createFolder({ name: 'Faculdade' })
    const note = await useLibraryStore.getState().createFile({ name: 'Aula 1', type: 'class', folderId: folder.id }, 'texto')
    expect(server.rows.get(folder.id)).toMatchObject({ itemKind: 'folder', place: null })
    expect(server.rows.get(note.id)).toMatchObject({ place: 'drive', folderId: folder.id })
    expect(driveNames()).not.toContain('Faculdade')
  })

  it('conta ainda não migrada (servidor sem a hierarquia): tudo como antes (a pasta vai ao Drive)', async () => {
    useAccountStore.setState({ accounts: [LOCAL_ACCOUNT, google(account)], activeId: account, reconnectId: null })
    useServerAccount.setState({ me: { ...migrated(), user: { ...migrated().user, hierarchyAt: undefined } }, status: 'signed-in' })
    await useLibraryStore.getState().connect(account, token)
    expect((useLibraryStore.getState().repo as CombinedRepository).hierarchy).toBeNull()
    await useLibraryStore.getState().createFolder({ name: 'Faculdade' })
    expect(driveNames()).toContain('Faculdade')
    expect([...server.rows.values()]).toEqual([])
  })

  it('a migração termina com a biblioteca aberta: a árvore passa a vir da conta', async () => {
    useAccountStore.setState({ accounts: [LOCAL_ACCOUNT, google(account)], activeId: account, reconnectId: null })
    // the migration itself is in migration-on-open.test.ts: here it ends elsewhere, so this opening does not start it
    useServerAccount.setState({ me: { ...migrated(), user: { ...migrated().user, hierarchyAt: undefined } }, status: 'signed-in' })
    await useLibraryStore.getState().connect(account, token)
    // another device already put a folder in the account's hierarchy
    const other = new HierarchyRepository(account, new MapCache(`${account}-outro`))
    await other.load()
    await other.saveFolder(newFolderMeta({ name: 'Faculdade' }))
    useServerAccount.setState({ me: migrated() })
    await waitFor(() => expect(useLibraryStore.getState().folders.map(folder => folder.name)).toEqual(['Faculdade']))
    expect((useLibraryStore.getState().repo as CombinedRepository).hierarchy).toBeTruthy()
  })

  it('sem conta (perfil Local), a nota nova fica neste navegador e nada vai ao servidor', async () => {
    await useLibraryStore.getState().connect(LOCAL_ACCOUNT.id)
    const note = await useLibraryStore.getState().createFile({ name: 'Só aqui', type: 'class', folderId: null }, 'texto')
    expect(useLibraryStore.getState().repo).toBeInstanceOf(LocalRepository)
    expect((await (useLibraryStore.getState().repo as LocalRepository).readSidecar(note.id)).meta.name).toBe('Só aqui')
    expect(server.calls).toEqual([])
  })
})
