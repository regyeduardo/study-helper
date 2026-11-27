import { createHash } from 'node:crypto'

import type { BrowserContext, Route } from '@playwright/test'

/**
 * A fake Google for the end-to-end tests: the Google Drive of the account (one for all the devices, kept in this process) and the
 * Google sign-in script. Nothing reaches the real Google; any other address outside localhost is refused.
 */

export const FAKE_GOOGLE = 'https://google.fake'
const FOLDER = 'application/vnd.google-apps.folder'
const HIDDEN_ROOT = 'appdata-root'

export const GOOGLE_ACCOUNT = { id: 'e2e-permission-1', name: 'Pessoa Teste', email: 'pessoa@teste.local', accessToken: 'e2e-google-token' }

interface FakeFile {
  id: string
  name: string
  mimeType: string
  parents: string[]
  modifiedTime: string
  appProperties?: Record<string, string>
  content?: Buffer
  space: 'drive' | 'appDataFolder'
}

/** The Google sign-in script (accounts.google.com/gsi/client): any token asked for is given at once. */
const SIGN_IN_SCRIPT = `window.google = { accounts: { oauth2: {
  initTokenClient: config => ({ requestAccessToken: () => setTimeout(() => config.callback({ access_token: ${JSON.stringify(GOOGLE_ACCOUNT.accessToken)}, expires_in: 3600, scope: 'https://www.googleapis.com/auth/drive.appdata' })) }),
  initCodeClient: config => ({ requestCode: () => setTimeout(() => config.error_callback && config.error_callback({ type: 'popup_closed' })) }),
  revoke: (_token, done) => done && done(),
} } }`

function md5(body: Buffer): string {
  return createHash('md5').update(body).digest('hex')
}

/** Splits a multipart/related body: the JSON metadata and the media, byte for byte. */
function parseMultipart(body: Buffer, boundary: string): { metadata: Record<string, unknown>; media: Buffer } {
  const text = body.toString('latin1')
  const parts = text
    .split(`--${boundary}`)
    .slice(1, -1)
    .map(part => {
      const content = part.slice(part.indexOf('\r\n\r\n') + 4)
      return content.endsWith('\r\n') ? content.slice(0, -2) : content
    })
  const metadata = JSON.parse(Buffer.from(parts[0] ?? '{}', 'latin1').toString('utf8') || '{}') as Record<string, unknown>
  return { metadata, media: Buffer.from(parts[1] ?? '', 'latin1') }
}

export class FakeDrive {
  readonly files = new Map<string, FakeFile>()
  private readonly sessions = new Map<string, Record<string, unknown>>()
  private seq = 0

  private meta(file: FakeFile): Record<string, unknown> {
    const folder = file.mimeType === FOLDER
    const content = file.content ?? Buffer.alloc(0)
    return {
      id: file.id,
      name: file.name,
      mimeType: file.mimeType,
      parents: [...file.parents],
      modifiedTime: file.modifiedTime,
      appProperties: file.appProperties ? { ...file.appProperties } : undefined,
      md5Checksum: folder ? undefined : md5(content),
      size: folder ? undefined : String(content.length),
    }
  }

  private add(fields: { name: string; mimeType?: string; parents?: string[]; appProperties?: Record<string, string>; content?: Buffer }): FakeFile {
    const asked = fields.parents ?? []
    const hidden = asked.includes('appDataFolder') || asked.includes(HIDDEN_ROOT) || asked.some(parent => this.files.get(parent)?.space === 'appDataFolder')
    const file: FakeFile = {
      id: `f${++this.seq}`,
      name: fields.name,
      mimeType: fields.mimeType ?? 'application/octet-stream',
      parents: asked.map(parent => (parent === 'appDataFolder' ? HIDDEN_ROOT : parent)),
      modifiedTime: new Date().toISOString(),
      appProperties: fields.appProperties,
      content: fields.content,
      space: hidden ? 'appDataFolder' : 'drive',
    }
    this.files.set(file.id, file)
    return file
  }

  private removeTree(id: string): void {
    for (const child of [...this.files.values()].filter(file => file.parents.includes(id))) this.removeTree(child.id)
    this.files.delete(id)
  }

  /** Answers one request the app made to Google. */
  async handle(route: Route): Promise<void> {
    const request = route.request()
    const url = new URL(request.url())
    const method = request.method()
    const path = url.pathname
    const search = url.searchParams
    const body = request.postDataBuffer() ?? Buffer.alloc(0)
    const contentType = (await request.allHeaders())['content-type'] ?? ''
    const json = (value: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(value) })
    const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': '*', 'Access-Control-Expose-Headers': 'Location' }

