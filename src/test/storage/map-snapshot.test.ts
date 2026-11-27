// Spec 007, história 1 (T027, research R3, FR-005): o aparelho que já abriu a conta mostra a biblioteca na hora, pelo retrato do mapa
// guardado nele (spec 005: as linhas e o seq no IndexedDB), sem esperar a rede; o que mudou desde esse seq vem logo depois (o canal ao
// vivo diz o seq ao servidor, ou a consulta a cada 15 s), pedindo só getMap(seq), e junta sem mudar a ordem do que está à vista. Sem
// internet abre pelo retrato; sair da conta apaga o retrato. O aparelho novo (sem retrato) busca o mapa inteiro, como antes.
import '@/test/account/storage-shim'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import 'fake-indexeddb/auto'

const { mockEnv } = vi.hoisted(() => ({ mockEnv: { apiUrl: 'https://api.example.test' } }))
vi.mock('@/lib/env', () => ({ env: mockEnv }))

import { newFolderMeta } from '@/lib/defaults'
import { HierarchyRepository } from '@/lib/storage/hierarchy-repository'
import { MapCache } from '@/lib/storage/map-cache'
import { FakeAppServer } from '@/test/storage/fake-app-server'
import { uniqueAccount } from '@/test/storage/fake-drive'

let server: FakeAppServer
let account: string

beforeEach(() => {
  server = new FakeAppServer()
  server.appEnabled = false
  vi.stubGlobal('fetch', server.fetch)
  account = uniqueAccount()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

const device = (name: string) => new HierarchyRepository(account, new MapCache(`${account}-${name}`))
/** The seq each request of the map asked from. */
const mapSince = () => server.calls.filter(call => call.path === '/v1/library/map').map(call => new URLSearchParams(call.query).get('since'))
const names = (snapshot: { folders: { name: string }[] }) => snapshot.folders.map(folder => folder.name)

/** A device that already opened the account once and kept the copy, with two folders made elsewhere. */
async function openedBefore() {
  const other = device('outro')
  await other.load()
  await other.saveFolder(newFolderMeta({ name: 'Faculdade' }))
  await other.saveFolder(newFolderMeta({ name: 'Trabalho' }))
  const mine = device('meu')
  await mine.load()
  return { other, mine: () => device('meu') }
}

describe('abrir pelo retrato do mapa', () => {
  it('o aparelho que já abriu mostra a biblioteca do retrato, sem nenhum pedido à rede', async () => {
    const { mine } = await openedBefore()
    server.calls.length = 0
    const snapshot = await mine().load()
    expect(names(snapshot).sort()).toEqual(['Faculdade', 'Trabalho'])
    expect(server.calls).toEqual([])
  })

  it('depois pede só o que mudou desde o seq do retrato e junta sem mudar a ordem do que está à vista', async () => {
    const { other, mine } = await openedBefore()
    await other.saveFolder(newFolderMeta({ name: 'Viagens' }))
    const repo = mine()
    const opened = await repo.load()
    const before = names(opened)
    const seq = repo.currentSeq
    server.calls.length = 0
    const { snapshot } = await repo.pullChanges()
    expect(mapSince()).toEqual([String(seq)])
    expect(names(snapshot).slice(0, before.length)).toEqual(before)
    expect(names(snapshot)).toContain('Viagens')
  })

  it('sem internet abre pelo retrato', async () => {
    const { mine } = await openedBefore()
    server.offline = true
    expect(names(await mine().load()).sort()).toEqual(['Faculdade', 'Trabalho'])
  })

  it('o aparelho novo busca o mapa inteiro, como antes', async () => {
    await openedBefore()
    server.calls.length = 0
    expect(names(await device('novo').load()).sort()).toEqual(['Faculdade', 'Trabalho'])
    expect(mapSince()).toEqual(['0'])
  })

  // what this device wrote right after the seq it has moves the copy along: opening again does not bring back its own changes (they
  // landed on the next operation, 26/11); with a change of another device in between, the copy stays and the next pull brings both
  it('o que o próprio aparelho escreve logo depois do seq do retrato o faz avançar; com outro aparelho no meio, não', async () => {
    const { other, mine } = await openedBefore()
    const repo = mine()
    await repo.load()
    const before = repo.currentSeq
    await repo.saveFolder(newFolderMeta({ name: 'Minha' }))
    expect(repo.currentSeq).toBe(before + 1)
    expect(await new MapCache(`${account}-meu`).seq()).toBe(before + 1)
    await other.saveFolder(newFolderMeta({ name: 'Dele' }))
    await repo.saveFolder(newFolderMeta({ name: 'Outra minha' }))
    expect(repo.currentSeq).toBe(before + 1)
    server.calls.length = 0
    const { snapshot } = await repo.pullChanges()
    expect(mapSince()).toEqual([String(before + 1)])
    expect(names(snapshot)).toEqual(expect.arrayContaining(['Minha', 'Dele', 'Outra minha']))
  })

  // the phone, 26/11: on a new device the opening, the hierarchy turned on by the session and the first sync each asked the whole map
  // (1.1 MB), three times at once on the mobile network; now one load serves them all and the sync asks only what came after it
  it('num aparelho novo, duas cargas e uma sincronização ao mesmo tempo pedem o mapa inteiro uma vez só', async () => {
    await openedBefore()
    const repo = device('novo')
    server.calls.length = 0
    const [first, second, pulled] = await Promise.all([repo.load(), repo.load(), repo.pullChanges()])
    expect(mapSince().filter(since => since === '0')).toHaveLength(1)
    expect(names(first).sort()).toEqual(['Faculdade', 'Trabalho'])
    expect(names(second).sort()).toEqual(['Faculdade', 'Trabalho'])
    expect(names(pulled.snapshot).sort()).toEqual(['Faculdade', 'Trabalho'])
  })

  it('sair da conta apaga o retrato', async () => {
    const { mine } = await openedBefore()
    const repo = mine()
    await repo.load()
    await repo.forget()
    expect(await new MapCache(`${account}-meu`).hasCopy()).toBe(false)
  })
})
