import '@/test/account/storage-shim'
import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { fireEvent, render, screen, waitFor } from '@testing-library/react'

const { mockEnv } = vi.hoisted(() => ({
  mockEnv: { googleClientId: 'client-id', authWorkerUrl: 'https://auth.example.workers.dev', googleApiBase: 'https://api.example.test', googleAccountsScript: 'https://gsi.example.test/client', basePath: '/' },
}))

vi.mock('@/lib/env', () => ({ env: mockEnv }))

import { AccountMenu } from '@/components/dialogs/AccountMenu'
import { newFileMeta, newFolderMeta, newSidecar } from '@/lib/defaults'
import { page } from '@/controllers/google-redirect.controller'
import { currentDevice } from '@/lib/device'
import { DriveRepository } from '@/lib/storage/drive-repository'
import { deleteDatabase } from '@/lib/storage/idb'
import { LocalRepository, LOCAL_ACCOUNT_ID } from '@/lib/storage/local-repository'
import { type Account, LOCAL_ACCOUNT, useAccountStore } from '@/stores/account'
import { useLibraryStore } from '@/stores/library'
import { useUiStore } from '@/stores/ui'
import { type GoogleFake, installFetch, installGoogle, type WorkerFake } from '@/test/account/google-fakes'

const ANA: Account = { id: 'sub-ana', kind: 'google', name: 'Ana Souza', email: 'ana@example.com', picture: '', token: { accessToken: 'a', expiresAt: Date.now() + 3600_000, refreshToken: 'refresh-ana' } }
const BRUNO: Account = { id: 'sub-bruno', kind: 'google', name: 'Bruno Lima', email: 'bruno@example.com', picture: '', token: { accessToken: 'b', expiresAt: Date.now() + 3600_000, refreshToken: 'refresh-bruno' } }

let google: GoogleFake
let server: WorkerFake

beforeEach(async () => {
  localStorage.clear()
  await deleteDatabase('study-helper-local')
  google = installGoogle()
  server = installFetch()
  server.profiles['access-1'] = { sub: 'sub-ana', name: 'Ana Souza', email: 'ana@example.com', picture: '' }
  useUiStore.setState({ overlay: { kind: 'account' }, toasts: [] })
  useAccountStore.setState({ accounts: [LOCAL_ACCOUNT], activeId: LOCAL_ACCOUNT_ID, reconnectId: null, reconnectMessage: '' })
  useLibraryStore.setState({ repo: null, accountId: null })
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  delete window.google
})

describe('AccountMenu position', () => {
  it('opens right below the button that was clicked', () => {
    useUiStore.setState({ overlay: { kind: 'account', x: 12, y: 60 } })
    render(<AccountMenu />)
    const menu = screen.getByRole('menu', { name: 'Conta' })
    expect(menu.style.left).toBe('12px')
    expect(menu.style.top).toBe('60px')
  })
})

describe('AccountMenu sign out', () => {
  it('removes the login, the account cache and this device', async () => {
    const repo = new DriveRepository('sub-ana', async () => 'a')
    const removeDevice = vi.spyOn(repo, 'removeDevice').mockResolvedValue(undefined)
    const forget = vi.spyOn(repo, 'forget').mockResolvedValue(undefined)
    useLibraryStore.setState({ repo, accountId: 'sub-ana' })
    localStorage.setItem('study-helper:opened:sub-ana', '{"f1":1}')
    localStorage.setItem('study-helper:opened:sub-bruno', '{"f2":2}')
    useAccountStore.setState({ accounts: [LOCAL_ACCOUNT, ANA, BRUNO], activeId: 'sub-ana' })
    render(<AccountMenu />)
    fireEvent.click(screen.getByRole('button', { name: /Sair desta conta/ }))
    await waitFor(() => expect(useAccountStore.getState().activeId).toBe(LOCAL_ACCOUNT_ID))
    expect(removeDevice).toHaveBeenCalledWith(currentDevice().id)
    expect(forget).toHaveBeenCalled()
    expect(google.revoked).toEqual(['refresh-ana'])
    expect(useAccountStore.getState().accounts.map(item => item.id)).toEqual([LOCAL_ACCOUNT_ID, 'sub-bruno'])
    expect(localStorage.getItem('study-helper:opened:sub-ana')).toBeNull()
    expect(localStorage.getItem('study-helper:opened:sub-bruno')).toBe('{"f2":2}')
    expect(useUiStore.getState().toasts.at(-1)?.text).toMatch(/login e o cache dela foram apagados/)
  })

  it('does not offer sign out on the Local profile', () => {
    render(<AccountMenu />)
    expect(screen.queryByRole('button', { name: /Sair desta conta/ })).toBeNull()
    expect(screen.getByRole('button', { name: /Local/ })).toBeInTheDocument()
  })

  it('lists every account and switches on click', () => {
    useAccountStore.setState({ accounts: [LOCAL_ACCOUNT, ANA, BRUNO], activeId: 'sub-ana' })
    render(<AccountMenu />)
    fireEvent.click(screen.getByRole('button', { name: /Bruno Lima/ }))
    expect(useAccountStore.getState().activeId).toBe('sub-bruno')
    expect(useUiStore.getState().overlay).toBeNull()
  })
})

