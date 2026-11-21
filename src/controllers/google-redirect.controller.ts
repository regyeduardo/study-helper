import {
  callAuthWorker,
  checkDriveScope,
  type GoogleToken,
  GoogleAuthError,
  isDurableLoginConfigured,
  SCOPES,
  tokenFromWorker,
} from '@/controllers/google-auth.controller'
import { env } from '@/lib/env'

/**
 * Sign-in in the same tab: the browser goes to Google and comes back to the app with the answer in the address.
 * It is the road for iPhone and iPad (a window opened after a wait is dropped there, and the answer of a window can be lost)
 * and the fallback whenever the Google window cannot be used.
 */

const PENDING_KEY = 'study-helper:google-redirect'
const PENDING_TTL_MS = 15 * 60_000
const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth'

/** Leaving for another address, kept apart so a test can watch it. */
export const page = { go: (url: string) => window.location.assign(url) }

export type RedirectIntent = { kind: 'add'; sendLocal: boolean } | { kind: 'reauthorize'; accountId: string }

interface Pending {
  state: string
  durable: boolean
  intent: RedirectIntent
  returnTo: string
  at: number
}

export type RedirectOutcome =
  | { ok: true; intent: RedirectIntent; durable: boolean; token: GoogleToken; returnTo: string }
  | { ok: false; message: string; returnTo: string }

/** iPhone, iPad (also the iPad that says it is a Mac) and iPod, in Safari, in another browser or in the home-screen app. */
export function isIosBrowser(nav: Pick<Navigator, 'userAgent' | 'platform' | 'maxTouchPoints'> = navigator): boolean {
  return /iPad|iPhone|iPod/.test(nav.userAgent) || (nav.platform === 'MacIntel' && nav.maxTouchPoints > 1)
}

export function prefersRedirectLogin(): boolean {
  return isIosBrowser()
}

/** The address Google sends the person back to: the app's own front page. It must be listed in the Google Cloud console. */
export function redirectUri(): string {
  const base = `/${env.basePath.replace(/^\/+|\/+$/g, '')}`
  return `${window.location.origin}${base === '/' ? '/' : `${base}/`}`
}

/** Where the person was, relative to the router's base, so the sign-in can bring them back to it. */
function currentAppPath(): string {
  const base = env.basePath.replace(/\/+$/, '')
  const path = base && window.location.pathname.startsWith(base) ? window.location.pathname.slice(base.length) : window.location.pathname
  return `${path || '/'}${window.location.search}`
}

function randomState(): string {
  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)
  return [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('')
}

function readPending(): Pending | null {
  try {
    const pending = JSON.parse(localStorage.getItem(PENDING_KEY) ?? 'null') as Pending | null
    if (!pending || typeof pending.state !== 'string' || Date.now() - pending.at > PENDING_TTL_MS) return null
    return pending
  } catch {
    return null
  }
}

function clearPending(): void {
  try {
    localStorage.removeItem(PENDING_KEY)
  } catch {
    return
  }
}

export function authorizationUrl(options: { state: string; durable: boolean; selectAccount: boolean; loginHint?: string }): string {
  const params = new URLSearchParams({
    client_id: env.googleClientId,
    redirect_uri: redirectUri(),
    response_type: options.durable ? 'code' : 'token',
    scope: SCOPES,
    state: options.state,
  })
  if (options.durable) params.set('access_type', 'offline')
  // A refresh token only comes with the consent screen, so the long-lived login always asks for it.
  const prompts = [options.selectAccount ? 'select_account' : '', options.durable || !options.selectAccount ? 'consent' : ''].filter(Boolean)
  if (prompts.length) params.set('prompt', prompts.join(' '))
  if (options.loginHint) params.set('login_hint', options.loginHint)
  return `${AUTH_URL}?${params}`
}

let stopWaiting: (() => void) | null = null

/** Leaves for Google. The promise never resolves: the page is gone. It rejects only if the browser brings this page back from its cache. */
export function startGoogleRedirect(options: { intent: RedirectIntent; selectAccount: boolean; loginHint?: string }): Promise<never> {
  if (!env.googleClientId) return Promise.reject(new GoogleAuthError('O login do Google não está configurado neste app (falta VITE_GOOGLE_CLIENT_ID).'))
  const durable = isDurableLoginConfigured()
  const state = randomState()
  const pending: Pending = { state, durable, intent: options.intent, returnTo: currentAppPath(), at: Date.now() }
  try {
    localStorage.setItem(PENDING_KEY, JSON.stringify(pending))
  } catch {
    return Promise.reject(new GoogleAuthError('O navegador não deixou guardar o login. Saia da aba privada e tente de novo.'))
  }
  return new Promise<never>((_, reject) => {
    // Back from Google with the browser's back button: the page returns as it was, still waiting.
    stopWaiting?.()
    const onShow = (event: PageTransitionEvent) => {
      if (!event.persisted) return
      stopWaiting?.()
      clearPending()
      reject(new GoogleAuthError('O login do Google não terminou. Tente de novo.'))
    }
    window.addEventListener('pageshow', onShow)
    stopWaiting = () => {
      window.removeEventListener('pageshow', onShow)
      stopWaiting = null
    }
    page.go(authorizationUrl({ state, durable, selectAccount: options.selectAccount, loginHint: options.loginHint }))
  })
}

const DENIED = 'O Google não liberou o acesso.'

function answerParams(): URLSearchParams | null {
  const query = new URLSearchParams(window.location.search)
  if (query.has('state')) return query
  const fragment = new URLSearchParams(window.location.hash.replace(/^#/, ''))
  return fragment.has('state') ? fragment : null
}

/**
 * Reads the answer Google left in the address when the person comes back, and trades it for a token.
 * Null when this load is not a return from Google (or not one this app asked for).
 */
export async function finishGoogleRedirect(): Promise<RedirectOutcome | null> {
  const params = answerParams()
  if (!params) return null
  const pending = readPending()
  if (!pending || pending.state !== params.get('state')) return null
  clearPending()
  // The answer (a code, or the token itself) does not stay in the address bar or the history.
  window.history.replaceState(window.history.state, '', window.location.pathname)
  const returnTo = pending.returnTo
  const fail = (message: string): RedirectOutcome => ({ ok: false, message, returnTo })
  const error = params.get('error')
  if (error) return fail(error === 'access_denied' ? DENIED : params.get('error_description') || DENIED)
  try {
    if (pending.durable) {
      const code = params.get('code')
      if (!code) return fail(DENIED)
      checkDriveScope(params.get('scope') ?? undefined)
      const body = await callAuthWorker('/token', { code, redirect_uri: redirectUri() })
      if (!body.access_token) return fail(body.error_description || 'O Google recusou o login. Tente de novo.')
      checkDriveScope(body.scope)
      return { ok: true, intent: pending.intent, durable: true, token: tokenFromWorker(body), returnTo }
    }
    const accessToken = params.get('access_token')
    if (!accessToken) return fail(DENIED)
    checkDriveScope(params.get('scope') ?? undefined)
    const token: GoogleToken = { accessToken, expiresAt: Date.now() + (Number(params.get('expires_in')) || 3600) * 1000 }
    return { ok: true, intent: pending.intent, durable: false, token, returnTo }
  } catch (failure) {
    return fail(failure instanceof Error ? failure.message : 'O login do Google falhou.')
  }
}
