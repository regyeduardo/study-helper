import { ApiError } from '@/controllers/api.controller'
import { env } from '@/lib/env'
import { countedBlob, type Transfer } from '@/lib/storage/repository'

/**
 * The library kept in the App (spec 003, entrega 4): the map, the parts in versions, the index, the uploads in parts and the media.
 * Names as in data-model.md "Entrega 4 · modelagem em Go (proposta)"; refusals are ApiError, like the account calls.
 */

export type MediaStatus = 'uploading' | 'stored' | 'deleted' | 'record-only'

export interface MediaRef {
  id: string
  key: string
  mime: string
  bytes: number
  status: MediaStatus
}

/** The fields of a row the app writes; the server owns parts, media, the sizes, rev, seq and removedAt. */
export interface LibraryRowFields {
  itemKind: 'file' | 'folder'
  noteType: string | null
  name: string
  folderId: string | null
  parentFileId: string | null
  /** Only a note has a place; a folder's comes back null (spec 005, contracts/api-hierarquia.md). */
  place: 'app' | 'drive' | null
  /** Before spec 005; the server ignores it now and no longer sends it. */
  placeOwn?: boolean
  recording: boolean
  position: number
  meta: Record<string, unknown>
  driveRef: string | null
  createdAt: string
  updatedAt: string
  trashedAt: string | null
  trashedWith: string | null
}

export interface LibraryRow extends LibraryRowFields {
  id: string
  /** Current version of each part: "text", "source", "transcript", "exam", "highlights", "documents", "artifacts/<id>", "course". */
  parts: Record<string, string>
  media: MediaRef | null
  noteBytes: number
  mediaBytes: number
  removedAt: string | null
  rev: number
  seq: number
}

export interface StoredPart {
  version: string
  content: string
}

async function send(method: string, path: string, options: { json?: unknown; body?: BodyInit; headers?: Record<string, string>; signal?: AbortSignal } = {}): Promise<Response> {
  const headers: Record<string, string> = { ...options.headers }
  if (method !== 'GET' && method !== 'HEAD') headers['X-Estudo'] = '1'
  if (options.json !== undefined) headers['Content-Type'] = 'application/json'
  let response: Response
  try {
    response = await fetch(`${env.apiUrl}${path}`, { method, credentials: 'include', headers, body: options.json !== undefined ? JSON.stringify(options.json) : options.body, signal: options.signal })
  } catch {
    throw new ApiError(0, 'offline')
  }
  if (!response.ok) {
    const answer = (await response.json().catch(() => ({}))) as Record<string, unknown>
    const { error, ...data } = answer
    throw new ApiError(response.status, typeof error === 'string' ? error : 'internal_error', data)
  }
  return response
}

const partPath = (id: string, part: string) => `/v1/library/items/${encodeURIComponent(id)}/parts/${part.split('/').map(encodeURIComponent).join('/')}`
const versionOf = (response: Response) => (response.headers.get('ETag') ?? '').replace(/^W\//, '').replace(/"/g, '')
/** The precondition of a write: the version it was based on, or "nothing there yet". */
const precondition = (baseVersion: string | null): Record<string, string> => (baseVersion ? { 'If-Match': `"${baseVersion}"` } : { 'If-None-Match': '*' })

/** The whole map (since 0) or what changed since `since`, following `more`. */
export async function getMap(since: number): Promise<{ seq: number; rows: LibraryRow[] }> {
  const rows: LibraryRow[] = []
  let from = since
  let seq = since
  for (;;) {
    const answer = (await (await send('GET', `/v1/library/map?since=${from}&limit=1000`)).json()) as { seq: number; rows: LibraryRow[]; more: boolean }
    rows.push(...answer.rows)
    seq = Math.max(seq, answer.seq)
    if (!answer.more || !answer.rows.length) return { seq, rows }
    from = Math.max(...answer.rows.map(row => row.seq))
  }
}

export const getItem = async (id: string) => (await (await send('GET', `/v1/library/items/${encodeURIComponent(id)}`)).json()) as LibraryRow

export const putItem = async (id: string, baseRev: number, row: LibraryRowFields) =>
  (await (await send('PUT', `/v1/library/items/${encodeURIComponent(id)}`, { json: { baseRev, row } })).json()) as { rev: number; seq: number }

export const deleteItem = async (id: string, baseRev: number) => (await (await send('DELETE', `/v1/library/items/${encodeURIComponent(id)}?baseRev=${baseRev}`)).json()) as { seq: number }

export async function getPart(id: string, part: string, version?: string): Promise<StoredPart> {
  const response = await send('GET', `${partPath(id, part)}${version ? `?version=${encodeURIComponent(version)}` : ''}`)
  const content = await response.text()
  return { version: versionOf(response) || version || '', content }
}

export async function putPart(id: string, part: string, content: string, baseVersion: string | null): Promise<{ version: string; bytes: number; seq: number; inTrash?: boolean }> {
  const type = part === 'text' ? 'text/markdown; charset=utf-8' : 'application/json'
  return (await (await send('PUT', partPath(id, part), { body: content, headers: { 'Content-Type': type, ...precondition(baseVersion) } })).json()) as { version: string; bytes: number; seq: number; inTrash?: boolean }
}

export const deletePart = async (id: string, part: string, baseVersion: string) => (await (await send('DELETE', partPath(id, part), { headers: { 'If-Match': `"${baseVersion}"` } })).json()) as { seq: number }

/** Many parts at once (NDJSON), for the text of the whole library on a new device. Up to 200 per call. */
export async function getParts(requests: { item: string; part: string; version: string }[]): Promise<{ item: string; part: string; version: string; content?: string; error?: string }[]> {
  const out: { item: string; part: string; version: string; content?: string; error?: string }[] = []
  for (let start = 0; start < requests.length; start += 200) {
    const text = await (await send('POST', '/v1/library/parts/batch', { json: { requests: requests.slice(start, start + 200) } })).text()
    for (const line of text.split('\n')) if (line.trim()) out.push(JSON.parse(line))
  }
  return out
}

export async function getIndex(): Promise<StoredPart | null> {
  try {
    const response = await send('GET', '/v1/library/index')
    return { version: versionOf(response), content: await response.text() }
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) return null
    throw error
  }
}