    if (method === 'OPTIONS') return route.fulfill({ status: 204, headers: cors })
    if (path === '/gsi/client') return route.fulfill({ status: 200, contentType: 'text/javascript', body: SIGN_IN_SCRIPT })
    if (method === 'GET' && path === '/drive/v3/about') {
      return json({
        user: { displayName: GOOGLE_ACCOUNT.name, emailAddress: GOOGLE_ACCOUNT.email, permissionId: GOOGLE_ACCOUNT.id, photoLink: '' },
        storageQuota: { limit: '16106127360', usage: '1073741824' },
      })
    }
    if (method === 'GET' && path === '/drive/v3/files') {
      const space = search.get('spaces') ?? 'drive'
      return json({ files: [...this.files.values()].filter(file => file.space === space).map(file => this.meta(file)) })
    }
    if (method === 'POST' && path === '/drive/v3/files') {
      const fields = JSON.parse(body.toString('utf8') || '{}') as { name: string; mimeType: string; parents?: string[]; appProperties?: Record<string, string> }
      return json(this.meta(this.add(fields)))
    }
    if (method === 'POST' && path === '/upload/drive/v3/files' && search.get('uploadType') === 'resumable') {
      const id = `upload-${this.sessions.size + 1}`
      this.sessions.set(id, JSON.parse(body.toString('utf8') || '{}') as Record<string, unknown>)
      return route.fulfill({ status: 200, headers: { ...cors, Location: `${url.origin}/upload/drive/v3/files?uploadType=resumable&upload_id=${id}` } })
    }
    if (method === 'PUT' && path === '/upload/drive/v3/files' && search.get('upload_id')) {
      const metadata = this.sessions.get(search.get('upload_id')!)
      if (!metadata) return json({ error: { message: 'no session' } }, 404)
      const file = this.add({ name: String(metadata.name), mimeType: metadata.mimeType as string, parents: metadata.parents as string[], appProperties: metadata.appProperties as Record<string, string>, content: body })
      return json(this.meta(file))
    }
    if (method === 'POST' && path === '/upload/drive/v3/files') {
      const boundary = /boundary=(.+)$/.exec(contentType)?.[1] ?? ''
      const { metadata, media } = parseMultipart(body, boundary)
      const file = this.add({ name: String(metadata.name), mimeType: metadata.mimeType as string, parents: metadata.parents as string[], appProperties: metadata.appProperties as Record<string, string>, content: media })
      return json(this.meta(file))
    }

    const match = /^\/(upload\/)?drive\/v3\/files\/([^/]+)$/.exec(path)
    if (!match) return json({ error: { message: `not handled: ${method} ${path}` } }, 400)
    const file = this.files.get(match[2])
    if (!file) return json({ error: { code: 404, message: 'File not found' } }, 404)
    if (method === 'GET') return search.get('alt') === 'media' ? route.fulfill({ status: 200, body: file.content ?? Buffer.alloc(0) }) : json(this.meta(file))
    if (method === 'PATCH') {
      if (match[1]) {
        const boundary = /boundary=(.+)$/.exec(contentType)?.[1] ?? ''
        const { metadata, media } = parseMultipart(body, boundary)
        if (typeof metadata.name === 'string') file.name = metadata.name
        file.content = media
      } else {
        const metadata = JSON.parse(body.toString('utf8') || '{}') as { name?: string; appProperties?: Record<string, string> }
        if (typeof metadata.name === 'string') file.name = metadata.name
        if (metadata.appProperties) file.appProperties = { ...file.appProperties, ...metadata.appProperties }
      }
      const remove = search.get('removeParents')
      const add = search.get('addParents')
      if (remove) file.parents = file.parents.filter(parent => !remove.split(',').includes(parent))
      if (add) file.parents = [...file.parents, ...add.split(',')]
      file.modifiedTime = new Date().toISOString()
      return json(this.meta(file))
    }
    if (method === 'DELETE') {
      this.removeTree(file.id)
      return route.fulfill({ status: 204 })
    }
    return json({ error: { message: `not handled: ${method} ${path}` } }, 400)
  }
}

/**
 * One device: the Google account already signed in (as the app keeps it), its Drive answered by `drive`, and no request leaving
 * this machine. The server's "sign in with the app's Google" is refused here, so it never asks the real Google.
 */
export async function useFakeGoogle(context: BrowserContext, drive: FakeDrive, apiUrl: string): Promise<void> {
  await context.addInitScript(account => {
    try {
      if (localStorage.getItem('study-helper:accounts')) return
      const token = { accessToken: account.accessToken, expiresAt: Date.now() + 12 * 3600_000 }
      localStorage.setItem('study-helper:accounts', JSON.stringify([{ id: account.id, kind: 'google', name: account.name, email: account.email, picture: '', token }]))
      localStorage.setItem('study-helper:active-account', account.id)
    } catch {
      // a page without storage (about:blank, an error page): nothing to sign in
    }
  }, GOOGLE_ACCOUNT)
  await context.route(/^https?:\/\/(?!localhost[:/]|127\.0\.0\.1[:/])/, route => route.abort('blockedbyclient'))
  await context.route(`${FAKE_GOOGLE}/**`, route => drive.handle(route))
  await context.route(`${apiUrl}/v1/auth/google/token`, route => route.fulfill({ status: 401, contentType: 'application/json', body: JSON.stringify({ error: 'google_refused' }) }))
}
