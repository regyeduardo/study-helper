import type { ShareContent, SharedItem } from '@/types/domain'
import type { TokenProvider } from '@/controllers/drive.controller'
import { env } from '@/lib/env'
import { formatBytes } from '@/utils/format'

export interface ShareQuota {
  remaining: number
}

export interface CreatedShare {
  id: string
  createdAt: string
  expiresAt: string
  bytes: number
  remaining: number
}

export interface DeletedShare {
  returned: number
  remaining: number
}

interface WorkerError {
  error?: string
  remaining?: number
}

const LIMIT_MESSAGES: Record<string, string> = {
  account_limit: 'Passou do limite de hoje da sua conta',
  ip_limit: 'Passou do limite de hoje desta rede',
  site_limit: 'O site chegou ao limite de compartilhamentos de hoje',
}

const ERROR_MESSAGES: Record<string, string> = {
  login_required: 'Entre com o Google para compartilhar.',
  turnstile_failed: 'A verificação anti-robô não passou. Tente de novo.',
  text_only: 'Só dá para compartilhar texto.',
  not_owner: 'Só quem compartilhou pode apagar.',
  not_found: 'Esse compartilhamento não existe mais.',
}

export class ShareError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly remaining: number | null = null,
  ) {
    super(message)
  }
}

export function isShareConfigured(): boolean {
  return Boolean(env.shareWorkerUrl && env.sharedFilesUrl)
}

export function limitMessage(code: string, remaining: number): string {
  return `${LIMIT_MESSAGES[code] ?? LIMIT_MESSAGES.account_limit}: ainda dá para compartilhar ${formatBytes(remaining)}.`
}

async function send(token: string, path: string, init: RequestInit): Promise<Response> {
  return fetch(`${env.shareWorkerUrl}${path}`, { ...init, headers: { Authorization: `Bearer ${token}`, ...(init.headers ?? {}) } })
}

async function call<T>(token: TokenProvider, path: string, init: RequestInit = {}): Promise<T> {
  let response: Response
  try {
    response = await send(await token(), path, init)
    if (response.status === 401) response = await send(await token({ force: true }), path, init)
  } catch {
    throw new ShareError(0, 'network', 'Não consegui falar com o serviço de compartilhamento.')
  }
  const body = (await response.json().catch(() => ({}))) as T & WorkerError
  if (response.ok) return body
  const code = body.error ?? 'unknown'
  if (LIMIT_MESSAGES[code]) throw new ShareError(response.status, code, limitMessage(code, body.remaining ?? 0), body.remaining ?? 0)
  throw new ShareError(response.status, code, ERROR_MESSAGES[code] ?? 'O compartilhamento falhou. Tente de novo.')
}

export function fetchShareQuotaController(token: TokenProvider): Promise<ShareQuota> {
  return call<ShareQuota>(token, '/quota')
}

export function createShareController(token: TokenProvider, turnstileToken: string, share: ShareContent): Promise<CreatedShare> {
  return call<CreatedShare>(token, '/shares', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ turnstileToken, share }) })
}

export function deleteShareController(token: TokenProvider, id: string): Promise<DeletedShare> {
  return call<DeletedShare>(token, `/shares/${encodeURIComponent(id)}`, { method: 'DELETE' })
}

export async function fetchSharedItemController(id: string): Promise<SharedItem | null> {
  const response = await fetch(`${env.sharedFilesUrl}/shared/${encodeURIComponent(id)}.json`).catch(() => null)
  if (!response?.ok) return null
  return (await response.json().catch(() => null)) as SharedItem | null
}