describe('AccountMenu send local data on login', () => {
  it('offers to send local data when the Local profile has files', async () => {
    const local = new LocalRepository()
    await local.load()
    await local.saveFile(newSidecar(newFileMeta({ name: 'Local note', type: 'reading' })), '# Local')
    render(<AccountMenu />)
    fireEvent.click(screen.getByRole('button', { name: /Adicionar conta Google/ }))
    await waitFor(() => expect(useUiStore.getState().overlay).toEqual({ kind: 'send-local' }))
    expect(useAccountStore.getState().activeId).toBe('sub-ana')
  })

  it('offers to send local data when the Local profile has only folders', async () => {
    const local = new LocalRepository()
    await local.load()
    await local.saveFolder(newFolderMeta({ name: 'Biology' }))
    render(<AccountMenu />)
    fireEvent.click(screen.getByRole('button', { name: /Adicionar conta Google/ }))
    await waitFor(() => expect(useUiStore.getState().overlay).toEqual({ kind: 'send-local' }))
  })

  it('does not ask when the Local profile is empty', async () => {
    render(<AccountMenu />)
    fireEvent.click(screen.getByRole('button', { name: /Adicionar conta Google/ }))
    await waitFor(() => expect(useAccountStore.getState().activeId).toBe('sub-ana'))
    await waitFor(() => expect(useUiStore.getState().overlay).toBeNull())
  })

  it('does not ask when adding from another Google account', async () => {
    const local = new LocalRepository()
    await local.load()
    await local.saveFile(newSidecar(newFileMeta({ name: 'Local note', type: 'reading' })), '# Local')
    useAccountStore.setState({ accounts: [LOCAL_ACCOUNT, BRUNO], activeId: 'sub-bruno' })
    render(<AccountMenu />)
    fireEvent.click(screen.getByRole('button', { name: /Adicionar conta Google/ }))
    await waitFor(() => expect(useAccountStore.getState().activeId).toBe('sub-ana'))
    expect(useUiStore.getState().overlay).toBeNull()
  })

  it('shows the login error', async () => {
    google.nextCode = { error: 'access_denied' }
    render(<AccountMenu />)
    fireEvent.click(screen.getByRole('button', { name: /Adicionar conta Google/ }))
    expect(await screen.findByRole('alert')).toHaveTextContent('O Google não liberou o acesso.')
  })
})

describe('AccountMenu sign in on a phone', () => {
  const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1'
  const add = () => screen.getByRole('button', { name: /Adicionar conta Google/ })

  afterEach(() => {
    delete (navigator as { userAgent?: string }).userAgent
  })

  it('opens the Google window inside the tap, before anything is awaited', async () => {
    // A Local profile with content makes the menu read the browser database: that read must not come before the window.
    const local = new LocalRepository()
    await local.load()
    await local.saveFolder(newFolderMeta({ name: 'Pasta' }))
    render(<AccountMenu />)
    fireEvent.click(add())
    expect(google.codeConfigs).toHaveLength(1)
    await waitFor(() => expect(useUiStore.getState().overlay?.kind).toBe('send-local'))
  })

  it('goes to Google in the same tab on an iPhone', async () => {
    Object.defineProperty(navigator, 'userAgent', { configurable: true, value: IPHONE })
    const go = vi.spyOn(page, 'go').mockImplementation(() => undefined)
    render(<AccountMenu />)
    fireEvent.click(add())
    await waitFor(() => expect(go).toHaveBeenCalledTimes(1))
    expect(google.codeConfigs).toHaveLength(0)
    expect(String(go.mock.calls[0][0])).toContain('https://accounts.google.com/o/oauth2/v2/auth')
  })

  it('offers to go on in this tab when the Google window was closed with no answer', async () => {
    google.codePopup = 'popup_closed'
    const go = vi.spyOn(page, 'go').mockImplementation(() => undefined)
    render(<AccountMenu />)
    expect(screen.queryByRole('button', { name: 'Entrar nesta aba' })).toBeNull()
    fireEvent.click(add())
    expect(await screen.findByRole('alert')).toHaveTextContent('A janela do Google foi fechada.')
    expect(go).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Entrar nesta aba' }))
    await waitFor(() => expect(go).toHaveBeenCalledTimes(1))
  })

  it('does not offer it for any other failure', async () => {
    google.nextCode = { error: 'access_denied' }
    render(<AccountMenu />)
    fireEvent.click(add())
    await screen.findByRole('alert')
    expect(screen.queryByRole('button', { name: 'Entrar nesta aba' })).toBeNull()
  })
})
