// Locais com a janela que trava o app (escolha F do dono, 21/11/2026): "Levar para…" mostra a janela desde o clique, com a etapa,
// a contagem e o item da vez; Cancelar para entre itens, e o que não foi fica onde estava, dito na tela.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import 'fake-indexeddb/auto'

const { mockEnv } = vi.hoisted(() => ({ mockEnv: { apiUrl: 'https://api.example.test' } }))
vi.mock('@/lib/env', async importOriginal => ({ env: { ...((await importOriginal()) as { env: object }).env, apiUrl: mockEnv.apiUrl } }))

import type { FileMeta } from '@/types/domain'
import type { ServerMe } from '@/controllers/api.controller'
import { CombinedRepository } from '@/lib/storage/combined-repository'
import { MoveJournal, planMoves } from '@/lib/storage/moves'
import { type Account, LOCAL_ACCOUNT, useAccountStore } from '@/stores/account'
import { type BlockingOp, useBlockingStore } from '@/stores/blocking'
import { useLibraryStore } from '@/stores/library'
import { usePlacesStore } from '@/stores/places'
import { useServerAccount } from '@/stores/server-account'
import { useUiStore } from '@/stores/ui'
import { FakeAppServer } from '@/test/storage/fake-app-server'
import { FakeDrive, installMemoryStorage, uniqueAccount } from '@/test/storage/fake-drive'

const token = vi.fn(async () => 'tok')
const library = () => useLibraryStore.getState()
const repo = () => library().repo as CombinedRepository

let account: string
let server: FakeAppServer
/** Every state the window went through. */
let seen: BlockingOp[]
let stopSeeing: () => void

function google(id: string): Account {
  return { id, kind: 'google', name: 'Ana', email: 'ana@example.com', picture: '', token: { accessToken: 'at-1', expiresAt: Date.now() + 3600_000 } }
}

const freed: ServerMe = {
  user: { id: 'u1', email: 'ana@example.com', name: 'Ana', photoUrl: null, status: 'enabled', appEnabled: true, admin: false, deleteAt: null, hasPassword: false, hasGoogle: true },
  requireCode: true,
  device: { id: 'd1', name: 'Chrome no Linux' },
  space: { notes: 0, media: 0, reserved: 0, limit: 10 * 1024 ** 3, warnAt: 0.9 },
}

const toasts = () => useUiStore.getState().toasts.map(toast => toast.text)

beforeEach(async () => {
  installMemoryStorage()
  new FakeDrive().install()
  const driveFetch = globalThis.fetch
  server = new FakeAppServer()
  vi.stubGlobal('fetch', (input: string | URL | Request, init?: RequestInit) => (String(input).startsWith(mockEnv.apiUrl) ? server.fetch(input, init) : driveFetch(input, init)))
  vi.stubGlobal('WebSocket', class { send() {} close() {} })
  account = uniqueAccount()
  useUiStore.setState({ overlay: null, toasts: [] })
  usePlacesStore.setState({ running: false, progress: null, failed: [] })
  useBlockingStore.setState({ ops: [] })
  useAccountStore.setState({ accounts: [LOCAL_ACCOUNT, google(account)], activeId: account, reconnectId: null })
  useServerAccount.setState({ me: freed, status: 'signed-in' })
  await library().connect(account, token)
  seen = []
  stopSeeing = useBlockingStore.subscribe(state => {
    const op = state.ops.at(-1)
    if (op) seen.push({ ...op })
  })
})

afterEach(() => {
  stopSeeing()
  vi.unstubAllGlobals()
  useAccountStore.setState({ activeId: LOCAL_ACCOUNT.id })
  useServerAccount.setState({ me: null, status: 'unknown' })
})

/** Notes of the Google Drive made before the structure was on, without a place of their own: a note made now would be born in the App. */
async function madeBeforeTheApp<T>(make: () => Promise<T>): Promise<T> {
  await library().attachApp(false)
  const made = await make()
  await library().attachApp(true)
  // the windows of setting up are not what the test looks at
  seen = []
  return made
}

/** Faculdade (Drive) with 3 notes. */
async function faculdade() {
  return madeBeforeTheApp(async () => {
    const folder = await library().createFolder({ name: 'Faculdade' })
    const notes = []
    for (const name of ['Aula 1', 'Aula 2', 'Aula 3']) notes.push(await library().createFile({ name, type: 'class', folderId: folder.id }, `texto de ${name}`))
    return { folder, notes }
  })
}

