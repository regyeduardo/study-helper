import '@/test/account/storage-shim'
import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { mockEnv } = vi.hoisted(() => ({
  mockEnv: { googleClientId: 'client-id', authWorkerUrl: '', googleApiBase: 'https://api.example.test', googleAccountsScript: 'https://gsi.example.test/client', basePath: '/' },
}))

vi.mock('@/lib/env', () => ({ env: mockEnv }))

import { GoogleAuthError, GoogleReconnectError } from '@/controllers/google-auth.controller'
import { DriveRepository } from '@/lib/storage/drive-repository'
import { KeyValueStore } from '@/lib/storage/idb'
import { LOCAL_ACCOUNT_ID } from '@/lib/storage/local-repository'
import { type Account, LOCAL_ACCOUNT, useAccountStore } from '@/stores/account'
import { DRIVE, type GoogleFake, installFetch, installGoogle, WORKER, type WorkerFake } from '@/test/account/google-fakes'

const ACCOUNTS_KEY = 'study-helper:accounts'
const ACTIVE_KEY = 'study-helper:active-account'
const ANA = { sub: 'sub-ana', name: 'Ana Souza', email: 'ana@example.com', picture: 'https://pic/ana' }
const BRUNO = { sub: 'sub-bruno', name: 'Bruno Lima', email: 'bruno@example.com', picture: '' }

let google: GoogleFake
let server: WorkerFake

function savedAccounts(): Account[] {
  return JSON.parse(localStorage.getItem(ACCOUNTS_KEY) ?? '[]') as Account[]
}

function account(id: string): Account | undefined {
  return useAccountStore.getState().accounts.find(item => item.id === id)
}

function seedGoogle(patch: Partial<Account> & { id: string }): void {
  const seeded: Account = { kind: 'google', name: ANA.name, email: ANA.email, picture: '', ...patch }
  useAccountStore.setState({ accounts: [LOCAL_ACCOUNT, seeded], activeId: seeded.id })
}

beforeEach(() => {
  localStorage.clear()
  mockEnv.authWorkerUrl = WORKER
  google = installGoogle()
  server = installFetch()
  server.profiles['access-1'] = ANA
  server.profiles['popup-token'] = ANA
  useAccountStore.setState({ accounts: [LOCAL_ACCOUNT], activeId: LOCAL_ACCOUNT_ID, reconnectId: null, reconnectMessage: '' })
})

afterEach(() => {
  vi.unstubAllGlobals()
  delete window.google
})

