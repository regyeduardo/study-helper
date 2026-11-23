import { env } from '@/lib/env'

/** The account as the backend tells it (`GET /v1/me`, spec 003, contracts/api-conta.md, names in English). */
export interface ServerUser {
  id: string
  email: string
  name: string | null
  photoUrl: string | null
  status: 'no-code' | 'enabled' | 'revoked'
  appEnabled: boolean
  admin: boolean
  deleteAt: string | null
  hasPassword: boolean
  hasGoogle: boolean
  /** When the person's hierarchy was taken to the account (spec 005, R8); null or absent = still the way of before. */
  hierarchyAt?: string | null
}

export interface ServerMe {
  user: ServerUser
  requireCode: boolean
  device: { id: string; name: string }
  space: { notes: number; media: number; reserved: number; limit: number; warnAt: number }
}

export interface ServerDevice {
  id: string
  name: string
  seenAt: string
  current: boolean
}

export interface PromoCode {
  id: string
  code: string
  maxUses: number
  uses: number
  validUntil: string
  madeFor: string
  status: 'active' | 'used-up' | 'expired' | 'canceled'
  createdAt: string
  accounts: { id: string; name: string; email: string; usedAt: string }[]
}

export interface AdminAccount {
  id: string
  name: string
  email: string
  status: ServerUser['status']
  appEnabled: boolean
  enabledAt: string | null
  deleteAt: string | null
  code: string | null
  seenAt: string | null
  space: { notes: number; media: number; limit: number }
}

/** A refusal of the backend: the code and its data; the app writes the sentence (`apiMessage`). */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly data: Record<string, unknown> = {},
  ) {
    super(code)
    this.name = 'ApiError'
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = {}
  if (method !== 'GET') headers['X-Estudo'] = '1'
  if (body !== undefined) headers['Content-Type'] = 'application/json'
  let response: Response
  try {
    response = await fetch(`${env.apiUrl}${path}`, { method, credentials: 'include', headers, body: body === undefined ? undefined : JSON.stringify(body) })
  } catch {
    throw new ApiError(0, 'offline')
  }
  const answer = (await response.json().catch(() => ({}))) as Record<string, unknown>
  if (!response.ok) {
    const { error, ...data } = answer
    throw new ApiError(response.status, typeof error === 'string' ? error : 'internal_error', data)
  }
  return answer as T
}

/** Who is signed in; null when nobody is. */
export async function getMe(): Promise<ServerMe | null> {
  try {
    return await request<ServerMe>('GET', '/v1/me')
  } catch (error) {
    if (error instanceof ApiError && error.code === 'no_session') return null
    throw error
  }
}

/** Where "Entrar com o Google" goes: the server does the sign-in and comes back to `returnTo`, a path of the app. */
export function googleSignInUrl(returnTo: string): string {
  return `${env.apiUrl}/v1/auth/google/start?return_to=${encodeURIComponent(returnTo)}`
}

export const loginWithPassword = (email: string, password: string) => request<{ user: { id: string; email: string } }>('POST', '/v1/auth/password/login', { email, password })
export const registerWithPassword = (email: string, password: string, name: string) =>
  request<{ user: { id: string; email: string } }>('POST', '/v1/auth/password/register', { email, password, name })
export const logout = () => request<{ ok: true }>('POST', '/v1/auth/logout')
/** Opens the server session with the Google access token the app already holds (no second sign-in screen). */
export const loginWithGoogleToken = (accessToken: string) => request<{ ok: true }>('POST', '/v1/auth/google/token', { accessToken })

export const redeemCode = (code: string) => request<{ status: 'enabled'; alreadyEnabled?: boolean }>('POST', '/v1/code/use', { code })
export const setStructure = (on: boolean) => request<{ appEnabled: boolean }>('POST', '/v1/structure', { on })

