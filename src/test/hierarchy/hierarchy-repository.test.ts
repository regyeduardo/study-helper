// Spec 005 (FR-001, FR-011, FR-012, R7): a hierarquia mora no mapa da conta, com ou sem a estrutura do app. O navegador guarda uma
// cópia e uma fila: abre da cópia na hora e atualiza pelo seq; sem conexão grava na cópia e na fila; a fila sobe quando volta; um 409
// por rev mescla com a base; só a mesma coisa mudada dos dois lados vai para a janela de conflito de hoje.
import '@/test/account/storage-shim'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import 'fake-indexeddb/auto'

const { mockEnv } = vi.hoisted(() => ({ mockEnv: { apiUrl: 'https://api.example.test' } }))
vi.mock('@/lib/env', () => ({ env: mockEnv }))

import type { FolderMeta } from '@/types/domain'
import { hierarchyBackup, hierarchyDone } from '@/controllers/library-api.controller'
import { newFileMeta, newFolderMeta } from '@/lib/defaults'
import { HierarchyRepository } from '@/lib/storage/hierarchy-repository'
import { MapCache } from '@/lib/storage/map-cache'
import type { Conflict, JsonConflict } from '@/lib/storage/repository'
import { FakeAppServer } from '@/test/storage/fake-app-server'
import { uniqueAccount } from '@/test/storage/fake-drive'

let server: FakeAppServer
let account: string

