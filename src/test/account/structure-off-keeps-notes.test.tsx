// FR-066 (escolha A do dono, 22/11/2026): desligar "Usar a estrutura do app" com notas no App não faz nada sumir. A janela diz quanto está
// no App e pede para onde levar (Local já marcado, ou Google Drive), mostra se cabe neste navegador, leva e só então desliga.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import 'fake-indexeddb/auto'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

const { mockEnv } = vi.hoisted(() => ({ mockEnv: { apiUrl: 'https://api.example.test' } }))
vi.mock('@/lib/env', async importOriginal => ({ env: { ...((await importOriginal()) as { env: object }).env, apiUrl: mockEnv.apiUrl } }))

import type { ServerMe } from '@/controllers/api.controller'
import { AppStructureSection } from '@/components/dialogs/AppStructure'
import { CombinedRepository } from '@/lib/storage/combined-repository'
import { type Account, LOCAL_ACCOUNT, useAccountStore } from '@/stores/account'
import { useBlockingStore } from '@/stores/blocking'
import { useLibraryStore } from '@/stores/library'
import { usePlacesStore } from '@/stores/places'
import { useServerAccount } from '@/stores/server-account'
import { useUiStore } from '@/stores/ui'
import { FakeAppServer } from '@/test/storage/fake-app-server'
import { FakeDrive, installMemoryStorage, uniqueAccount } from '@/test/storage/fake-drive'

const token = vi.fn(async () => 'tok')
const library = () => useLibraryStore.getState()
const repo = () => library().repo as CombinedRepository

function google(id: string): Account {
  return { id, kind: 'google', name: 'Ana', email: 'ana@example.com', picture: '', token: { accessToken: 'at-1', expiresAt: Date.now() + 3600_000 } }
}

const freed = (appEnabled: boolean): ServerMe => ({
  user: { id: 'u1', email: 'ana@example.com', name: 'Ana', photoUrl: null, status: 'enabled', appEnabled, admin: false, deleteAt: null, hasPassword: false, hasGoogle: true },
  requireCode: true,
  device: { id: 'd1', name: 'Chrome no Linux' },
  space: { notes: 0, media: 0, reserved: 0, limit: 10 * 1024 ** 3, warnAt: 0.9 },
})

let setStructure: ReturnType<typeof vi.fn>

function estimate(quota: number, usage: number) {
  Object.defineProperty(navigator, 'storage', { configurable: true, value: { estimate: vi.fn(async () => ({ quota, usage })) } })
}

beforeEach(async () => {
  installMemoryStorage()
  new FakeDrive().install()
  const driveFetch = globalThis.fetch
  const server = new FakeAppServer()
  vi.stubGlobal('fetch', (input: string | URL | Request, init?: RequestInit) => (String(input).startsWith(mockEnv.apiUrl) ? server.fetch(input, init) : driveFetch(input, init)))
  vi.stubGlobal('WebSocket', class { send() {} close() {} })
  const account = uniqueAccount()
  useUiStore.setState({ overlay: null, toasts: [] })
  usePlacesStore.setState({ running: false, progress: null, failed: [] })
  useBlockingStore.setState({ ops: [] })
  useAccountStore.setState({ accounts: [LOCAL_ACCOUNT, google(account)], activeId: account, reconnectId: null })
  // the server turns the structure off; the library follows the account (FR-032)
  setStructure = vi.fn(async (on: boolean) => useServerAccount.setState({ me: freed(on), status: 'signed-in' }))
  useServerAccount.setState({ me: freed(true), status: 'signed-in', setStructure })
  await library().connect(account, token)
  estimate(50 * 1024 ** 3, 9 * 1024 ** 3)
})

afterEach(() => {
  // unmount first: with the screen still open, resetting the account below would make it ask the server again in the next test
  cleanup()
  vi.unstubAllGlobals()
  Reflect.deleteProperty(navigator, 'storage')
  useAccountStore.setState({ activeId: LOCAL_ACCOUNT.id })
  useServerAccount.setState({ me: null, status: 'unknown' })
})

/** Faculdade in the App, with 2 notes. */
async function inTheApp() {
  const folder = await library().createFolder({ name: 'Faculdade' })
  const notes = [await library().createFile({ name: 'Aula 1', type: 'class', folderId: folder.id }, 'derivadas'), await library().createFile({ name: 'Aula 2', type: 'class', folderId: folder.id }, 'integrais')]
  await usePlacesStore.getState().choosePlace([folder.id], 'app')
  expect(notes.map(note => repo().sideOf(note.id))).toEqual(['app', 'app'])
  return { folder, notes }
}

