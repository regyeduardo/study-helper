// Spec 005, história 3 (FR-007 a FR-009, SC-005; opção E "Marcar e levar"): em Locais, pasta não tem lugar; só a nota tem.
// Marcar a pasta marca as notas de dentro ("−" quando só parte), e levar manda só as notas que estão em outro lugar.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import 'fake-indexeddb/auto'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

const { mockEnv } = vi.hoisted(() => ({ mockEnv: { apiUrl: 'https://api.example.test' } }))
vi.mock('@/lib/env', async importOriginal => ({ env: { ...((await importOriginal()) as { env: object }).env, apiUrl: mockEnv.apiUrl } }))

import type { FileMeta, FolderMeta } from '@/types/domain'
import type { ServerMe } from '@/controllers/api.controller'
import { PlacesPanel } from '@/components/dialogs/PlacesPanel'
import { CombinedRepository } from '@/lib/storage/combined-repository'
import { MoveJournal } from '@/lib/storage/moves'
import { type Account, LOCAL_ACCOUNT, useAccountStore } from '@/stores/account'
import { useBlockingStore } from '@/stores/blocking'
import { useLibraryStore } from '@/stores/library'
import { usePlacesStore } from '@/stores/places'
import { useServerAccount } from '@/stores/server-account'
import { useUiStore } from '@/stores/ui'
import { FakeAppServer } from '@/test/storage/fake-app-server'
import { FakeDrive, FOLDER, installMemoryStorage, uniqueAccount } from '@/test/storage/fake-drive'

const token = vi.fn(async () => 'tok')
const library = () => useLibraryStore.getState()
const repo = () => library().repo as CombinedRepository

let account: string
let drive: FakeDrive
let server: FakeAppServer
/** Every list of ids "Levar" sent to choosePlace. */
let sent: string[][]
const choosePlace = usePlacesStore.getState().choosePlace

function google(id: string): Account {
  return { id, kind: 'google', name: 'Ana', email: 'ana@example.com', picture: '', token: { accessToken: 'at-1', expiresAt: Date.now() + 3600_000 } }
}

const freed: ServerMe = {
  user: { id: 'u1', email: 'ana@example.com', name: 'Ana', photoUrl: null, status: 'enabled', appEnabled: true, admin: false, deleteAt: null, hasPassword: false, hasGoogle: true },
  requireCode: true,
  device: { id: 'd1', name: 'Chrome no Linux' },
  space: { notes: 0, media: 0, reserved: 0, limit: 10 * 1024 ** 3, warnAt: 0.9 },
}

beforeEach(async () => {
  installMemoryStorage()
  drive = new FakeDrive().install()
  const driveFetch = globalThis.fetch
  server = new FakeAppServer()
  vi.stubGlobal('fetch', (input: string | URL | Request, init?: RequestInit) => (String(input).startsWith(mockEnv.apiUrl) ? server.fetch(input, init) : driveFetch(input, init)))
  vi.stubGlobal('WebSocket', class { send() {} close() {} })
  account = uniqueAccount()
  sent = []
  useUiStore.setState({ overlay: null, toasts: [] })
  useBlockingStore.setState({ ops: [] })
  usePlacesStore.setState({
    running: false,
    progress: null,
    failed: [],
    choosePlace: async (ids, place) => {
      sent.push([...ids])
      return choosePlace(ids, place)
    },
  })
  useAccountStore.setState({ accounts: [LOCAL_ACCOUNT, google(account)], activeId: account, reconnectId: null })
  useServerAccount.setState({ me: freed, status: 'signed-in' })
  await library().connect(account, token)
})

afterEach(() => {
  usePlacesStore.setState({ choosePlace })
  vi.unstubAllGlobals()
  useAccountStore.setState({ activeId: LOCAL_ACCOUNT.id })
  useServerAccount.setState({ me: null, status: 'unknown' })
})

/** Faculdade: Aula 1 and Aula 2 in the Google Drive, Lista in the App, and the folder Cálculo with Aula 3 in the Google Drive. */
async function faculdade() {
  const folder = await library().createFolder({ name: 'Faculdade' })
  const calculo = await library().createFolder({ name: 'Cálculo', parentId: folder.id })
  // in the Google Drive: with the structure on, a note made without a place is born in the App
  const aula1 = await library().createFile({ name: 'Aula 1', type: 'class', folderId: folder.id, place: 'drive' }, 'texto da aula 1')
  const aula2 = await library().createFile({ name: 'Aula 2', type: 'class', folderId: folder.id, place: 'drive' }, 'texto da aula 2')
  const lista = await library().createFile({ name: 'Lista', type: 'class', folderId: folder.id, place: 'app' }, 'questão 1')
  const aula3 = await library().createFile({ name: 'Aula 3', type: 'class', folderId: calculo.id, place: 'drive' }, 'texto da aula 3')
  expect([aula1, aula2, aula3].map(note => repo().sideOf(note.id))).toEqual(['drive', 'drive', 'drive'])
  expect(repo().sideOf(lista.id)).toBe('app')
  return { folder, calculo, aula1, aula2, lista, aula3 }
}