beforeEach(() => {
  server = new FakeAppServer()
  // the hierarchy is for every account with a session, with the structure on or off
  server.appEnabled = false
  vi.stubGlobal('fetch', server.fetch)
  account = uniqueAccount()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

/** One device of the account: its own copy of the map in this browser. */
const device = (name: string) => new HierarchyRepository(account, new MapCache(`${account}-${name}`))
let clock = Date.parse('2026-11-23T10:00:00Z')
const touched = <T extends { updated: unknown }>(item: T, deviceName: string): T => ({ ...item, updated: { at: new Date((clock += 1000)).toISOString(), deviceId: deviceName, deviceName } })
const names = (folders: FolderMeta[]) => folders.map(folder => folder.name).sort()
const serverRow = (id: string) => server.rows.get(id)!

describe('a hierarquia na conta, sem a estrutura do app', () => {
  it('pasta vai sem lugar; nota vai com o lugar dela e o driveRef, sem o conteúdo', async () => {
    const a = device('a')
    await a.load()
    const faculdade = newFolderMeta({ name: 'Faculdade' })
    await a.saveFolder(faculdade)
    const aula = newFileMeta({ name: 'Aula 1', type: 'class', folderId: faculdade.id, sourceExcerpt: 'trecho da fonte' })
    await a.saveFile(aula, 'drive', 'drive-file-1')

    expect(serverRow(faculdade.id)).toMatchObject({ itemKind: 'folder', name: 'Faculdade', place: null })
    expect(serverRow(faculdade.id)).not.toHaveProperty('placeOwn')
    expect(serverRow(aula.id)).toMatchObject({ itemKind: 'file', name: 'Aula 1', folderId: faculdade.id, place: 'drive', driveRef: 'drive-file-1' })
    expect(JSON.stringify(serverRow(aula.id))).not.toContain('trecho da fonte')

    const snapshot = await device('b').load()
    expect(names(snapshot.folders)).toEqual(['Faculdade'])
    expect(snapshot.files.map(file => [file.name, file.folderId, file.place])).toEqual([['Aula 1', faculdade.id, 'drive']])
    expect(snapshot.folders[0].place).toBeUndefined()
  })

  it('nota no App sem a estrutura é recusada e nada fica na fila', async () => {
    const a = device('a')
    await a.load()
    const aula = newFileMeta({ name: 'Aula 1', type: 'class' })
    await expect(a.saveFile(aula, 'app')).rejects.toMatchObject({ code: 'app_off' })
    expect(await a.pending()).toBe(0)
    expect((await a.load()).files).toEqual([])
  })
})

describe('cópia no navegador', () => {
  it('abre da cópia na hora quando o servidor está fora, e depois atualiza pelo seq', async () => {
    const a = device('a')
    await a.load()
    const faculdade = newFolderMeta({ name: 'Faculdade' })
    await a.saveFolder(faculdade)
    await device('b').load()
    const seen = server.seq

    server.offline = true
    expect(names((await device('b').load()).folders)).toEqual(['Faculdade'])

    server.offline = false
    await a.saveFolder(newFolderMeta({ name: 'Trabalho' }))
    server.calls.length = 0
    // spec 007 (R3, T028): opening shows the copy at once, with no request; what changed since its seq comes right after
    const b = device('b')
    expect(names((await b.load()).folders)).toEqual(['Faculdade'])
    expect(server.calls).toEqual([])
    expect(names((await b.pullChanges()).snapshot.folders)).toEqual(['Faculdade', 'Trabalho'])
    const asked = server.calls.find(call => call.path === '/v1/library/map')!
    expect(new URLSearchParams(asked.query).get('since')).toBe(String(seen))
  })

  it('sem cópia e sem servidor, diz que não deu para abrir', async () => {
    server.offline = true
    await expect(device('a').load()).rejects.toMatchObject({ code: 'offline' })
  })
})

describe('sem conexão', () => {
  it('grava na cópia e na fila; reabrir sem conexão mostra o mesmo; nada chega ao servidor', async () => {
    const b = device('b')
    await b.load()
    const faculdade = newFolderMeta({ name: 'Faculdade' })
    await b.saveFolder(faculdade)

    server.offline = true
    const projeto = newFolderMeta({ name: 'Projeto Aurora' })
    await b.saveFolder(projeto)
    await b.saveFolder(touched({ ...faculdade, name: 'Faculdade 2026' }, 'B'))
    expect(names(b.snapshot().folders)).toEqual(['Faculdade 2026', 'Projeto Aurora'])
    expect(await b.pending()).toBe(2)

    const reopened = device('b')
    expect(names((await reopened.load()).folders)).toEqual(['Faculdade 2026', 'Projeto Aurora'])
    expect(server.rows.has(projeto.id)).toBe(false)
    expect(serverRow(faculdade.id).name).toBe('Faculdade')
  })

  it('a fila sobe sozinha quando a conexão volta, e o outro aparelho vê', async () => {
    const b = device('b')
    await b.load()
    const faculdade = newFolderMeta({ name: 'Faculdade' })
    await b.saveFolder(faculdade)
    server.offline = true
    const projeto = newFolderMeta({ name: 'Projeto Aurora' })
    await b.saveFolder(projeto)
    const kickoff = newFileMeta({ name: 'Kickoff', type: 'class', folderId: projeto.id })
    await b.saveFile(kickoff, 'drive', 'drive-kickoff')
    await b.remove(faculdade.id)

    server.offline = false
    await b.pullChanges()
    expect(await b.pending()).toBe(0)
    expect(serverRow(projeto.id).name).toBe('Projeto Aurora')
    expect(serverRow(kickoff.id)).toMatchObject({ folderId: projeto.id, place: 'drive', driveRef: 'drive-kickoff' })
    expect(serverRow(faculdade.id).removedAt).not.toBeNull()

    const a = device('a')
    const seen = await a.load()
    expect(names(seen.folders)).toEqual(['Projeto Aurora'])
    expect(seen.files.map(file => file.name)).toEqual(['Kickoff'])
  })
})

describe('mudou nos dois aparelhos', () => {
  it('campos diferentes se juntam sozinhos, sem perguntar (409 por rev)', async () => {
    const a = device('a')
    await a.load()
    const faculdade = newFolderMeta({ name: 'Faculdade' })
    await a.saveFolder(faculdade)
    const b = device('b')
    await b.load()
    const resolver = vi.fn(async (conflict: Conflict) => conflict)
    b.setConflictResolver(resolver)

    server.offline = true
    await b.saveFolder(touched({ ...faculdade, favorite: true, color: 'blue' as FolderMeta['color'] }, 'B'))
    server.offline = false
    await a.saveFolder(touched({ ...faculdade, name: 'Faculdade 2026' }, 'A'))

    await b.flush()
    expect(resolver).not.toHaveBeenCalled()
    expect(serverRow(faculdade.id).name).toBe('Faculdade 2026')
    expect(serverRow(faculdade.id).meta).toMatchObject({ name: 'Faculdade 2026', favorite: true, color: 'blue' })
    expect(b.snapshot().folders.find(folder => folder.id === faculdade.id)).toMatchObject({ name: 'Faculdade 2026', favorite: true })
  })

  it('o mesmo nome mudado dos dois lados vai para a janela de conflito, e o escolhido fica', async () => {
    const a = device('a')
    await a.load()
    const faculdade = newFolderMeta({ name: 'Faculdade' })
    await a.saveFolder(faculdade)
    const b = device('b')
    await b.load()
    let asked: JsonConflict | null = null
    b.setConflictResolver(async conflict => {
      asked = conflict as JsonConflict
      return { ...conflict, fields: (conflict as JsonConflict).fields.map(field => ({ ...field, choice: 'theirs' as const })) } as Conflict
    })

    server.offline = true
    await b.saveFolder(touched({ ...faculdade, name: 'Graduação', favorite: true }, 'B'))
    server.offline = false
    await a.saveFolder(touched({ ...faculdade, name: 'Faculdade 2026' }, 'A'))
    await b.flush()

    expect(asked).toMatchObject({ kind: 'json', fileId: faculdade.id, fields: [{ path: 'meta.name', label: 'Nome', mine: 'Graduação', theirs: 'Faculdade 2026' }] })
    expect(asked!.theirsStamp.deviceName).toBe('A')
    expect(serverRow(faculdade.id)).toMatchObject({ name: 'Faculdade 2026' })
    // what was not in conflict is kept
    expect(serverRow(faculdade.id).meta).toMatchObject({ favorite: true })
  })

  it('o mesmo nome de nota mudado dos dois lados pergunta também; ficar com a minha leva a minha', async () => {
    const a = device('a')
    await a.load()
    const kickoff = newFileMeta({ name: 'Kickoff', type: 'class' })
    await a.saveFile(kickoff, 'drive', 'drive-kickoff')
    const b = device('b')
    await b.load()
    const resolver = vi.fn(async (conflict: Conflict) => ({ ...conflict, fields: (conflict as JsonConflict).fields.map(field => ({ ...field, choice: 'mine' as const })) }) as Conflict)
    b.setConflictResolver(resolver)

    server.offline = true
    await b.saveFile(touched({ ...kickoff, name: 'Kickoff do B' }, 'B'), 'drive', 'drive-kickoff')
    server.offline = false
    await a.saveFile(touched({ ...kickoff, name: 'Kickoff do A' }, 'A'), 'drive', 'drive-kickoff')
    await b.flush()

    expect(resolver).toHaveBeenCalledTimes(1)
    expect(serverRow(kickoff.id).name).toBe('Kickoff do B')
  })
})

describe('contrato da migração', () => {
  it('a cópia de antes e o fim da migração', async () => {
    const backup = await hierarchyBackup({ folders: [{ id: 'f1' }], files: [] })
    expect(backup).toMatchObject({ folders: 1, files: 0 })
    expect((await hierarchyBackup({ folders: [{ id: 'f1' }], files: [] })).id).toBe(backup.id)
    await expect(hierarchyDone(backup.id, 1, 0)).rejects.toMatchObject({ status: 409, code: 'count_mismatch', data: { folders: 0, files: 0 } })
    const a = device('a')
    await a.load()
    await a.saveFolder(newFolderMeta({ name: 'Faculdade' }))
    const done = await hierarchyDone(backup.id, 1, 0)
    expect(done.hierarchyAt).toBe(server.hierarchyAt)
    expect((await hierarchyDone(backup.id, 5, 5)).hierarchyAt).toBe(done.hierarchyAt)
  })
})
