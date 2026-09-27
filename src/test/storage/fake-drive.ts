import { createHash } from 'node:crypto'

import { vi } from 'vitest'

export const FOLDER = 'application/vnd.google-apps.folder'

export interface FakeFile {
  id: string
  name: string
  mimeType: string
  parents: string[]
  modifiedTime: string
  appProperties?: Record<string, string>
  content?: string
}

export interface RecordedRequest {
  method: string
  path: string
  search: URLSearchParams
  authorization: string
}

export function readBlob(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(reader.error)
    reader.readAsText(blob)
  })
}

function md5(text: string): string {
  return createHash('md5').update(text).digest('hex')
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } })
}

function parseMultipart(text: string, boundary: string): { metadata: Record<string, unknown>; media: string } {
  const parts = text
    .split(`--${boundary}`)
    .slice(1, -1)
    .map(part => {
      const body = part.slice(part.indexOf('\r\n\r\n') + 4)
      return body.endsWith('\r\n') ? body.slice(0, -2) : body
    })
  return { metadata: JSON.parse(parts[0] || '{}') as Record<string, unknown>, media: parts[1] ?? '' }
}

export class FakeDrive {
  files = new Map<string, FakeFile>()
  requests: RecordedRequest[] = []
  quota: { limit?: string; usage?: string } = { limit: '16106127360', usage: '5368709120' }
  queuedStatuses: number[] = []
  private clock = Date.parse('2026-01-01T00:00:00.000Z')
  private seq = 0

