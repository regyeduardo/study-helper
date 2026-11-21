import '@/test/account/storage-shim'
import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { mockEnv } = vi.hoisted(() => ({
  mockEnv: { googleClientId: 'client-id', authWorkerUrl: '', googleApiBase: 'https://api.example.test', googleAccountsScript: 'https://gsi.example.test/client', basePath: '/' },
}))

vi.mock('@/lib/env', () => ({ env: mockEnv }))

import { GooglePopupError, preloadGoogleAccounts } from '@/controllers/google-auth.controller'
import { authorizationUrl, finishGoogleRedirect, isIosBrowser, page, redirectUri } from '@/controllers/google-redirect.controller'
import { LOCAL_ACCOUNT_ID } from '@/lib/storage/local-repository'
import { LOCAL_ACCOUNT, useAccountStore } from '@/stores/account'
import { type GoogleFake, installFetch, installGoogle, WORKER, type WorkerFake } from '@/test/account/google-fakes'

const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1'
const PENDING_KEY = 'study-helper:google-redirect'
const ANA = { sub: 'sub-ana', name: 'Ana Souza', email: 'ana@example.com', picture: '' }

let google: GoogleFake
let server: WorkerFake
let leaving: ReturnType<typeof vi.spyOn>

function asIphone(): void {
  Object.defineProperty(navigator, 'userAgent', { configurable: true, value: IPHONE })
}

/** The address Google sends the person back to, with what it answered. */
function comeBack(query: string): void {
  window.history.replaceState(null, '', `/${query}`)
}

function leftFor(): URL {
  expect(leaving).toHaveBeenCalledTimes(1)
  return new URL(String(leaving.mock.calls[0][0]))
}

function pending(): { state: string; intent: unknown; durable: boolean; returnTo: string } {
  return JSON.parse(localStorage.getItem(PENDING_KEY)!)
}

beforeEach(() => {
  localStorage.clear()
  window.history.replaceState(null, '', '/')
  mockEnv.authWorkerUrl = WORKER
  mockEnv.basePath = '/'
  google = installGoogle()
  server = installFetch()
  server.profiles['access-1'] = ANA
  server.profiles['popup-token'] = ANA
  server.profiles['fragment-token'] = ANA
  leaving = vi.spyOn(page, 'go').mockImplementation(() => undefined)
  useAccountStore.setState({ accounts: [LOCAL_ACCOUNT], activeId: LOCAL_ACCOUNT_ID, reconnectId: null, reconnectMessage: '' })
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  delete window.google
  delete (navigator as { userAgent?: string }).userAgent
  document.head.querySelectorAll('script').forEach(script => script.remove())
})