const open = () => render(<MemoryRouter><PlacesPanel /></MemoryRouter>)
const tree = () => screen.getByRole('tree', { name: 'Biblioteca inteira' })
const row = (name: string) => within(tree()).getByRole('treeitem', { name })
const box = (name: string) => within(row(name)).getByRole('checkbox') as HTMLInputElement
const bar = () => screen.getByRole('toolbar', { name: 'Notas marcadas' })
const openFolder = (name: string) => fireEvent.click(within(tree()).getByRole('button', { name: `Abrir ${name}` }))

/** The folders as the library, the Google Drive and the App keep them (SC-005: none made, deleted or moved). */
function foldersNow() {
  return {
    library: library()
      .folders.map((folder: FolderMeta) => ({ id: folder.id, name: folder.name, parentId: folder.parentId, position: folder.position, deletedAt: folder.deletedAt }))
      .sort((a, b) => a.id.localeCompare(b.id)),
    drive: [...drive.files.values()]
      .filter(file => file.mimeType === FOLDER)
      .map(file => ({ id: file.id, name: file.name, parents: [...file.parents] }))
      .sort((a, b) => a.id.localeCompare(b.id)),
    app: [...server.rows.values()].filter(row => row.itemKind === 'folder').map(row => ({ id: row.id, meta: row.meta, removedAt: row.removedAt })),
  }
}

