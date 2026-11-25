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

/** A media the app is about to send, told to the Worker with the text so the link says it is coming. */
export interface PlannedMedia {
  fileId: string
  mime: string
  size: number
}

/** The answer of the update of a link in place: `media` is what was already in the link and stays (it is not sent again). */
export interface UpdatedShare extends CreatedShare {
  updatedAt: string
  media: PlannedMedia[]
}

/** What the Worker knows about a link of this account: the media in it, and the notes whose media is still going up. */
export interface ShareStatus {
  id: string
  kind: SharedItem['kind']
  title: string
  createdAt: string
  updatedAt?: string
  expiresAt: string
  mediaExpiresAt?: string
  media: PlannedMedia[]
  pending: string[]
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
  share_gone: 'Esse compartilhamento não existe mais.',
  expired: 'Esse compartilhamento já venceu.',
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

/** `days`: how long the copy lasts, 1, 3 or 7 (spec 007, FR-039); absent, the 3 days of before. */
export function createShareController(token: TokenProvider, turnstileToken: string, share: ShareContent, media: PlannedMedia[] = [], days?: 1 | 3 | 7): Promise<CreatedShare> {
  return call<CreatedShare>(token, '/shares', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ turnstileToken, share, ...(media.length ? { media } : {}), ...(days ? { days } : {}) }) })
}

/** The same link with the current content and 3 more days; the media already in it stays. A Worker without this route answers 404 `not_found`, a link that is gone 404 `share_gone`. */
export function updateShareController(token: TokenProvider, id: string, turnstileToken: string, share: ShareContent, media: PlannedMedia[] = [], days?: 1 | 3 | 7): Promise<UpdatedShare> {
  return call<UpdatedShare>(token, `/shares/${encodeURIComponent(id)}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ turnstileToken, share, ...(media.length ? { media } : {}), ...(days ? { days } : {}) }) })
}

export function shareStatusController(token: TokenProvider, id: string): Promise<ShareStatus> {
  return call<ShareStatus>(token, `/shares/${encodeURIComponent(id)}`)
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

/** The upload of a media failed: tells the Worker, so the link stops saying that the media is going up. Best effort: an old Worker answers 404 and nothing is lost. */
export async function forgetShareMediaController(token: TokenProvider, shareId: string, fileId: string): Promise<void> {
  await call<unknown>(token, `/shares/${encodeURIComponent(shareId)}/media/${encodeURIComponent(fileId)}`, { method: 'DELETE' }).catch(() => undefined)
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
  files: { id: string; path: string; media?: { mime: string; size: number }; pendingMedia?: { mime: string; size: number } }[]
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
      // the Worker keeps the shared artifacts in the sidecar, in the link's own shape
      const [content, sidecar] = await Promise.all([sharedText(id, `${entry.path}.md`), sharedJson<Omit<FileSidecar, 'artifacts'> & Pick<SharedFile, 'artifacts'>>(id, `${entry.path}.json`)])
      if (content === null || !sidecar) return null
      const { meta } = sidecar
      const file: SharedFile = { id: entry.id, name: meta.name, folderId: meta.folderId, type: meta.type, position: meta.position, description: meta.description, tags: meta.tags ?? [], content, questions: sidecar.questions ?? [], highlights: sidecar.highlights ?? [], ...(sidecar.transcript !== undefined ? { transcript: sidecar.transcript } : {}), ...(sidecar.recording ? { recording: sidecar.recording } : {}), ...(sidecar.documents ? { documents: sidecar.documents } : {}), ...(sidecar.artifacts ? { artifacts: sidecar.artifacts } : {}), ...(entry.media ? { media: { url: sharedMediaUrl(id, entry.id), mime: entry.media.mime, size: entry.media.size } } : entry.pendingMedia ? { mediaPending: { mime: entry.pendingMedia.mime, size: entry.pendingMedia.size } } : {}), meta }
      return file
    }),
  )
  if (folders.includes(null) || files.includes(null)) return null
  return { version: manifest.version, id: manifest.id, kind: manifest.kind, title: manifest.title, createdAt: manifest.createdAt, expiresAt: manifest.expiresAt, ...(manifest.mediaExpiresAt ? { mediaExpiresAt: manifest.mediaExpiresAt } : {}), folders: folders as SharedFolder[], files: files as SharedFile[] }
}