describe('Levar para o App com a janela', () => {
  it('a janela abre no clique, antes de gravar a escolha, e passa pelas etapas com contagem e o item da vez', async () => {
    const { folder } = await faculdade()
    const moving = usePlacesStore.getState().choosePlace([folder.id], 'app')
    // the same instant of the click: nothing written yet, the window is already there
    expect(useBlockingStore.getState().ops).toHaveLength(1)
    expect(useBlockingStore.getState().ops[0]).toMatchObject({ title: 'Levando para o App', phase: 'Gravando a escolha', cancellable: true })
    await moving
    expect(useBlockingStore.getState().ops).toHaveLength(0)
    const copying = seen.filter(op => op.phase === 'Levando as notas')
    expect(copying.length).toBeGreaterThan(0)
    // the folder and its 3 notes
    expect(copying.at(-1)).toMatchObject({ total: 4, done: 4 })
    expect(new Set(copying.map(op => op.current))).toEqual(new Set(['Faculdade', 'Aula 1', 'Aula 2', 'Aula 3']))
    expect(seen.some(op => op.phase === 'Atualizando a biblioteca')).toBe(true)
    expect(toasts()).toContain('Pronto: 3 notas no App')
  })

  it('Cancelar no meio: para depois da nota da vez; o que não foi fica no Drive, dito como escolha própria, e não volta sozinho', async () => {
    const { folder, notes } = await faculdade()
    const stop = useBlockingStore.subscribe(state => {
      const op = state.ops.at(-1)
      if (op?.phase === 'Levando as notas' && op.done === 1 && !op.cancelling) useBlockingStore.getState().cancel(op.id)
    })
    await usePlacesStore.getState().choosePlace([folder.id], 'app')
    stop()
    const sides = notes.map(note => repo().sideOf(note.id))
    expect(sides.filter(side => side === 'app')).toHaveLength(1)
    expect(sides.filter(side => side === 'drive')).toHaveLength(2)
    // every note still opens, wherever it is
    for (const note of notes) expect(await repo().readContent(note.id)).toBe(`texto de ${note.name}`)
    // the ones that stayed say so: an own choice of the Google Drive (the folder now is in the App)
    const stayed = library().files.filter(file => notes.some(note => note.id === file.id) && repo().sideOf(file.id) === 'drive')
    expect(stayed.map(file => file.place)).toEqual(['drive', 'drive'])
    // nothing left in the journal to resume on the next opening
    expect((await new MoveJournal(account).all()).filter(record => record.state !== 'feito')).toEqual([])
    expect(toasts()).toContain('Parou: 1 nota foi para o App; o resto ficou onde estava.')
    expect(useBlockingStore.getState().ops).toHaveLength(0)
  })

  it('Cancelar enquanto grava a escolha: desfaz as escolhas gravadas e nada muda de lugar', async () => {
    const notes: FileMeta[] = []
    await madeBeforeTheApp(async () => {
      for (const name of ['Nota A', 'Nota B', 'Nota C']) notes.push(await library().createFile({ name, type: 'class', folderId: null }, name))
    })
    const stop = useBlockingStore.subscribe(state => {
      const op = state.ops.at(-1)
      if (op?.phase === 'Gravando a escolha' && op.done === 1 && !op.cancelling) useBlockingStore.getState().cancel(op.id)
    })
    await usePlacesStore.getState().choosePlace(notes.map(note => note.id), 'app')
    stop()
    expect(notes.map(note => repo().sideOf(note.id))).toEqual(['drive', 'drive', 'drive'])
    expect(library().files.filter(file => notes.some(note => note.id === file.id)).map(file => file.place)).toEqual([undefined, undefined, undefined])
    expect(await new MoveJournal(account).all()).toEqual([])
    expect(toasts()).toContain('Parou: nada mudou de lugar.')
  })

  it('uma mudança que ficou pela metade continua ao abrir o app, com a janela "Continuando a mudança de lugar"', async () => {
    const { folder, notes } = await faculdade()
    // the tab closed after the choice was written: only the journal knows the rest
    await library().updateFolder(folder.id, { place: 'app' })
    const journal = new MoveJournal(account)
    for (const record of planMoves(repo(), { folders: library().folders, files: library().files }, [folder.id], 'app', 'lote', () => 1)) await journal.put(record)
    await usePlacesStore.getState().resume()
    expect(seen[0]).toMatchObject({ title: 'Continuando a mudança de lugar', cancellable: true })
    expect(notes.map(note => repo().sideOf(note.id))).toEqual(['app', 'app', 'app'])
    expect(useBlockingStore.getState().ops).toHaveLength(0)
  })
})

describe('Ligar ou desligar o App recarrega a biblioteca com a janela', () => {
  it('"Abrindo a biblioteca do App" enquanto lê o que está no App, e "Tirando o App desta biblioteca" ao desligar', async () => {
    expect(library().appOn).toBe(true)
    seen = []
    await library().attachApp(false)
    expect(seen[0]).toMatchObject({ title: 'Tirando o App desta biblioteca' })
    seen = []
    await library().attachApp(true)
    expect(seen[0]).toMatchObject({ title: 'Abrindo a biblioteca do App' })
    expect(useBlockingStore.getState().ops).toHaveLength(0)
  })
})