describe('durable login with the auth worker', () => {
  it('logs in with the code flow and keeps the refresh token', async () => {
    const added = await useAccountStore.getState().addGoogleAccount()
    expect(google.codeConfigs).toHaveLength(1)
    expect(google.codeConfigs[0]).toMatchObject({ client_id: 'client-id', ux_mode: 'popup', select_account: true })
    expect(String(google.codeConfigs[0].scope)).toContain(DRIVE)
    expect(google.tokenConfigs).toHaveLength(0)
    expect(server.calls.find(call => call.url === `${WORKER}/token`)?.body).toEqual({ code: 'auth-code' })
    expect(added).toMatchObject({ id: 'sub-ana', kind: 'google', email: 'ana@example.com', token: { accessToken: 'access-1', refreshToken: 'refresh-1' } })
    expect(useAccountStore.getState().activeId).toBe('sub-ana')
    expect(savedAccounts()[0].token?.refreshToken).toBe('refresh-1')
    expect(localStorage.getItem(ACTIVE_KEY)).toBe('sub-ana')
    expect(useAccountStore.getState().reconnectId).toBeNull()
  })

  it('renews an expired access through the worker without any popup', async () => {
    seedGoogle({ id: 'sub-ana', token: { accessToken: 'old', expiresAt: Date.now() - 1000, refreshToken: 'refresh-1' } })
    await expect(useAccountStore.getState().tokenFor('sub-ana')).resolves.toBe('access-renewed')
    expect(server.calls).toEqual([{ url: `${WORKER}/refresh`, body: { refresh_token: 'refresh-1' } }])
    expect(server.fetch.mock.calls[0][1]).toMatchObject({ method: 'POST' })
    expect(google.codeConfigs).toHaveLength(0)
    expect(google.tokenConfigs).toHaveLength(0)
    expect(account('sub-ana')?.token).toMatchObject({ accessToken: 'access-renewed', refreshToken: 'refresh-1' })
    expect(savedAccounts()[0].token?.accessToken).toBe('access-renewed')
  })

  it('renews shortly before expiry and shares one renewal between callers', async () => {
    seedGoogle({ id: 'sub-ana', token: { accessToken: 'old', expiresAt: Date.now() + 30_000, refreshToken: 'refresh-1' } })
    const tokens = await Promise.all([useAccountStore.getState().tokenFor('sub-ana'), useAccountStore.getState().tokenFor('sub-ana')])
    expect(tokens).toEqual(['access-renewed', 'access-renewed'])
    expect(server.calls.filter(call => call.url === `${WORKER}/refresh`)).toHaveLength(1)
  })

  it('returns a valid token without renewing', async () => {
    seedGoogle({ id: 'sub-ana', token: { accessToken: 'fresh', expiresAt: Date.now() + 3600_000, refreshToken: 'refresh-1' } })
    await expect(useAccountStore.getState().tokenFor('sub-ana')).resolves.toBe('fresh')
    expect(server.fetch).not.toHaveBeenCalled()
  })

  it('takes a rotated refresh token from the worker', async () => {
    server.refreshReply = { access_token: 'access-renewed', expires_in: 3600, refresh_token: 'refresh-2' }
    seedGoogle({ id: 'sub-ana', token: { accessToken: 'old', expiresAt: 0, refreshToken: 'refresh-1' } })
    await useAccountStore.getState().tokenFor('sub-ana')
    expect(account('sub-ana')?.token?.refreshToken).toBe('refresh-2')
  })

  it('asks to reconnect and drops the dead refresh token on invalid_grant', async () => {
    server.refreshReply = { error: 'invalid_grant', error_description: 'Token has been expired or revoked.' }
    seedGoogle({ id: 'sub-ana', token: { accessToken: 'old', expiresAt: 0, refreshToken: 'dead-refresh' } })
    await expect(useAccountStore.getState().tokenFor('sub-ana')).rejects.toBeInstanceOf(GoogleReconnectError)
    expect(useAccountStore.getState().reconnectId).toBe('sub-ana')
    expect(useAccountStore.getState().reconnectMessage).toBe('O Google pediu pra você entrar de novo.')
    expect(account('sub-ana')?.token?.refreshToken).toBeUndefined()
    expect(savedAccounts()[0].token?.refreshToken).toBeUndefined()
    expect(google.codeConfigs).toHaveLength(0)
    expect(google.tokenConfigs).toHaveLength(0)
    server.calls.length = 0
    await expect(useAccountStore.getState().tokenFor('sub-ana')).rejects.toBeInstanceOf(GoogleReconnectError)
    expect(server.calls).toHaveLength(0)
  })

  it('keeps the refresh token on a transient worker failure', async () => {
    server.refreshReply = { error: 'temporarily_unavailable' }
    seedGoogle({ id: 'sub-ana', token: { accessToken: 'old', expiresAt: 0, refreshToken: 'refresh-1' } })
    await expect(useAccountStore.getState().tokenFor('sub-ana')).rejects.toBeInstanceOf(GoogleAuthError)
    expect(useAccountStore.getState().reconnectId).toBeNull()
    expect(account('sub-ana')?.token?.refreshToken).toBe('refresh-1')
  })

  it('asks to reconnect when there is no refresh token at all', async () => {
    seedGoogle({ id: 'sub-ana', token: { accessToken: 'old', expiresAt: 0 } })
    await expect(useAccountStore.getState().tokenFor('sub-ana')).rejects.toBeInstanceOf(GoogleReconnectError)
    expect(useAccountStore.getState().reconnectId).toBe('sub-ana')
    expect(server.fetch).not.toHaveBeenCalled()
  })

  it('reauthorizes with the code flow and clears the reconnect state', async () => {
    seedGoogle({ id: 'sub-ana', token: { accessToken: 'old', expiresAt: 0 } })
    useAccountStore.setState({ reconnectId: 'sub-ana', reconnectMessage: 'x' })
    await useAccountStore.getState().reauthorize('sub-ana')
    expect(google.codeConfigs[0]).toMatchObject({ select_account: false, login_hint: 'ana@example.com' })
    expect(google.tokenConfigs).toHaveLength(0)
    expect(account('sub-ana')?.token).toMatchObject({ accessToken: 'access-1', refreshToken: 'refresh-1' })
    expect(useAccountStore.getState().reconnectId).toBeNull()
    await expect(useAccountStore.getState().tokenFor('sub-ana')).resolves.toBe('access-1')
  })

  it('revokes and asks one more tap when reauthorize gets no refresh token', async () => {
    server.tokenReply = { access_token: 'access-no-offline', expires_in: 3600, scope: `${DRIVE} openid` }
    seedGoogle({ id: 'sub-ana', token: { accessToken: 'old', expiresAt: 0 } })
    useAccountStore.setState({ reconnectId: 'sub-ana', reconnectMessage: 'O Google pediu pra você entrar de novo.' })
    await expect(useAccountStore.getState().reauthorize('sub-ana')).rejects.toBeInstanceOf(GoogleReconnectError)
    expect(google.revoked).toEqual(['access-no-offline'])
    expect(useAccountStore.getState().reconnectId).toBe('sub-ana')
    expect(useAccountStore.getState().reconnectMessage).toBe('Falta um toque: o Google precisa confirmar o acesso contínuo ao Drive.')
  })

  it('revokes and asks one more tap when the first login gets no refresh token', async () => {
    server.tokenReply = { access_token: 'access-1', expires_in: 3600, scope: `${DRIVE} openid` }
    await useAccountStore.getState().addGoogleAccount()
    expect(google.revoked).toEqual(['access-1'])
    expect(useAccountStore.getState().reconnectId).toBe('sub-ana')
    expect(useAccountStore.getState().reconnectMessage).toMatch(/Falta um toque/)
  })

  it('keeps the previous refresh token when Google omits it on a new login', async () => {
    seedGoogle({ id: 'sub-ana', token: { accessToken: 'old', expiresAt: 0, refreshToken: 'refresh-kept' } })
    server.tokenReply = { access_token: 'access-1', expires_in: 3600, scope: `${DRIVE} openid` }
    await useAccountStore.getState().addGoogleAccount()
    expect(account('sub-ana')?.token?.refreshToken).toBe('refresh-kept')
    expect(google.revoked).toEqual([])
    expect(useAccountStore.getState().reconnectId).toBeNull()
  })

  it('refuses a login without the Drive permission', async () => {
    google.nextCode = { code: 'auth-code', scope: 'openid email profile' }
    await expect(useAccountStore.getState().addGoogleAccount()).rejects.toThrow(/acesso ao Google Drive/)
    expect(useAccountStore.getState().accounts).toEqual([LOCAL_ACCOUNT])
  })
})

