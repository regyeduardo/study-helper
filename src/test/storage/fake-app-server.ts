/**
 * An in-memory Estudo backend for the App storage tests (spec 003, entrega 4): the library map, the parts in versions, the index and
 * the uploads, as contracts/api-biblioteca.md and api-arquivos.md say, with the English names of data-model.md "Entrega 4".
 * Spec 005 (contracts/api-hierarquia.md): the map needs only a session; a folder has no place; a note in the App needs the structure.
 */
export const API = 'https://api.example.test'

interface Row {
  id: string
  itemKind: 'file' | 'folder'
  meta: Record<string, unknown>
  parts: Record<string, string>
  media: { id: string; key: string; mime: string; bytes: number; status: string } | null
  noteBytes: number
  mediaBytes: number
  trashedAt: string | null
  trashedWith: string | null
  removedAt: string | null
  rev: number
  seq: number
  [field: string]: unknown
}

interface Upload {
  id: string
  item: string
  media: string
  name: string
  mime: string
  bytes: number
  partSize: number
  parts: Map<number, { etag: string; bytes: number; blob?: Blob }>
  status: 'open' | 'completed' | 'abandoned'
}

/** A Blob's bytes, whether it came from the page (jsdom) or from a fetch (Node). */
async function bytesOf(blob: Blob | undefined): Promise<ArrayBuffer> {
  if (!blob) return new ArrayBuffer(0)
  if (typeof blob.arrayBuffer === 'function') return blob.arrayBuffer()
  return new Promise(resolve => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result as ArrayBuffer)
    reader.readAsArrayBuffer(blob)
  })
}

const SERVER_OWNED = ['parts', 'media', 'noteBytes', 'mediaBytes', 'rev', 'seq', 'removedAt', 'placeOwn']
const MiB = 1024 * 1024
const BACKUP_LIMIT = 4 * MiB

export class FakeAppServer {
  seq = 0
  rows = new Map<string, Row>()
  partStore = new Map<string, { version: string; content: string }[]>()
  index: { version: string; content: string } | null = null
  uploads = new Map<string, Upload>()
  /** The bytes of each media that finished going up, by its key: the media GET gives them back. */
  mediaBlobs = new Map<string, Uint8Array>()
  limit = 10 * 1024 * MiB
  reserved = 0
  mediaBytes = 0
  partSize = 10 * MiB
  /** Part numbers whose next PUT fails as a dropped connection. */
  dropParts = new Set<number>()
  /** Part numbers whose PUTs keep failing (the connection stays down) until taken out. */
  downParts = new Set<number>()
  calls: { method: string; path: string; query: string }[] = []
  /** A session on the server (spec 005: the map needs only this). */
  signedIn = true
  /** "Usar a estrutura do app" on, for an account freed by a code: the App's content needs it. */
  appEnabled = true
  /** When the account's hierarchy was taken to the map (null = still the way of before). */
  hierarchyAt: string | null = null
  /** Whether `POST /v1/auth/google/token` opens a session (off: the route is not there, as before spec 005). */
  acceptGoogle = false
  googleTokens: string[] = []
  backup: { id: string; snapshot: unknown; folders: number; files: number } | null = null
  /** Makes every call fail as a dropped connection (the server is out). */
  offline = false
  /** An item whose content writes (its parts) fail with a server error; its line in the hierarchy still goes. */
  failPutFor: string | null = null
  /** How those writes fail: a server error by default, or a refusal (404 not_found, 403 app_off…). */
  failWith = { status: 500, error: 'internal_error' }
  private versions = 0

  private nextVersion(): string {
    this.versions += 1
    return `v${String(this.versions).padStart(4, '0')}`
  }

  notesBytes(): number {
    let sum = 0
    for (const row of this.rows.values()) if (!row.removedAt) sum += row.noteBytes
    return sum
  }

  currentPart(id: string, part: string): { version: string; content: string } | undefined {
    const version = this.rows.get(id)?.parts[part]
    return version ? this.partStore.get(`${id}/${part}`)?.find(entry => entry.version === version) : undefined
  }

  /** A change of the row's own fields: the rev goes up (a write with an old rev gets 409). */
  private bump(row: Row): void {
    this.seq += 1
    row.rev += 1
    row.seq = this.seq
  }

  /** A part or the media changed: other devices see it (seq), but the row's fields did not (the parts have versions of their own). */
  private touch(row: Row): void {
    this.seq += 1
    row.seq = this.seq
  }

