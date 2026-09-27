import { env } from '@/lib/env'

export const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.file'
const SCOPES = `${DRIVE_SCOPE} openid email profile`

export interface GoogleToken {
  accessToken: string
  expiresAt: number
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

interface GoogleAccounts {
  oauth2: {
    initTokenClient(config: {
      client_id: string
      scope: string
      callback: (response: TokenResponse) => void
      error_callback?: (error: { type?: string; message?: string }) => void
    }): TokenClient
    revoke(token: string, done?: () => void): void
  }
}

declare global {
  interface Window {
    google?: { accounts: GoogleAccounts }
  }
}

export class GoogleAuthError extends Error {}

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
        if (response.scope && !response.scope.split(' ').includes(DRIVE_SCOPE)) {
          reject(new GoogleAuthError('Na tela do Google, marque a caixa que dá acesso ao Google Drive; sem ela o app não tem onde guardar.'))
          return
        }
        resolve({ accessToken: response.access_token, expiresAt: Date.now() + (response.expires_in ?? 3600) * 1000 })
      },
      error_callback: error => reject(new GoogleAuthError(error.type === 'popup_closed' ? 'A janela do Google foi fechada.' : (error.message ?? 'O login do Google falhou.'))),
    })
    client.requestAccessToken({ prompt: options.prompt, login_hint: options.loginHint })
  })
}

export async function getGoogleProfileController(accessToken: string): Promise<GoogleProfile> {
  const response = await fetch(`${env.googleApiBase}/oauth2/v3/userinfo`, { headers: { Authorization: `Bearer ${accessToken}` } })
  if (!response.ok) throw new GoogleAuthError('Não consegui ler o seu perfil do Google.')
  const body = (await response.json()) as Partial<GoogleProfile>
  if (!body.sub) throw new GoogleAuthError('O Google não devolveu a sua conta.')
  return { sub: body.sub, name: body.name ?? body.email ?? 'Conta Google', email: body.email ?? '', picture: body.picture ?? '' }
}

export async function revokeGoogleTokenController(accessToken: string): Promise<void> {
  try {
    const accounts = await loadAccounts()
    await new Promise<void>(resolve => accounts.oauth2.revoke(accessToken, resolve))
  } catch {
    return
  }
}