describe('legacy token flow without the auth worker', () => {
  beforeEach(() => {
    mockEnv.authWorkerUrl = ''
  })

  it('logs in with the token client and never calls a worker', async () => {
    const added = await useAccountStore.getState().addGoogleAccount()
    expect(google.codeConfigs).toHaveLength(0)
    expect(google.tokenRequests).toEqual([{ prompt: 'select_account', login_hint: undefined }])
    expect(server.calls.map(call => call.url)).toEqual(['https://api.example.test/oauth2/v3/userinfo'])
    expect(added.token?.accessToken).toBe('popup-token')
    expect(added.token?.refreshToken).toBeUndefined()
    expect(useAccountStore.getState().reconnectId).toBeNull()
  })

  it('renews silently with the token client and retries with account selection', async () => {
    seedGoogle({ id: 'sub-ana', token: { accessToken: 'old', expiresAt: 0 } })
    google.tokenReplies = ['popup_closed', { access_token: 'second', expires_in: 3600, scope: DRIVE }]
    await expect(useAccountStore.getState().tokenFor('sub-ana')).resolves.toBe('second')
    expect(google.tokenRequests).toEqual([
      { prompt: '', login_hint: 'ana@example.com' },
      { prompt: 'select_account', login_hint: 'ana@example.com' },
    ])
    expect(server.calls).toHaveLength(0)
  })

  it('reauthorizes with a consent prompt', async () => {
    seedGoogle({ id: 'sub-ana', token: { accessToken: 'old', expiresAt: 0 } })
    useAccountStore.setState({ reconnectId: 'sub-ana' })
    await useAccountStore.getState().reauthorize('sub-ana')
    expect(google.tokenRequests).toEqual([{ prompt: 'consent', login_hint: 'ana@example.com' }])
    expect(useAccountStore.getState().reconnectId).toBeNull()
  })
})