  readonly fetch = async (input: string | URL | Request, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(String(input))
    const method = (init.method ?? 'GET').toUpperCase()
    const path = url.pathname
    this.calls.push({ method, path, query: url.search })
    if (this.offline) throw new TypeError('Failed to fetch')
    const headers = new Headers(init.headers)
    const json = (status: number, body: unknown, extra: Record<string, string> = {}) =>
      new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...extra } })
    const body = async () => JSON.parse(String(init.body ?? '{}')) as Record<string, unknown>
    if (method !== 'GET' && method !== 'HEAD' && headers.get('X-Estudo') !== '1') return json(403, { error: 'origin_refused' })

    if (path === '/v1/auth/google/token' && method === 'POST' && this.acceptGoogle) {
      const { accessToken } = (await body()) as { accessToken?: string }
      if (!accessToken) return json(401, { error: 'google_refused' })
      this.googleTokens.push(accessToken)
      this.signedIn = true
      return json(200, { ok: true })
    }

    if (!this.signedIn) return json(401, { error: 'no_session' })

    if (path === '/v1/auth/logout' && method === 'POST') {
      this.signedIn = false
      return json(200, { ok: true })
    }

    if (path === '/v1/me') {
      return json(200, {
        user: { id: 'u1', email: 'ana@example.com', status: 'enabled', appEnabled: this.appEnabled, hierarchyAt: this.hierarchyAt },
        requireCode: true,
        device: { id: 'd1', name: 'Teste' },
        space: { notes: this.notesBytes(), media: this.mediaBytes, reserved: this.reserved, limit: this.limit, warnAt: 0.9 },
      })
    }

    if (path === '/v1/library/hierarchy/backup' && method === 'POST') {
      const text = String(init.body ?? '{}')
      if (text.length > BACKUP_LIMIT) return json(413, { error: 'too_large' })
      if (this.backup && !this.hierarchyAt) return json(200, { id: this.backup.id, folders: this.backup.folders, files: this.backup.files })
      const { snapshot } = JSON.parse(text) as { snapshot: { folders?: unknown[]; files?: unknown[] } }
      this.backup = { id: `b${Date.now().toString(36)}`, snapshot, folders: snapshot.folders?.length ?? 0, files: snapshot.files?.length ?? 0 }
      return json(201, { id: this.backup.id, folders: this.backup.folders, files: this.backup.files })
    }

    if (path === '/v1/library/hierarchy/done' && method === 'POST') {
      if (this.hierarchyAt) return json(200, { hierarchyAt: this.hierarchyAt })
      const sent = (await body()) as { backupId: string; folders: number; files: number }
      const live = [...this.rows.values()].filter(row => !row.removedAt)
      const counted = { folders: live.filter(row => row.itemKind === 'folder').length, files: live.filter(row => row.itemKind === 'file').length }
      if (counted.folders !== sent.folders || counted.files !== sent.files) return json(409, { error: 'count_mismatch', ...counted })
      this.hierarchyAt = new Date().toISOString()
      return json(200, { hierarchyAt: this.hierarchyAt })
    }

    // the App's content (parts, uploads, media, index) needs the structure on; the map needs only the session
    if (!this.appEnabled && (/^\/v1\/library\/items\/[^/]+\/parts\//.test(path) || path === '/v1/library/parts/batch' || path === '/v1/library/index' || path.startsWith('/v1/uploads') || path.startsWith('/v1/media/'))) {
      return json(403, { error: 'app_disabled' })
    }

    if (path === '/v1/library/map' && method === 'GET') {
      const since = Number(url.searchParams.get('since') ?? 0)
      const rows = [...this.rows.values()].filter(row => row.seq > since).sort((a, b) => a.seq - b.seq)
      return json(200, { seq: this.seq, rows: structuredClone(rows), more: false })
    }

    if (this.failPutFor && method === 'PUT' && path.startsWith(`/v1/library/items/${encodeURIComponent(this.failPutFor)}/parts/`)) return json(this.failWith.status, { error: this.failWith.error })

    let match = path.match(/^\/v1\/library\/items\/([^/]+)$/)
    if (match) {
      const id = decodeURIComponent(match[1])
      const current = this.rows.get(id)
      if (method === 'GET') return current ? json(200, structuredClone(current)) : json(404, { error: 'not_found' })
      if (method === 'PUT') {
        // as the real server: a body over 1 MiB does not decode (readJSON)
        if (new TextEncoder().encode(String(init.body ?? '')).length > 1 << 20) return json(400, { error: 'invalid_body' })
        const { baseRev, row } = (await body()) as { baseRev: number; row: Record<string, unknown> }
        // as the real server (cleanMeta): the text never goes in the map
        if (row.meta && typeof row.meta === 'object') {
          const meta = row.meta as Record<string, unknown>
          for (const key of ['sourceExcerpt', 'pendingExcerpt', 'courseMaterial', 'courseDescription']) if (key in meta) meta[key] = null
          if (meta.source && typeof meta.source === 'object') delete (meta.source as Record<string, unknown>).text
        }
        // a folder has no place (one sent is dropped); a note is in the App or in the Drive, and in the App only with the structure on
        if (row.itemKind === 'file' && row.place !== 'app' && row.place !== 'drive') return json(422, { error: 'invalid_place' })
        if (row.itemKind === 'file' && row.place === 'app' && !this.appEnabled) return json(403, { error: 'app_off' })
        if ((current?.rev ?? 0) !== baseRev) return json(409, { error: 'conflict', current: structuredClone(current ?? null) })
        const clean = Object.fromEntries(Object.entries(row).filter(([key]) => !SERVER_OWNED.includes(key)))
        if (row.itemKind === 'folder') clean.place = null
        const next: Row = { parts: {}, media: null, noteBytes: 0, mediaBytes: 0, removedAt: null, trashedAt: null, trashedWith: null, rev: 0, seq: 0, ...current, ...clean, id } as Row
        this.bump(next)
        this.rows.set(id, next)
        return json(200, { rev: next.rev, seq: next.seq })
      }
      if (method === 'DELETE') {
        if (!current) return json(404, { error: 'not_found' })
        current.removedAt = new Date().toISOString()
        current.parts = {}
        current.noteBytes = 0
        this.bump(current)
        return json(200, { seq: this.seq })
      }
    }

    match = path.match(/^\/v1\/library\/items\/([^/]+)\/parts\/(.+)$/)
    if (match) {
      const id = decodeURIComponent(match[1])
      const part = decodeURIComponent(match[2])
      const row = this.rows.get(id)
      if (method === 'GET') {
        const version = url.searchParams.get('version') ?? row?.parts[part]
        const found = version ? this.partStore.get(`${id}/${part}`)?.find(entry => entry.version === version) : undefined
        if (!found) return json(404, { error: 'part_not_found' })
        return new Response(found.content, { status: 200, headers: { ETag: `"${found.version}"`, 'Content-Type': part === 'text' ? 'text/markdown' : 'application/json' } })
      }
      const currentVersion = row?.parts[part] ?? null
      if (method === 'PUT') {
        const ifMatch = headers.get('If-Match')?.replace(/"/g, '') ?? null
        const ifNone = headers.get('If-None-Match')
        const ok = ifNone === '*' ? currentVersion === null : ifMatch === currentVersion
        if (!row || row.removedAt) return json(404, { error: 'not_found' })
        if (!ok) return json(409, { error: 'conflict', currentVersion })
        const target = row
        const content = String(init.body ?? '')
        const version = this.nextVersion()
        const list = this.partStore.get(`${id}/${part}`) ?? []
        list.push({ version, content })
        this.partStore.set(`${id}/${part}`, list)
        target.parts = { ...target.parts, [part]: version }
        target.noteBytes = Object.entries(target.parts).reduce((sum, [name, v]) => sum + (this.partStore.get(`${id}/${name}`)?.find(entry => entry.version === v)?.content.length ?? 0), 0)
        this.touch(target)
        return json(200, { version, bytes: content.length, seq: target.seq, ...(target.trashedAt ? { inTrash: true } : {}) })
      }
      if (method === 'DELETE') {
        if (!row || !currentVersion) return json(404, { error: 'part_not_found' })
        const ifMatch = headers.get('If-Match')?.replace(/"/g, '') ?? null
        if (ifMatch !== currentVersion) return json(409, { error: 'conflict', currentVersion })
        const { [part]: _gone, ...rest } = row.parts
        row.parts = rest
        this.touch(row)
        return json(200, { seq: row.seq })
      }
    }

    if (path === '/v1/library/parts/batch' && method === 'POST') {
      const { requests } = (await body()) as { requests: { item: string; part: string; version: string }[] }
      const lines = requests.map(request => {
        const found = this.partStore.get(`${request.item}/${request.part}`)?.find(entry => entry.version === request.version)
        return JSON.stringify(found ? { ...request, content: found.content } : { ...request, error: 'part_not_found' })
      })
      return new Response(lines.join('\n') + '\n', { status: 200, headers: { 'Content-Type': 'application/x-ndjson' } })
    }

    if (path === '/v1/library/index') {
      if (method === 'GET') return this.index ? new Response(this.index.content, { status: 200, headers: { ETag: `"${this.index.version}"` } }) : json(404, { error: 'not_found' })
      if (method === 'PUT') {
        const content = String(init.body ?? '')
        if (/"[a-zA-Z]*[aA]pi[kK]ey"\s*:\s*"[^"]+"/.test(content)) return json(422, { error: 'key_in_index' })
        const ifMatch = headers.get('If-Match')?.replace(/"/g, '') ?? null
        const ifNone = headers.get('If-None-Match')
        const ok = ifNone === '*' ? this.index === null : ifMatch === this.index?.version
        if (!ok) return json(409, { error: 'conflict', currentVersion: this.index?.version ?? null })
        this.index = { version: this.nextVersion(), content }
        return json(200, { version: this.index.version, bytes: content.length })
      }
    }

    if (path === '/v1/uploads' && method === 'POST') {
      const request = (await body()) as { item: string; media: string; name: string; mime: string; bytes: number }
      const open = [...this.uploads.values()].find(upload => upload.status === 'open' && upload.item === request.item && upload.media === request.media)
      if (open) return json(200, { upload: open.id, partSize: open.partSize, parts: [...open.parts].map(([n, part]) => ({ n, etag: part.etag })) })
      const free = this.limit - this.notesBytes() - this.mediaBytes - this.reserved
      if (request.bytes > free) return json(413, { error: 'no_space', missing: request.bytes - free, free })
      const upload: Upload = { id: `up${this.uploads.size + 1}`, item: request.item, media: request.media, name: request.name, mime: request.mime, bytes: request.bytes, partSize: this.partSize, parts: new Map(), status: 'open' }
      this.uploads.set(upload.id, upload)
      this.reserved += request.bytes
      const row = this.rows.get(request.item)
      if (row) row.media = { id: request.media, key: `u/u1/i/${request.item}/media/${request.media}`, mime: request.mime, bytes: request.bytes, status: 'uploading' }
      return json(201, { upload: upload.id, partSize: upload.partSize, parts: [] })
    }

    match = path.match(/^\/v1\/uploads\/([^/]+)(?:\/parts\/(\d+)|\/(complete))?$/)
    if (match) {
      const upload = this.uploads.get(match[1])
      if (!upload) return json(404, { error: 'not_found' })
      if (match[2] && method === 'PUT') {
        const n = Number(match[2])
        if (this.dropParts.has(n) || this.downParts.has(n)) {
          this.dropParts.delete(n)
          throw new TypeError('Failed to fetch')
        }
        const size = (init.body as Blob).size
        const received = [...upload.parts].filter(([k]) => k !== n).reduce((sum, [, part]) => sum + part.bytes, 0)
        if (received + size > upload.bytes) return json(413, { error: 'larger_than_declared' })
        upload.parts.set(n, { etag: `e${n}`, bytes: size, blob: init.body as Blob })
        return json(200, { n, etag: `e${n}` })
      }
      if (match[3] && method === 'POST') {
        const total = [...upload.parts.values()].reduce((sum, part) => sum + part.bytes, 0)
        if (total !== upload.bytes) return json(409, { error: 'parts_missing' })
        upload.status = 'completed'
        this.reserved -= upload.bytes
        this.mediaBytes += total
        const row = this.rows.get(upload.item)
        if (row?.media) row.media = { ...row.media, status: 'stored', bytes: total }
        if (row) this.touch(row)
        const pieces = await Promise.all([...upload.parts].sort(([a], [b]) => a - b).map(([, part]) => bytesOf(part.blob)))
        const whole = new Uint8Array(pieces.reduce((sum, piece) => sum + piece.byteLength, 0))
        pieces.reduce((at, piece) => (whole.set(new Uint8Array(piece), at), at + piece.byteLength), 0)
        this.mediaBlobs.set(`u/u1/i/${upload.item}/media/${upload.media}`, whole)
        return json(200, { key: `u/u1/i/${upload.item}/media/${upload.media}`, bytes: total, mime: upload.mime })
      }
      if (!match[2] && !match[3] && method === 'GET') return json(200, { parts: [...upload.parts].map(([n, part]) => ({ n, etag: part.etag })), partSize: upload.partSize, bytes: upload.bytes, status: upload.status })
      if (!match[2] && !match[3] && method === 'DELETE') {
        upload.status = 'abandoned'
        this.reserved -= upload.bytes
        return json(200, { ok: true })
      }
    }

    match = path.match(/^\/v1\/media\/([^/]+)\/([^/]+)$/)
    if (match && method === 'GET') {
      const row = this.rows.get(decodeURIComponent(match[1]))
      if (!row?.media || row.media.status === 'deleted') return json(410, { error: 'media_deleted' })
      return new Response(this.mediaBlobs.get(row.media.key) ?? new Blob([new Uint8Array(4)]), { status: 200, headers: { 'Content-Type': row.media.mime } })
    }
    if (match && method === 'DELETE') {
      const row = this.rows.get(decodeURIComponent(match[1]))
      if (!row?.media) return json(404, { error: 'not_found' })
      this.mediaBytes -= row.media.bytes
      row.media = { ...row.media, status: 'deleted' }
      this.touch(row)
      return json(200, { seq: row.seq })
    }

    return json(404, { error: 'not_found' })
  }
}