describe('Locais: só a nota tem lugar', () => {
  it('a pasta aparece sem lugar e sem "2 lugares"; cada nota mostra o seu lugar; nenhum seletor por linha', async () => {
    await faculdade()
    open()
    openFolder('Cálculo')
    expect(within(tree()).queryAllByRole('combobox')).toEqual([])
    expect(screen.queryByText('2 lugares')).not.toBeInTheDocument()
    expect(screen.queryByText(/^Segue/)).not.toBeInTheDocument()
    for (const folder of ['Faculdade', 'Cálculo']) expect(row(folder)).not.toHaveTextContent(/Google Drive|App|Local/)
    expect(within(row('Aula 1')).getByText('Google Drive')).toBeInTheDocument()
    expect(within(row('Lista')).getByText('App')).toBeInTheDocument()
    expect(within(row('Aula 3')).getByText('Google Drive')).toBeInTheDocument()
  })

  it('marcar a pasta marca as notas de dentro e das pastas de dentro; só parte marcada deixa a pasta em "−"', async () => {
    await faculdade()
    open()
    expect(screen.queryByRole('toolbar', { name: 'Notas marcadas' })).not.toBeInTheDocument()
    // Cálculo is closed: marking Faculdade marks Aula 3 too
    fireEvent.click(box('Faculdade'))
    expect(bar()).toHaveTextContent('4 notas marcadas')
    expect(box('Faculdade').checked).toBe(true)
    expect(box('Faculdade').indeterminate).toBe(false)
    openFolder('Cálculo')
    for (const note of ['Aula 1', 'Aula 2', 'Lista', 'Aula 3']) expect(box(note).checked).toBe(true)
    expect(box('Cálculo').checked).toBe(true)

    fireEvent.click(box('Aula 3'))
    expect(bar()).toHaveTextContent('3 notas marcadas')
    expect(box('Cálculo').checked).toBe(false)
    expect(box('Cálculo').indeterminate).toBe(false)
    expect(box('Faculdade').checked).toBe(false)
    expect(box('Faculdade').indeterminate).toBe(true)
    expect(box('Faculdade')).toHaveAttribute('aria-checked', 'mixed')

    // a folder in "−" marks everything inside it on the click
    fireEvent.click(box('Faculdade'))
    expect(bar()).toHaveTextContent('4 notas marcadas')
    // and a folder all marked unmarks everything on the next one
    fireEvent.click(box('Faculdade'))
    expect(screen.queryByRole('toolbar', { name: 'Notas marcadas' })).not.toBeInTheDocument()
  })

  it('levar para o App manda só as notas que estão em outro lugar; nenhuma pasta é criada, apagada ou movida (SC-005)', async () => {
    const { folder, calculo, aula1, aula2, lista, aula3 } = await faculdade()
    const before = foldersNow()
    open()
    fireEvent.click(box('Faculdade'))
    fireEvent.click(within(bar()).getByRole('button', { name: 'Levar para o App' }))
    const ask = screen.getByRole('alertdialog', { name: 'Levar 3 notas para o App' })
    expect(ask).toHaveTextContent('Vão 3 notas e')
    expect(ask).toHaveTextContent('1 já está no App')
    expect(ask).toHaveTextContent('As pastas continuam como estão')
    fireEvent.click(within(ask).getByRole('button', { name: 'Levar para o App' }))
    await waitFor(() => expect(usePlacesStore.getState().running).toBe(false))
    await waitFor(() => expect([aula1, aula2, aula3].map(note => repo().sideOf(note.id))).toEqual(['app', 'app', 'app']))

    // only notes, and only the ones that were somewhere else
    expect(sent).toHaveLength(1)
    expect([...sent[0]].sort()).toEqual([aula1.id, aula2.id, aula3.id].sort())
    expect(sent[0]).not.toContain(folder.id)
    expect(sent[0]).not.toContain(calculo.id)
    expect(sent[0]).not.toContain(lista.id)
    expect(usePlacesStore.getState().failed).toEqual([])

    // the notes stay in the same folder, with the same name (FR-009), and open
    for (const note of [aula1, aula2, aula3]) {
      const now = library().files.find((file: FileMeta) => file.id === note.id)!
      expect({ name: now.name, folderId: now.folderId }).toEqual({ name: note.name, folderId: note.folderId })
      expect(await repo().readContent(note.id)).toBe(`texto da ${note.name.toLowerCase()}`)
    }
    expect(foldersNow()).toEqual(before)
  })

  it('100 notas em pastas diferentes mudam de lugar e nenhuma pasta muda (SC-005)', async () => {
    const top = await library().createFolder({ name: 'Curso' })
    const inner: FolderMeta[] = []
    for (const name of ['Módulo 1', 'Módulo 2', 'Módulo 3', 'Módulo 4']) inner.push(await library().createFolder({ name, parentId: top.id }))
    const notes: FileMeta[] = []
    for (let index = 0; index < 100; index++) notes.push(await library().createFile({ name: `Nota ${index + 1}`, type: 'class', folderId: inner[index % 4].id, place: 'drive' }, `texto ${index + 1}`))
    const before = foldersNow()
    open()
    fireEvent.click(box('Curso'))
    expect(bar()).toHaveTextContent('100 notas marcadas')
    fireEvent.click(within(bar()).getByRole('button', { name: 'Levar para Local' }))
    fireEvent.click(within(screen.getByRole('alertdialog', { name: 'Levar 100 notas para Local' })).getByRole('button', { name: 'Levar para Local' }))
    await waitFor(() => expect(notes.every(note => repo().sideOf(note.id) === 'local')).toBe(true), { timeout: 20_000 })
    await waitFor(() => expect(usePlacesStore.getState().running).toBe(false))
    expect(sent).toHaveLength(1)
    expect(new Set(sent[0])).toEqual(new Set(notes.map(note => note.id)))
    expect(foldersNow()).toEqual(before)
  }, 30_000)

  it('a falha de uma mudança antiga não aparece como erro de uma mudança nova que deu certo', async () => {
    const { aula1, aula2, aula3 } = await faculdade()
    // what a move of yesterday left in this browser's journal
    await new MoveJournal(account).put({ id: aula3.id, kind: 'file', name: 'Aula 3', from: 'drive', to: 'app', state: 'falhou', reason: 'offline', batch: 'ontem', order: 0, bytes: 0 })
    open()
    fireEvent.click(box('Aula 1'))
    fireEvent.click(box('Aula 2'))
    fireEvent.click(within(bar()).getByRole('button', { name: 'Levar para o App' }))
    fireEvent.click(within(screen.getByRole('alertdialog', { name: 'Levar 2 notas para o App' })).getByRole('button', { name: 'Levar para o App' }))
    await waitFor(() => expect([aula1, aula2].map(note => repo().sideOf(note.id))).toEqual(['app', 'app']))
    await waitFor(() => expect(usePlacesStore.getState().running).toBe(false))
    expect(await screen.findByRole('status', { name: 'O que veio para o App' })).toHaveTextContent('2 notas vieram para o App.')
    expect(screen.queryByText(/não mudou de lugar/)).not.toBeInTheDocument()
  })

  it('a nota que não mudou de lugar aparece com o nome que tem agora', async () => {
    const { aula1 } = await faculdade()
    // planned while it still had the recording's name; renamed by the title before the move ran
    await new MoveJournal(account).put({ id: aula1.id, kind: 'file', name: 'Reunião 23-11-2026, 17-51-57', from: 'drive', to: 'app', state: 'pendente', batch: 'agora', order: 0, bytes: 0 })
    server.failPutFor = aula1.id
    open()
    await usePlacesStore.getState().resume()
    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('1 nota não mudou de lugar')
    expect(alert).toHaveTextContent('Aula 1:')
    expect(alert).not.toHaveTextContent('Reunião')
  })

  it('notas que já estão no destino não contam: com todas as marcadas no App, "Levar para o App" fica desligado', async () => {
    await faculdade()
    open()
    fireEvent.click(box('Lista'))
    expect(bar()).toHaveTextContent('1 nota marcada')
    expect(within(bar()).getByRole('button', { name: /^Levar para o App/ })).toBeDisabled()
    expect(within(bar()).getByRole('button', { name: 'Levar para o Google Drive' })).toBeEnabled()
    fireEvent.click(box('Aula 1'))
    expect(within(bar()).getByRole('button', { name: 'Levar para o App' })).toBeEnabled()
    fireEvent.click(within(bar()).getByRole('button', { name: 'Levar para o App' }))
    expect(screen.getByRole('alertdialog', { name: 'Levar “Aula 1” para o App' })).toHaveTextContent('Vão 1 nota e')
  })
})