export const listDevices = () => request<{ devices: ServerDevice[] }>('GET', '/v1/devices').then(answer => answer.devices)
export const renameDevice = (id: string, name: string) => request<{ ok: true }>('PATCH', `/v1/devices/${encodeURIComponent(id)}`, { name })
export const signOutDevice = (id: string) => request<{ ok: true }>('DELETE', `/v1/devices/${encodeURIComponent(id)}`)

export const adminCodes = () => request<{ codes: PromoCode[] }>('GET', '/v1/admin/codes').then(answer => answer.codes)
export const adminCreateCode = (options: { maxUses?: number; validUntil?: string; madeFor?: string } = {}) => request<PromoCode>('POST', '/v1/admin/codes', options)
export const adminCancelCode = (id: string) => request<{ ok: true }>('POST', `/v1/admin/codes/${encodeURIComponent(id)}/cancel`)
export const adminAccounts = () => request<{ accounts: AdminAccount[] }>('GET', '/v1/admin/accounts').then(answer => answer.accounts)
export const adminRevoke = (id: string) => request<{ deleteAt: string }>('POST', `/v1/admin/accounts/${encodeURIComponent(id)}/revoke`)
export const adminSettings = () => request<{ requireCode: boolean }>('GET', '/v1/admin/settings')
export const adminSetSettings = (requireCode: boolean) => request<{ requireCode: boolean }>('PUT', '/v1/admin/settings', { requireCode })
/** Spec 006: the app's AI for a person with the structure on (never a key) and the administration's choice of it. */
export const appAi = () => request<{ providers: string[]; uses: unknown }>('GET', '/v1/ai/config')
export const adminAi = () => request<{ providers: string[]; known: string[]; uses: unknown }>('GET', '/v1/admin/ai')
export const adminSetAi = (uses: unknown) => request<{ uses: unknown }>('PUT', '/v1/admin/ai', { uses })

function day(value: unknown): string {
  const date = new Date(String(value))
  if (Number.isNaN(date.getTime())) return ''
  return date.toLocaleDateString('pt-BR', { timeZone: 'UTC' })
}

function hour(value: unknown): string {
  const date = new Date(String(value))
  if (Number.isNaN(date.getTime())) return ''
  return date.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })
}

/** The sentence the person reads for each refusal (spec 003, história 1, cenários 5 a 8). */
export function apiMessage(error: unknown): string {
  if (!(error instanceof ApiError)) return error instanceof Error ? error.message : 'Não deu certo. Tente de novo.'
  switch (error.code) {
    case 'offline':
      return 'Não deu para falar com o servidor. Confira a internet e tente de novo.'
    case 'code_not_found':
      return 'Código não encontrado. Confira as letras e tente de novo.'
    case 'code_expired':
      return `Este código venceu em ${day(error.data.expiredAt)}. Peça um novo a quem te enviou.`
    case 'code_used_up':
      return 'Este código já foi usado por todas as pessoas que ele permite. Peça um novo a quem te enviou.'
    case 'code_canceled':
      return 'Este código foi cancelado. Peça um novo a quem te enviou.'
    case 'too_many_attempts':
      return `Muitas tentativas erradas. Tente de novo depois das ${hour(error.data.retryAfter)}.`
    case 'code_required':
      return 'Para usar a estrutura do app, digite o código que você recebeu.'
    case 'wrong_credentials':
      return 'E-mail ou senha errados.'
    case 'email_taken':
      return 'Já existe uma conta com este e-mail. Entre com ele.'
    case 'invalid_email':
      return 'Confira o e-mail.'
    case 'weak_password':
      return `A senha precisa de pelo menos ${Number(error.data.minLength) || 8} caracteres.`
    case 'no_session':
      return 'Entre na sua conta para continuar.'
    case 'access_revoked':
      return `O acesso desta conta foi retirado. Tudo será apagado em ${day(error.data.deleteAt)}.`
    default:
      return 'Não deu certo. Tente de novo.'
  }
}