/** The hierarchy of before, kept on the server before the migration writes anything (FR-014); sent again, the same copy comes back. */
export const hierarchyBackup = async (snapshot: { folders: unknown[]; files: unknown[] }) =>
  (await (await send('POST', '/v1/library/hierarchy/backup', { json: { snapshot } })).json()) as { id: string; folders: number; files: number }

/** Marks the migration done when the live folders and notes on the map are as many as sent; else 409 `count_mismatch` with the server's (FR-016). */
export const hierarchyDone = async (backupId: string, folders: number, files: number) =>
  (await (await send('POST', '/v1/library/hierarchy/done', { json: { backupId, folders, files } })).json()) as { hierarchyAt: string }

export const putIndex = async (content: string, baseVersion: string | null) =>
  (await (await send('PUT', '/v1/library/index', { body: content, headers: { 'Content-Type': 'application/json', ...precondition(baseVersion) } })).json()) as { version: string; bytes: number }

export interface UploadStart {
  upload: string
  partSize: number
  parts: { n: number; etag: string }[]
}

export const startUpload = async (request: { item: string; media: string; name: string; mime: string; bytes: number }) => (await (await send('POST', '/v1/uploads', { json: request })).json()) as UploadStart
export const getUpload = async (id: string) => (await (await send('GET', `/v1/uploads/${encodeURIComponent(id)}`)).json()) as { parts: { n: number; etag: string }[]; partSize: number; bytes: number; status: string }
/**
 * One part; `signal` gives it a time limit (a part that does not answer fails as no connection, and is sent again). `onSent` hears
 * the bytes as they leave (23/11: a 10 MB part takes a minute on a slow line, and the bar must move meanwhile); fetch cannot tell
 * that, so in the browser the part goes by XMLHttpRequest.
 */
export async function putUploadPart(id: string, n: number, blob: Blob, signal?: AbortSignal, onSent?: (bytes: number) => void): Promise<{ n: number; etag: string }> {
  const path = `/v1/uploads/${encodeURIComponent(id)}/parts/${n}`
  if (!onSent || typeof XMLHttpRequest === 'undefined' || import.meta.env.MODE === 'test') return (await (await send('PUT', path, { body: blob, headers: { 'Content-Type': 'application/octet-stream' }, signal })).json()) as { n: number; etag: string }
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest()
    request.open('PUT', `${env.apiUrl}${path}`)
    request.withCredentials = true
    request.setRequestHeader('X-Estudo', '1')
    request.setRequestHeader('Content-Type', 'application/octet-stream')
    request.upload.onprogress = event => onSent(event.loaded)
    request.onload = () => {
      let answer: Record<string, unknown> = {}
      try {
        answer = JSON.parse(request.responseText) as Record<string, unknown>
      } catch {
        answer = {}
      }
      if (request.status >= 200 && request.status < 300) return resolve(answer as { n: number; etag: string })
      const { error, ...data } = answer
      reject(new ApiError(request.status, typeof error === 'string' ? error : 'internal_error', data))
    }
    request.onerror = () => reject(new ApiError(0, 'offline'))
    request.ontimeout = () => reject(new ApiError(0, 'offline'))
    signal?.addEventListener('abort', () => request.abort())
    request.onabort = () => reject(new ApiError(0, 'offline'))
    request.send(blob)
  })
}
export const completeUpload = async (id: string) => (await (await send('POST', `/v1/uploads/${encodeURIComponent(id)}/complete`)).json()) as { key: string; bytes: number; mime: string }
export const abandonUpload = async (id: string) => void (await send('DELETE', `/v1/uploads/${encodeURIComponent(id)}`))

/** Where the player reads the media from (same site: the session cookie goes along; Range works). */
export const mediaUrl = (item: string, media: string, download = false) => `${env.apiUrl}/v1/media/${encodeURIComponent(item)}/${encodeURIComponent(media)}${download ? '?download=1' : ''}`
export const getMedia = async (item: string, media: string, transfer?: Transfer) => countedBlob(await send('GET', `/v1/media/${encodeURIComponent(item)}/${encodeURIComponent(media)}`, { signal: transfer?.signal }), transfer)
export const deleteMedia = async (item: string, media: string) => (await (await send('DELETE', `/v1/media/${encodeURIComponent(item)}/${encodeURIComponent(media)}`)).json()) as { seq: number }