describe('multiple accounts', () => {
  it('keeps several Google accounts after Local and switches between them', async () => {
    server.profiles['access-1'] = ANA
    await useAccountStore.getState().addGoogleAccount()
    server.tokenReply = { access_token: 'access-b', expires_in: 3600, refresh_token: 'refresh-b', scope: DRIVE }
    server.profiles['access-b'] = BRUNO
    await useAccountStore.getState().addGoogleAccount()
    expect(useAccountStore.getState().accounts.map(item => item.id)).toEqual([LOCAL_ACCOUNT_ID, 'sub-ana', 'sub-bruno'])
    expect(useAccountStore.getState().active().id).toBe('sub-bruno')
    useAccountStore.getState().switchTo('sub-ana')
    expect(useAccountStore.getState().active().email).toBe('ana@example.com')
    expect(localStorage.getItem(ACTIVE_KEY)).toBe('sub-ana')
    useAccountStore.getState().switchTo(LOCAL_ACCOUNT_ID)
    expect(useAccountStore.getState().active()).toEqual(LOCAL_ACCOUNT)
    expect(savedAccounts().map(item => item.id)).toEqual(['sub-ana', 'sub-bruno'])
  })

  it('does not duplicate an account that logs in again', async () => {
    await useAccountStore.getState().addGoogleAccount()
    await useAccountStore.getState().addGoogleAccount()
    expect(useAccountStore.getState().accounts.map(item => item.id)).toEqual([LOCAL_ACCOUNT_ID, 'sub-ana'])
  })

  it('signs out by revoking, forgetting the login and falling back to Local', async () => {
    seedGoogle({ id: 'sub-ana', token: { accessToken: 'a', expiresAt: Date.now() + 3600_000, refreshToken: 'refresh-1' } })
    useAccountStore.setState({ reconnectId: 'sub-ana' })
    localStorage.setItem(ACCOUNTS_KEY, JSON.stringify([account('sub-ana')]))
    await useAccountStore.getState().forgetAccount('sub-ana')
    expect(google.revoked).toEqual(['refresh-1'])
    expect(useAccountStore.getState().accounts).toEqual([LOCAL_ACCOUNT])
    expect(useAccountStore.getState().activeId).toBe(LOCAL_ACCOUNT_ID)
    expect(useAccountStore.getState().reconnectId).toBeNull()
    expect(savedAccounts()).toEqual([])
    expect(localStorage.getItem(ACTIVE_KEY)).toBe(LOCAL_ACCOUNT_ID)
  })

  it('keeps the active account when another one signs out', async () => {
    const other: Account = { id: 'sub-bruno', kind: 'google', name: 'Bruno', email: 'b@example.com', picture: '', token: { accessToken: 'b', expiresAt: 0 } }
    seedGoogle({ id: 'sub-ana' })
    useAccountStore.setState(state => ({ accounts: [...state.accounts, other] }))
    await useAccountStore.getState().forgetAccount('sub-bruno')
    expect(google.revoked).toEqual(['b'])
    expect(useAccountStore.getState().activeId).toBe('sub-ana')
  })

  it('never removes the Local profile', async () => {
    await useAccountStore.getState().forgetAccount(LOCAL_ACCOUNT_ID)
    expect(useAccountStore.getState().accounts).toEqual([LOCAL_ACCOUNT])
  })

  it('always starts with Local first, even with odd saved data', async () => {
    localStorage.setItem(ACCOUNTS_KEY, JSON.stringify([{ ...LOCAL_ACCOUNT, name: 'Fake local' }, { id: 'sub-ana', kind: 'google', name: 'Ana', email: 'a', picture: '' }]))
    localStorage.setItem(ACTIVE_KEY, 'sub-missing')
    vi.resetModules()
    const fresh = await import('@/stores/account')
    expect(fresh.useAccountStore.getState().accounts.map(item => [item.id, item.name])).toEqual([
      [LOCAL_ACCOUNT_ID, 'Local'],
      ['sub-ana', 'Ana'],
    ])
    expect(fresh.useAccountStore.getState().activeId).toBe(LOCAL_ACCOUNT_ID)
    localStorage.setItem(ACCOUNTS_KEY, '{broken')
    vi.resetModules()
    const broken = await import('@/stores/account')
    expect(broken.useAccountStore.getState().accounts).toEqual([fresh.LOCAL_ACCOUNT])
  })

  it('restores the saved active account', async () => {
    localStorage.setItem(ACCOUNTS_KEY, JSON.stringify([{ id: 'sub-ana', kind: 'google', name: 'Ana', email: 'a', picture: '' }]))
    localStorage.setItem(ACTIVE_KEY, 'sub-ana')
    vi.resetModules()
    const fresh = await import('@/stores/account')
    expect(fresh.useAccountStore.getState().active().id).toBe('sub-ana')
  })

  it('keeps each account cache in its own database and forgets only that one', async () => {
    const token = async () => 'unused'
    const ana = new DriveRepository('sub-ana', token)
    const bruno = new DriveRepository('sub-bruno', token)
    expect(ana.accountId).toBe('sub-ana')
    await new KeyValueStore('study-helper-drive-sub-ana').put('cache', 'md:1', 'ana cached')
    await new KeyValueStore('study-helper-drive-sub-bruno').put('cache', 'md:1', 'bruno cached')
    await ana.forget()
    await expect(new KeyValueStore('study-helper-drive-sub-ana').get('cache', 'md:1')).resolves.toBeUndefined()
    await expect(new KeyValueStore('study-helper-drive-sub-bruno').get('cache', 'md:1')).resolves.toBe('bruno cached')
    await bruno.forget()
  })
})
