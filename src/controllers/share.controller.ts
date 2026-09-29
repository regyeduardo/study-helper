import type { FileSidecar, ShareContent, SharedFile, SharedFolder, SharedItem } from '@/types/domain'
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

interface ShareManifest {
  version: number
  id: string
  kind: SharedItem['kind']
  title: string
  createdAt: string
  expiresAt: string
  folders: { id: string; path: string }[]
  files: { id: string; path: string }[]
}

function sharedPathUrl(id: string, path: string): string {
  return `${env.sharedFilesUrl}/shared/${encodeURIComponent(id)}/${path.split('/').map(encodeURIComponent).join('/')}`
}

async function sharedText(id: string, path: string): Promise<string | null> {
  const response = await fetch(sharedPathUrl(id, path)).catch(() => null)
  return response?.ok ? response.text() : null
}

async function sharedJson<T>(id: string, path: string): Promise<T | null> {
  const text = await sharedText(id, path)
  try {
    return text === null ? null : (JSON.parse(text) as T)
  } catch {
    return null
  }
}

export async function fetchSharedItemController(id: string): Promise<SharedItem | null> {
  const manifest = await sharedJson<ShareManifest>(id, 'share.json')
  if (!manifest || !Array.isArray(manifest.files)) return null
  const folders = await Promise.all(manifest.folders.map(entry => sharedJson<SharedFolder>(id, `${entry.path}.folder.json`)))
  const files = await Promise.all(
    manifest.files.map(async entry => {
      const [content, sidecar] = await Promise.all([sharedText(id, `${entry.path}.md`), sharedJson<FileSidecar>(id, `${entry.path}.json`)])
      if (content === null || !sidecar) return null
      const { meta } = sidecar
      const file: SharedFile = { id: entry.id, name: meta.name, folderId: meta.folderId, type: meta.type, position: meta.position, description: meta.description, tags: meta.tags ?? [], content, questions: sidecar.questions ?? [], highlights: sidecar.highlights ?? [], ...(sidecar.transcript !== undefined ? { transcript: sidecar.transcript } : {}), meta }
      return file
    }),
  )
  if (folders.includes(null) || files.includes(null)) return null
  return { version: manifest.version, id: manifest.id, kind: manifest.kind, title: manifest.title, createdAt: manifest.createdAt, expiresAt: manifest.expiresAt, folders: folders as SharedFolder[], files: files as SharedFile[] }
}
