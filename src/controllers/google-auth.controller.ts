import { env } from '@/lib/env'

export const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.file'
export const HIDDEN_SCOPE = 'https://www.googleapis.com/auth/drive.appdata'
const SCOPES = HIDDEN_SCOPE

export interface GoogleToken {
  accessToken: string
  expiresAt: number
  refreshToken?: string
}

export interface GoogleProfile {
  sub: string
  name: string
  email: string
  picture: string
}

interface TokenResponse {
  access_token?: string
  expires_in?: number
  scope?: string
  error?: string
  error_description?: string
}

interface TokenClient {
  requestAccessToken(options?: { prompt?: string; login_hint?: string }): void
}

interface CodeResponse {
  code?: string
  scope?: string
  error?: string
  error_description?: string
}

interface CodeClient {
  requestCode(): void
}

interface WorkerTokenResponse {
  access_token?: string
  expires_in?: number
  refresh_token?: string
  scope?: string
  error?: string
  error_description?: string
}

interface GoogleAccounts {
  oauth2: {
    initTokenClient(config: {
      client_id: string
      scope: string
      callback: (response: TokenResponse) => void
      error_callback?: (error: { type?: string; message?: string }) => void
    }): TokenClient
    initCodeClient(config: {
      client_id: string
      scope: string
      ux_mode: 'popup'
      select_account?: boolean
      login_hint?: string
      callback: (response: CodeResponse) => void
      error_callback?: (error: { type?: string; message?: string }) => void
    }): CodeClient
    revoke(token: string, done?: () => void): void
  }
}

declare global {
  interface Window {
    google?: { accounts: GoogleAccounts }
  }
}

export class GoogleAuthError extends Error {}

export class GoogleReconnectError extends GoogleAuthError {}

let scriptLoading: Promise<GoogleAccounts> | null = null

function loadAccounts(): Promise<GoogleAccounts> {
  if (window.google?.accounts) return Promise.resolve(window.google.accounts)
  if (!scriptLoading) {
    scriptLoading = new Promise((resolve, reject) => {
      const script = document.createElement('script')
      script.src = env.googleAccountsScript
      script.async = true
      script.onload = () => (window.google?.accounts ? resolve(window.google.accounts) : reject(new GoogleAuthError('O login do Google não carregou.')))
      script.onerror = () => {
        scriptLoading = null
        reject(new GoogleAuthError('Não consegui carregar o login do Google. Confira a internet.'))
      }
      document.head.appendChild(script)
    })
  }
  return scriptLoading
}

export function isGoogleLoginConfigured(): boolean {
  return Boolean(env.googleClientId)
}

export function isDurableLoginConfigured(): boolean {
  return Boolean(env.authWorkerUrl)
}

function popupMessage(error: { type?: string; message?: string }): string {
  if (error.type === 'popup_closed') return 'A janela do Google foi fechada.'
  if (error.type === 'popup_failed_to_open') return 'O navegador bloqueou a janela do Google. Libere as janelas deste site e tente de novo.'
  return error.message ?? 'O login do Google falhou.'
}

const MISSING_HIDDEN_FOLDER = 'O Google não liberou a pasta do app no seu Drive; sem ela o app não tem onde guardar. Entre de novo e confirme o acesso.'

function checkDriveScope(scope: string | undefined): void {
  if (scope && !scope.split(' ').includes(HIDDEN_SCOPE)) throw new GoogleAuthError(MISSING_HIDDEN_FOLDER)
}