describe('who signs in in the same tab', () => {
  it('knows an iPhone, an iPad and an iPad that says it is a Mac', () => {
    expect(isIosBrowser({ userAgent: IPHONE, platform: 'iPhone', maxTouchPoints: 5 })).toBe(true)
    expect(isIosBrowser({ userAgent: 'Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X)', platform: 'iPad', maxTouchPoints: 5 })).toBe(true)
    expect(isIosBrowser({ userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', platform: 'MacIntel', maxTouchPoints: 5 })).toBe(true)
  })

  it('leaves a computer alone, with or without a touch screen', () => {
    expect(isIosBrowser({ userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', platform: 'MacIntel', maxTouchPoints: 0 })).toBe(false)
    expect(isIosBrowser({ userAgent: 'Mozilla/5.0 (X11; Linux x86_64) Chrome/130', platform: 'Linux x86_64', maxTouchPoints: 10 })).toBe(false)
    expect(isIosBrowser({ userAgent: 'Mozilla/5.0 (Linux; Android 14) Chrome/130 Mobile', platform: 'Linux armv8l', maxTouchPoints: 5 })).toBe(false)
  })
})

describe('the Google address', () => {
  it('asks for a code and a refresh token with the worker, always with the consent screen', () => {
    const url = new URL(authorizationUrl({ state: 's1', durable: true, selectAccount: true }))
    expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth')
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      client_id: 'client-id',
      redirect_uri: `${window.location.origin}/`,
      response_type: 'code',
      access_type: 'offline',
      prompt: 'select_account consent',
      state: 's1',
    })
    expect(url.searchParams.get('scope')).toContain('drive.appdata')
  })

  it('asks for the token itself without the worker, and only picks the account', () => {
    const url = new URL(authorizationUrl({ state: 's2', durable: false, selectAccount: true }))
    expect(url.searchParams.get('response_type')).toBe('token')
    expect(url.searchParams.get('prompt')).toBe('select_account')
    expect(url.searchParams.has('access_type')).toBe(false)
  })

  it('reconnecting asks for consent and names the account', () => {
    const url = new URL(authorizationUrl({ state: 's3', durable: true, selectAccount: false, loginHint: 'ana@example.com' }))
    expect(url.searchParams.get('prompt')).toBe('consent')
    expect(url.searchParams.get('login_hint')).toBe('ana@example.com')
  })

  it('comes back to the front page of the app, under its base path', () => {
    mockEnv.basePath = '/estudo/'
    expect(redirectUri()).toBe(`${window.location.origin}/estudo/`)
    mockEnv.basePath = '/estudo'
    expect(redirectUri()).toBe(`${window.location.origin}/estudo/`)
  })
})

describe('sign-in on an iPhone', () => {
  it('goes to Google in the same tab and never opens the Google window', async () => {
    asIphone()
    void useAccountStore.getState().addGoogleAccount({ sendLocal: true })
    await vi.waitFor(() => expect(leaving).toHaveBeenCalled())
    expect(google.codeConfigs).toHaveLength(0)
    expect(google.tokenConfigs).toHaveLength(0)
    expect(leftFor().origin).toBe('https://accounts.google.com')
    expect(pending()).toMatchObject({ durable: true, intent: { kind: 'add', sendLocal: true }, returnTo: '/' })
    expect(leftFor().searchParams.get('state')).toBe(pending().state)
  })

  it('reads whether the Local profile has content before leaving', async () => {
    asIphone()
    void useAccountStore.getState().addGoogleAccount({ sendLocal: Promise.resolve(true) })
    await vi.waitFor(() => expect(leaving).toHaveBeenCalled())
    expect(pending().intent).toEqual({ kind: 'add', sendLocal: true })
  })

  it('remembers the screen the person was in', async () => {
    asIphone()
    window.history.replaceState(null, '', '/entrada/abc?aba=ata')
    void useAccountStore.getState().addGoogleAccount()
    await vi.waitFor(() => expect(leaving).toHaveBeenCalled())
    expect(pending().returnTo).toBe('/entrada/abc?aba=ata')
  })

  it('reconnecting an account goes the same way', async () => {
    asIphone()
    useAccountStore.setState({ accounts: [LOCAL_ACCOUNT, { id: 'sub-ana', kind: 'google', ...ANA, token: { accessToken: 'old', expiresAt: 0 } }], activeId: 'sub-ana' })
    void useAccountStore.getState().reauthorize('sub-ana')
    await vi.waitFor(() => expect(leaving).toHaveBeenCalled())
    expect(google.codeConfigs).toHaveLength(0)
    expect(pending().intent).toEqual({ kind: 'reauthorize', accountId: 'sub-ana' })
    expect(leftFor().searchParams.get('login_hint')).toBe('ana@example.com')
  })

  it('tells the person when the browser brings the page back without the sign-in', async () => {
    asIphone()
    const result = useAccountStore.getState().addGoogleAccount()
    const outcome = expect(result).rejects.toThrow(/não terminou/)
    await vi.waitFor(() => expect(leaving).toHaveBeenCalled())
    window.dispatchEvent(Object.assign(new Event('pageshow'), { persisted: true }))
    await outcome
    expect(localStorage.getItem(PENDING_KEY)).toBeNull()
  })

  it('says so when the browser will not keep the sign-in in progress', async () => {
    asIphone()
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('quota')
    })
    await expect(useAccountStore.getState().addGoogleAccount()).rejects.toThrow(/não deixou guardar o login/)
    expect(leaving).not.toHaveBeenCalled()
  })
})

describe('the Google window on other browsers', () => {
  it('opens inside the tap itself when the script is already there', async () => {
    const signIn = useAccountStore.getState().addGoogleAccount()
    expect(google.codeConfigs).toHaveLength(1)
    await signIn
  })

  it('opens inside the tap for the token flow too', async () => {
    mockEnv.authWorkerUrl = ''
    const signIn = useAccountStore.getState().addGoogleAccount()
    expect(google.tokenConfigs).toHaveLength(1)
    await signIn
  })

  it('brings the Google script in ahead of the tap', () => {
    delete window.google
    preloadGoogleAccounts()
    expect(document.head.querySelector('script[src="https://gsi.example.test/client"]')).not.toBeNull()
  })

  it('does not bring the Google script in without a client id', () => {
    delete window.google
    mockEnv.googleClientId = ''
    preloadGoogleAccounts()
    mockEnv.googleClientId = 'client-id'
    expect(document.head.querySelector('script')).toBeNull()
  })

  it('goes on in this tab when the browser blocks the window', async () => {
    google.codePopup = 'popup_failed_to_open'
    void useAccountStore.getState().addGoogleAccount({ sendLocal: true })
    await vi.waitFor(() => expect(leaving).toHaveBeenCalled())
    expect(pending()).toMatchObject({ durable: true, intent: { kind: 'add', sendLocal: true } })
  })

  it('goes on in this tab when the token window is blocked, without the worker', async () => {
    mockEnv.authWorkerUrl = ''
    google.tokenReplies.push('popup_failed_to_open')
    void useAccountStore.getState().addGoogleAccount()
    await vi.waitFor(() => expect(leaving).toHaveBeenCalled())
    expect(pending().durable).toBe(false)
    expect(leftFor().searchParams.get('response_type')).toBe('token')
  })

  it('does not leave the page when the window is closed: it says so and lets the person choose', async () => {
    google.codePopup = 'popup_closed'
    const failure = await useAccountStore.getState().addGoogleAccount().catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(GooglePopupError)
    expect((failure as GooglePopupError).reason).toBe('closed')
    expect((failure as Error).message).toBe('A janela do Google foi fechada.')
    expect(leaving).not.toHaveBeenCalled()
  })

  it('goes to Google in this tab when asked to', async () => {
    void useAccountStore.getState().addGoogleAccount({ redirect: true })
    await vi.waitFor(() => expect(leaving).toHaveBeenCalled())
    expect(google.codeConfigs).toHaveLength(0)
  })

  it('reconnecting also goes on in this tab when the window is blocked', async () => {
    useAccountStore.setState({ accounts: [LOCAL_ACCOUNT, { id: 'sub-ana', kind: 'google', ...ANA, token: { accessToken: 'old', expiresAt: 0 } }], activeId: 'sub-ana' })
    google.codePopup = 'popup_failed_to_open'
    void useAccountStore.getState().reauthorize('sub-ana')
    await vi.waitFor(() => expect(leaving).toHaveBeenCalled())
    expect(pending().intent).toEqual({ kind: 'reauthorize', accountId: 'sub-ana' })
  })
})

describe('coming back from Google', () => {
  async function leave(sendLocal = false): Promise<string> {
    asIphone()
    window.history.replaceState(null, '', '/biblioteca')
    void useAccountStore.getState().addGoogleAccount({ sendLocal })
    await vi.waitFor(() => expect(leaving).toHaveBeenCalled())
    return pending().state
  }

  it('trades the code for the token through the worker, with the same return address', async () => {
    const state = await leave(true)
    comeBack(`?code=the-code&state=${state}&scope=${encodeURIComponent('https://www.googleapis.com/auth/drive.appdata')}`)
    const done = await useAccountStore.getState().finishRedirectLogin()
    expect(done).toEqual({ returnTo: '/biblioteca', sendLocal: true })
    expect(server.calls.find(call => call.url === `${WORKER}/token`)?.body).toEqual({ code: 'the-code', redirect_uri: `${window.location.origin}/` })
    expect(useAccountStore.getState().activeId).toBe('sub-ana')
    expect(useAccountStore.getState().accounts.find(item => item.id === 'sub-ana')?.token).toMatchObject({ accessToken: 'access-1', refreshToken: 'refresh-1' })
    expect(localStorage.getItem(PENDING_KEY)).toBeNull()
  })

  it('takes the code and the token out of the address bar', async () => {
    const state = await leave()
    comeBack(`?code=the-code&state=${state}`)
    await useAccountStore.getState().finishRedirectLogin()
    expect(window.location.search).toBe('')
    expect(window.location.hash).toBe('')
  })

  it('takes the token from the address fragment when there is no worker', async () => {
    mockEnv.authWorkerUrl = ''
    const state = await leave()
    comeBack('')
    window.location.hash = `access_token=fragment-token&token_type=Bearer&expires_in=3000&scope=${encodeURIComponent('https://www.googleapis.com/auth/drive.appdata')}&state=${state}`
    const done = await useAccountStore.getState().finishRedirectLogin()
    expect(done).toEqual({ returnTo: '/biblioteca', sendLocal: false })
    expect(server.calls.filter(call => call.url.startsWith(WORKER))).toHaveLength(0)
    expect(useAccountStore.getState().accounts.find(item => item.id === 'sub-ana')?.token?.accessToken).toBe('fragment-token')
    expect(window.location.hash).toBe('')
  })

  it('ignores an address with a state this app did not ask for', async () => {
    await leave()
    comeBack('?code=the-code&state=another')
    await expect(finishGoogleRedirect()).resolves.toBeNull()
    expect(server.calls).toHaveLength(0)
    expect(window.location.search).toBe('?code=the-code&state=another')
    expect(pending()).toBeTruthy()
  })

  it('ignores a load that is not a return from Google', async () => {
    await expect(useAccountStore.getState().finishRedirectLogin()).resolves.toBeNull()
  })

  it('ignores an old sign-in that was never finished', async () => {
    const state = await leave()
    localStorage.setItem(PENDING_KEY, JSON.stringify({ ...pending(), at: Date.now() - 60 * 60_000 }))
    comeBack(`?code=the-code&state=${state}`)
    await expect(finishGoogleRedirect()).resolves.toBeNull()
  })

  it('tells the person when Google did not give the access, and keeps them where they were', async () => {
    const state = await leave()
    comeBack(`?error=access_denied&state=${state}`)
    const done = await useAccountStore.getState().finishRedirectLogin()
    expect(done).toEqual({ returnTo: '/biblioteca', message: 'O Google não liberou o acesso.' })
    expect(useAccountStore.getState().activeId).toBe(LOCAL_ACCOUNT_ID)
  })

  it('tells the person when the access came without the app folder', async () => {
    const state = await leave()
    comeBack(`?code=the-code&state=${state}&scope=openid`)
    const done = await useAccountStore.getState().finishRedirectLogin()
    expect(done?.message).toMatch(/pasta do app no seu Drive/)
    expect(server.calls).toHaveLength(0)
  })

  it('tells the person when the worker refuses the code', async () => {
    const state = await leave()
    server.tokenReply = { error: 'invalid_grant', error_description: 'Código vencido.' }
    comeBack(`?code=the-code&state=${state}`)
    const done = await useAccountStore.getState().finishRedirectLogin()
    expect(done).toEqual({ returnTo: '/biblioteca', message: 'Código vencido.' })
    expect(useAccountStore.getState().activeId).toBe(LOCAL_ACCOUNT_ID)
  })

  it('finishes a reconnection on the account that asked', async () => {
    asIphone()
    useAccountStore.setState({
      accounts: [LOCAL_ACCOUNT, { id: 'sub-ana', kind: 'google', ...ANA, token: { accessToken: 'old', expiresAt: 0 } }],
      activeId: 'sub-ana',
      reconnectId: 'sub-ana',
      reconnectMessage: 'O Google pediu pra você entrar de novo.',
    })
    void useAccountStore.getState().reauthorize('sub-ana')
    await vi.waitFor(() => expect(leaving).toHaveBeenCalled())
    comeBack(`?code=the-code&state=${pending().state}`)
    const done = await useAccountStore.getState().finishRedirectLogin()
    expect(done).toEqual({ returnTo: '/' })
    expect(useAccountStore.getState().reconnectId).toBeNull()
    expect(useAccountStore.getState().accounts.find(item => item.id === 'sub-ana')?.token).toMatchObject({ accessToken: 'access-1', refreshToken: 'refresh-1' })
  })
})