async function askToTurnOff() {
  render(<AppStructureSection />)
  await userEvent.click(screen.getByRole('switch', { name: 'Usar a estrutura do app' }))
  return screen.findByRole('dialog', { name: 'Desligar a estrutura do app' })
}

describe('Desligar a estrutura com notas no App', () => {
  it('diz quanto está no App, vem com Local marcado e mostra o espaço livre neste navegador', async () => {
    await inTheApp()
    const dialog = await askToTurnOff()
    expect(dialog).toHaveTextContent('2 notas e')
    expect(dialog).toHaveTextContent('estão no App.')
    expect(within(dialog).getByRole('radio', { name: /Local/ })).toBeChecked()
    expect(within(dialog).getByRole('radio', { name: /Google Drive/ })).not.toBeChecked()
    expect(await within(dialog).findByText(/Espaço neste navegador: .* livres/)).toBeInTheDocument()
    // nothing happens before the button: no turning off without taking them
    expect(within(dialog).queryByRole('button', { name: 'Desligar' })).toBeNull()
  })

  it('"Levar e desligar" com Local: as notas vêm para este navegador e só então a estrutura desliga', async () => {
    const { notes } = await inTheApp()
    const dialog = await askToTurnOff()
    await userEvent.click(within(dialog).getByRole('button', { name: 'Levar e desligar' }))
    await waitFor(() => expect(setStructure).toHaveBeenCalledWith(false))
    expect(notes.map(note => repo().sideOf(note.id))).toEqual(['local', 'local'])
    for (const note of notes) expect(await repo().readContent(note.id)).toBeTruthy()
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('A estrutura do app está desligada. As notas do App vieram para Local.'))
    // still in the library after the App leaves it
    await waitFor(() => expect(library().appOn).toBe(false))
    expect(library().files.map(file => file.name).sort()).toEqual(['Aula 1', 'Aula 2'])
  })

  it('com Google Drive escolhido, as notas vão para o Drive', async () => {
    const { notes } = await inTheApp()
    const dialog = await askToTurnOff()
    await userEvent.click(within(dialog).getByRole('radio', { name: /Google Drive/ }))
    await userEvent.click(within(dialog).getByRole('button', { name: 'Levar e desligar' }))
    await waitFor(() => expect(setStructure).toHaveBeenCalledWith(false))
    expect(notes.map(note => repo().sideOf(note.id))).toEqual(['drive', 'drive'])
  })

  it('sem espaço neste navegador, Local fica desligado com o motivo e o Google Drive vem marcado', async () => {
    await inTheApp()
    estimate(1000, 999)
    const dialog = await askToTurnOff()
    await waitFor(() => expect(within(dialog).getByRole('radio', { name: /Local/ })).toBeDisabled())
    expect(dialog).toHaveTextContent('Não cabe neste navegador')
    expect(within(dialog).getByRole('radio', { name: /Google Drive/ })).toBeChecked()
  })

  it('se a mudança parar no meio, a estrutura continua ligada e a tela diz quanto ficou no App', async () => {
    await inTheApp()
    const dialog = await askToTurnOff()
    const stop = useBlockingStore.subscribe(state => {
      const op = state.ops.at(-1)
      if (op?.phase === 'Levando as notas' && op.done === 1 && !op.cancelling) useBlockingStore.getState().cancel(op.id)
    })
    await userEvent.click(within(dialog).getByRole('button', { name: 'Levar e desligar' }))
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Ainda há 1 nota no App: a estrutura continua ligada.'))
    stop()
    expect(setStructure).not.toHaveBeenCalled()
  })

  it('sem nada no App, desligar é como antes: nada é apagado', async () => {
    render(<AppStructureSection />)
    await userEvent.click(screen.getByRole('switch', { name: 'Usar a estrutura do app' }))
    const dialog = await screen.findByRole('alertdialog', { name: 'Desligar a estrutura do app?' })
    expect(dialog).toHaveTextContent('Nada é apagado')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Desligar' }))
    await waitFor(() => expect(setStructure).toHaveBeenCalledWith(false))
  })
})