async function callAuthWorker(path: '/token' | '/refresh', payload: Record<string, string>): Promise<WorkerTokenResponse> {
  let response: Response
  try {
    response = await fetch(`${env.authWorkerUrl}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
  } catch {
    throw new GoogleAuthError('Não consegui falar com o serviço de login. Confira a internet.')
  }
  return (await response.json().catch(() => ({}))) as WorkerTokenResponse
}

function tokenFromWorker(body: WorkerTokenResponse): GoogleToken {
  return {
    accessToken: body.access_token!,
    expiresAt: Date.now() + (body.expires_in ?? 3600) * 1000,
    refreshToken: body.refresh_token,
  }
}

export async function requestGoogleCodeController(options: { selectAccount: boolean; loginHint?: string }): Promise<GoogleToken> {
  if (!env.googleClientId) throw new GoogleAuthError('O login do Google não está configurado neste app (falta VITE_GOOGLE_CLIENT_ID).')
  const accounts = await loadAccounts()
  const code = await new Promise<CodeResponse>((resolve, reject) => {
    const client = accounts.oauth2.initCodeClient({
      client_id: env.googleClientId,
      scope: SCOPES,
      ux_mode: 'popup',
      select_account: options.selectAccount,
      login_hint: options.loginHint,
      callback: resolve,
      error_callback: error => reject(new GoogleAuthError(popupMessage(error))),
    })
    client.requestCode()
  })
  if (code.error || !code.code) throw new GoogleAuthError(code.error_description || 'O Google não liberou o acesso.')
  checkDriveScope(code.scope)
  const body = await callAuthWorker('/token', { code: code.code })
  if (!body.access_token) throw new GoogleAuthError(body.error_description || 'O Google recusou o login. Tente de novo.')
  checkDriveScope(body.scope)
  return tokenFromWorker(body)
}

export async function refreshGoogleTokenController(refreshToken: string): Promise<GoogleToken> {
  const body = await callAuthWorker('/refresh', { refresh_token: refreshToken })
  if (body.error === 'invalid_grant') throw new GoogleReconnectError('O Google pediu pra você entrar de novo.')
  if (!body.access_token) throw new GoogleAuthError('Não consegui renovar o acesso ao Google. Tente de novo em instantes.')
  return { ...tokenFromWorker(body), refreshToken: body.refresh_token ?? refreshToken }
}

export async function requestGoogleTokenController(options: { prompt: '' | 'consent' | 'select_account'; loginHint?: string }): Promise<GoogleToken> {
  if (!env.googleClientId) throw new GoogleAuthError('O login do Google não está configurado neste app (falta VITE_GOOGLE_CLIENT_ID).')
  const accounts = await loadAccounts()
  return new Promise((resolve, reject) => {
    const client = accounts.oauth2.initTokenClient({
      client_id: env.googleClientId,
      scope: SCOPES,
      callback: response => {
        if (response.error || !response.access_token) {
          reject(new GoogleAuthError(response.error_description || 'O Google não liberou o acesso.'))
          return
        }
        if (response.scope && !response.scope.split(' ').includes(HIDDEN_SCOPE)) {
          reject(new GoogleAuthError(MISSING_HIDDEN_FOLDER))
          return
        }
        resolve({ accessToken: response.access_token, expiresAt: Date.now() + (response.expires_in ?? 3600) * 1000 })
      },
      error_callback: error => reject(new GoogleAuthError(popupMessage(error))),
    })
    client.requestAccessToken({ prompt: options.prompt, login_hint: options.loginHint })
  })
}

export async function getGoogleProfileController(accessToken: string): Promise<GoogleProfile> {
  const fields = new URLSearchParams({ fields: 'user(displayName,emailAddress,photoLink,permissionId)' })
  const response = await fetch(`${env.googleApiBase}/drive/v3/about?${fields}`, { headers: { Authorization: `Bearer ${accessToken}` } })
  if (!response.ok) throw new GoogleAuthError('Não consegui ler o seu perfil do Google.')
  const user = ((await response.json()) as { user?: { displayName?: string; emailAddress?: string; photoLink?: string; permissionId?: string } }).user
  if (!user?.permissionId) throw new GoogleAuthError('O Google não devolveu a sua conta.')
  return { sub: user.permissionId, name: user.displayName ?? user.emailAddress ?? 'Conta Google', email: user.emailAddress ?? '', picture: user.photoLink ?? '' }
}

export async function revokeGoogleTokenController(accessToken: string): Promise<void> {
  try {
    const accounts = await loadAccounts()
    await new Promise<void>(resolve => accounts.oauth2.revoke(accessToken, resolve))
  } catch {
    return
  }
}