  fetch = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => this.handle(String(input), init))

  install(): this {
    vi.stubGlobal('fetch', this.fetch)
    return this
  }

  tick(ms = 1000): string {
    this.clock += ms
    return new Date(this.clock).toISOString()
  }

  meta(file: FakeFile): Record<string, unknown> {
    const isFolder = file.mimeType === FOLDER
    return {
      id: file.id,
      name: file.name,
      mimeType: file.mimeType,
      parents: [...file.parents],
      modifiedTime: file.modifiedTime,
      appProperties: file.appProperties ? { ...file.appProperties } : undefined,
      md5Checksum: isFolder ? undefined : md5(file.content ?? ''),
      size: isFolder ? undefined : String(new TextEncoder().encode(file.content ?? '').length),
    }
  }

  add(fields: Partial<FakeFile> & { name: string }): FakeFile {
    const file: FakeFile = { id: `f${++this.seq}`, mimeType: 'application/octet-stream', parents: [], modifiedTime: this.tick(), ...fields }
    this.files.set(file.id, file)
    return file
  }

  editContent(id: string, content: string): void {
    const file = this.files.get(id)!
    file.content = content
    file.modifiedTime = this.tick()
  }

  root(): FakeFile | undefined {
    return [...this.files.values()].find(file => file.name === '.sync-study-helper' && file.mimeType === FOLDER && file.parents.length === 0)
  }

  byApp(kind: string, shId?: string): FakeFile[] {
    return [...this.files.values()].filter(file => file.appProperties?.shKind === kind && (shId === undefined || file.appProperties?.shId === shId))
  }

  one(kind: string, shId?: string): FakeFile {
    const found = this.byApp(kind, shId)
    if (found.length !== 1) throw new Error(`expected one ${kind}/${shId}, got ${found.length}`)
    return found[0]
  }

  childrenOf(id: string): FakeFile[] {
    return [...this.files.values()].filter(file => file.parents.includes(id))
  }

  pathOf(id: string): string {
    const names: string[] = []
    let current = this.files.get(id)
    while (current) {
      names.unshift(current.name)
      current = current.parents[0] ? this.files.get(current.parents[0]) : undefined
    }
    return names.join('/')
  }

  mediaDownloads(id?: string): RecordedRequest[] {
    return this.requests.filter(request => request.method === 'GET' && request.search.get('alt') === 'media' && (id === undefined || request.path.endsWith(`/${id}`)))
  }

  private removeTree(id: string): void {
    for (const child of this.childrenOf(id)) this.removeTree(child.id)
    this.files.delete(id)
  }

  private applyParents(file: FakeFile, search: URLSearchParams): void {
    const add = search.get('addParents')
    const remove = search.get('removeParents')
    if (remove) file.parents = file.parents.filter(parent => !remove.split(',').includes(parent))
    if (add) file.parents = [...file.parents, ...add.split(',')]
  }

  private async handle(url: string, init: RequestInit): Promise<Response> {
    const parsed = new URL(url)
    const method = (init.method ?? 'GET').toUpperCase()
    const headers = (init.headers ?? {}) as Record<string, string>
    this.requests.push({ method, path: parsed.pathname, search: parsed.searchParams, authorization: headers.Authorization ?? '' })
    const queued = this.queuedStatuses.shift()
    if (queued) return json({ error: { message: 'queued', status: String(queued) } }, queued)

    const path = parsed.pathname
    const search = parsed.searchParams

    if (method === 'GET' && path === '/drive/v3/about') return json({ storageQuota: this.quota })

    if (method === 'GET' && path === '/drive/v3/files') {
      return json({ files: [...this.files.values()].map(file => this.meta(file)) })
    }

    const fileMatch = /^\/(upload\/)?drive\/v3\/files\/([^/]+)$/.exec(path)

    if (method === 'POST' && path === '/drive/v3/files') {
      const body = JSON.parse(String(init.body)) as { name: string; mimeType: string; parents?: string[]; appProperties?: Record<string, string> }
      const file = this.add({ name: body.name, mimeType: body.mimeType, parents: body.parents ?? [], appProperties: body.appProperties })
      return json(this.meta(file))
    }

    if (method === 'POST' && path === '/upload/drive/v3/files') {
      const boundary = /boundary=(.+)$/.exec(headers['Content-Type'] ?? '')![1]
      const { metadata, media } = parseMultipart(await readBlob(init.body as Blob), boundary)
      const file = this.add({
        name: String(metadata.name),
        mimeType: String(metadata.mimeType ?? 'application/octet-stream'),
        parents: (metadata.parents as string[]) ?? [],
        appProperties: metadata.appProperties as Record<string, string>,
        content: media,
      })
      return json(this.meta(file))
    }

    if (!fileMatch) return json({ error: { message: 'not handled' } }, 400)
    const file = this.files.get(fileMatch[2])

    if (method === 'GET' && fileMatch[2] !== undefined) {
      if (!file) return json({ error: { message: 'not found' } }, 404)
      if (search.get('alt') === 'media') return new Response(file.content ?? '', { status: 200 })
      return json(this.meta(file))
    }

    if (method === 'PATCH') {
      if (!file) return json({ error: { message: 'not found' } }, 404)
      if (fileMatch[1]) {
        const boundary = /boundary=(.+)$/.exec(headers['Content-Type'] ?? '')![1]
        const { metadata, media } = parseMultipart(await readBlob(init.body as Blob), boundary)
        if (typeof metadata.name === 'string') file.name = metadata.name
        file.content = media
      } else {
        const metadata = JSON.parse(String(init.body ?? '{}')) as { name?: string }
        if (typeof metadata.name === 'string') file.name = metadata.name
      }
      this.applyParents(file, search)
      file.modifiedTime = this.tick()
      return json(this.meta(file))
    }

    if (method === 'DELETE') {
      if (!file) return json({ error: { message: 'not found' } }, 404)
      this.removeTree(file.id)
      return new Response(null, { status: 204 })
    }

    return json({ error: { message: 'not handled' } }, 400)
  }
}

export function uniqueAccount(prefix = 'acc'): string {
  return `${prefix}-${crypto.randomUUID()}`
}

export function installMemoryStorage(): Storage {
  const data = new Map<string, string>()
  const storage: Storage = {
    get length() {
      return data.size
    },
    clear: () => data.clear(),
    getItem: key => data.get(key) ?? null,
    key: index => [...data.keys()][index] ?? null,
    removeItem: key => void data.delete(key),
    setItem: (key, value) => void data.set(key, String(value)),
  }
  vi.stubGlobal('localStorage', storage)
  return storage
}
