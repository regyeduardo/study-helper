import type { FileSidecar, ShareContent, SharedFile, SharedFolder, SharedItem } from '@/types/domain'
import type { TokenProvider } from '@/controllers/drive.controller'
import { env } from '@/lib/env'

export interface CreatedShare {
  id: string
  createdAt: string
  expiresAt: string
  mediaExpiresAt?: string
  bytes: number
}

interface WorkerError {
  error?: string
}

interface MediaPart {
  partNumber: number
  etag: string
}

export const MEDIA_PART_BYTES = 10 * 1024 * 1024

const ERROR_MESSAGES: Record<string, string> = {
  login_required: 'Entre com o Google para compartilhar.',
  turnstile_failed: 'A verificação anti-robô não passou. Tente de novo.',
  text_only: 'Só dá para compartilhar texto.',
  media_only: 'Só dá para enviar áudio ou vídeo.',
  media_expired: 'A mídia deste compartilhamento expirou (fica 3 dias).',
  not_owner: 'Só quem compartilhou pode apagar.',
  not_found: 'Esse compartilhamento não existe mais.',
}

export class ShareError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message)
  }
}

export function isShareConfigured(): boolean {
  return Boolean(env.shareWorkerUrl && env.sharedFilesUrl)
}

export function sharedMediaUrl(shareId: string, fileId: string): string {
  return `${env.shareWorkerUrl}/media/${encodeURIComponent(shareId)}/${encodeURIComponent(fileId)}`
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
  throw new ShareError(response.status, code, ERROR_MESSAGES[code] ?? 'O compartilhamento falhou. Tente de novo.')
}

export function createShareController(token: TokenProvider, turnstileToken: string, share: ShareContent): Promise<CreatedShare> {
  return call<CreatedShare>(token, '/shares', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ turnstileToken, share }) })
}

export async function deleteShareController(token: TokenProvider, id: string): Promise<void> {
  await call<unknown>(token, `/shares/${encodeURIComponent(id)}`, { method: 'DELETE' })
}

export async function uploadShareMediaController(token: TokenProvider, shareId: string, fileId: string, media: Blob, mime: string, onSent: (bytes: number) => void): Promise<number> {
  const base = `/shares/${encodeURIComponent(shareId)}/media/${encodeURIComponent(fileId)}`
  const json = { 'Content-Type': 'application/json' }
  const { uploadId } = await call<{ uploadId: string }>(token, base, { method: 'POST', headers: json, body: JSON.stringify({ mime }) })
  const parts: MediaPart[] = []
  for (let offset = 0; offset < media.size; offset += MEDIA_PART_BYTES) {
    const chunk = media.slice(offset, offset + MEDIA_PART_BYTES)
    parts.push(await call<MediaPart>(token, `${base}/${parts.length + 1}?uploadId=${encodeURIComponent(uploadId)}`, { method: 'PUT', headers: { 'Content-Type': 'application/octet-stream' }, body: chunk }))
    onSent(offset + chunk.size)
  }
  const done = await call<{ size: number }>(token, `${base}/done`, { method: 'POST', headers: json, body: JSON.stringify({ uploadId, parts }) })
  return done.size
}

interface ShareManifest {
  version: number
  id: string
  kind: SharedItem['kind']
  title: string
  createdAt: string
  expiresAt: string
  mediaExpiresAt?: string
  folders: { id: string; path: string }[]
  files: { id: string; path: string; media?: { mime: string; size: number } }[]
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
      const file: SharedFile = { id: entry.id, name: meta.name, folderId: meta.folderId, type: meta.type, position: meta.position, description: meta.description, tags: meta.tags ?? [], content, questions: sidecar.questions ?? [], highlights: sidecar.highlights ?? [], ...(sidecar.transcript !== undefined ? { transcript: sidecar.transcript } : {}), ...(sidecar.recording ? { recording: sidecar.recording } : {}), ...(sidecar.documents ? { documents: sidecar.documents } : {}), ...(entry.media ? { media: { url: sharedMediaUrl(id, entry.id), mime: entry.media.mime, size: entry.media.size } } : {}), meta }
      return file
    }),
  )
  if (folders.includes(null) || files.includes(null)) return null
  return { version: manifest.version, id: manifest.id, kind: manifest.kind, title: manifest.title, createdAt: manifest.createdAt, expiresAt: manifest.expiresAt, ...(manifest.mediaExpiresAt ? { mediaExpiresAt: manifest.mediaExpiresAt } : {}), folders: folders as SharedFolder[], files: files as SharedFile[] }
}
