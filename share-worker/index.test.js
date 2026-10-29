import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import worker, { rangeOf } from './index.js'

const ORIGIN = 'https://study.ryns.me'
const KB = 1024
const MB = 1024 * KB
const PASS_SECRET = '1x0000000000000000000000000000000AA'
const FAIL_SECRET = '2x0000000000000000000000000000000AA'

function bytesOf(body) {
  return typeof body === 'string' ? new TextEncoder().encode(body) : body
}

async function bytesFrom(body) {
  if (typeof body === 'string' || body instanceof Uint8Array) return bytesOf(body)
  return new Uint8Array(await new Response(body).arrayBuffer())
}

function fakeBucket() {
  const objects = new Map()
  const uploads = new Map()
  let version = 0
  const allowed = (current, onlyIf) => {
    if (!onlyIf) return true
    if (onlyIf.etagMatches !== undefined) return Boolean(current) && current.etag === onlyIf.etagMatches
    if (onlyIf.etagDoesNotMatch === '*') return !current
    return true
  }
  const view = (key, stored, range) => ({
    key,
    etag: stored.etag,
    size: bytesOf(stored.body).length,
    customMetadata: stored.customMetadata,
    httpMetadata: stored.httpMetadata,
    body: range ? bytesOf(stored.body).slice(range.offset, range.offset + range.length) : stored.body,
    json: async () => JSON.parse(stored.body),
    text: async () => stored.body,
  })
  const store = (key, body, options = {}) => {
    const stored = { body, etag: `e${++version}`, customMetadata: options.customMetadata ?? {}, httpMetadata: options.httpMetadata ?? {} }
    objects.set(key, stored)
    return view(key, stored)
  }
  return {
    objects,
    uploads,
    async get(key, options = {}) {
      const stored = objects.get(key)
      return stored ? view(key, stored, options.range) : null
    },
    async head(key) {
      const stored = objects.get(key)
      return stored ? view(key, stored) : null
    },
    async put(key, body, options = {}) {
      if (!allowed(objects.get(key), options.onlyIf)) return null
      return store(key, body, options)
    },
    async delete(keys) {
      for (const key of [keys].flat()) objects.delete(key)
    },
    async list({ prefix }) {
      return { objects: [...objects.keys()].filter(key => key.startsWith(prefix)).map(key => ({ key })), truncated: false }
    },
    async createMultipartUpload(key, options = {}) {
      const uploadId = `up-${++version}`
      uploads.set(uploadId, { key, options, parts: new Map() })
      return { key, uploadId }
    },
    resumeMultipartUpload(key, uploadId) {
      return {
        async uploadPart(partNumber, body) {
          const upload = uploads.get(uploadId)
          if (!upload || upload.key !== key) throw new Error('no such upload')
          const etag = `p${++version}`
          upload.parts.set(partNumber, { etag, bytes: await bytesFrom(body) })
          return { partNumber, etag }
        },
        async complete(parts) {
          const upload = uploads.get(uploadId)
          if (!upload || upload.key !== key) throw new Error('no such upload')
          const chunks = parts.map(part => {
            const stored = upload.parts.get(part.partNumber)
            if (!stored || stored.etag !== part.etag) throw new Error('bad part')
            return stored.bytes
          })
          const body = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0))
          chunks.reduce((offset, chunk) => (body.set(chunk, offset), offset + chunk.length), 0)
          uploads.delete(uploadId)
          return store(key, body, upload.options)
        },
      }
    },
  }
}

const accounts = { 'token-ana': 'perm-ana', 'token-bia': 'perm-bia' }

function fakeFetch(input, init = {}) {
  const url = String(input)
  if (url.startsWith('https://www.googleapis.com/drive/v3/about')) {
    const token = (init.headers?.Authorization ?? '').replace('Bearer ', '')
    const permissionId = accounts[token]
    if (!permissionId) return Promise.resolve(new Response(JSON.stringify({ error: { code: 401 } }), { status: 401 }))
    return Promise.resolve(new Response(JSON.stringify({ user: { permissionId, emailAddress: `${permissionId}@example.com` } }), { status: 200 }))
  }
  if (url === 'https://challenges.cloudflare.com/turnstile/v0/siteverify') {
    const secret = init.body.get('secret')
    const response = init.body.get('response')
    return Promise.resolve(new Response(JSON.stringify({ success: secret === PASS_SECRET && Boolean(response) }), { status: 200 }))
  }
  return Promise.reject(new Error(`unexpected fetch ${url}`))
}

let env

function share(contentBytes = 1000) {
  return { kind: 'file', title: 'Nota', folders: [], files: [{ id: 'f1', name: 'Nota', folderId: null, type: 'class', position: 0, description: '', tags: [], content: 'a'.repeat(contentBytes), questions: [] }] }
}

function call(method, path, { token, ip = '1.1.1.1', body, contentType = 'application/json', origin = ORIGIN, range } = {}) {
  const headers = { 'CF-Connecting-IP': ip }
  if (origin) headers.Origin = origin
  if (token) headers.Authorization = `Bearer ${token}`
  if (range) headers.Range = range
  if (body !== undefined) headers['Content-Type'] = contentType
  return worker.fetch(new Request(`https://share.test${path}`, { method, headers, body: body === undefined ? undefined : typeof body === 'string' || body instanceof Uint8Array ? body : JSON.stringify(body) }), env)
}

function post(options = {}) {
  return call('POST', '/shares', { token: 'token-ana', body: { turnstileToken: 'XXXX.DUMMY.TOKEN.XXXX', share: share(options.contentBytes) }, ...options })
}

const recording = { blocks: [{ speaker: 'mic', start: 0, end: 4, text: 'Bom dia.' }, { speaker: 'speaker_0', start: 72, end: 80, text: 'Custou dois mil.' }], speakers: [{ id: 'mic', name: 'Você', suggested: false }], marks: [] }

async function meetingShare() {
  const meeting = { kind: 'file', title: 'Reunião', folders: [], files: [{ id: 'f1', name: 'Reunião', folderId: null, type: 'meeting', position: 0, description: '', tags: [], content: '# Ata\n\n- Preço [▸ 01:12](#t=72)', questions: [], recording }] }
  const response = await call('POST', '/shares', { token: 'token-ana', body: { turnstileToken: 'ok', share: meeting } })
  expect(response.status).toBe(201)
  return response.json()
}

async function uploadMedia(id, fileId, bytes, { token = 'token-ana', mime = 'audio/webm', partSize = 4 } = {}) {
  const start = await call('POST', `/shares/${id}/media/${fileId}`, { token, body: { mime } })
  if (start.status !== 201) return start
  const { uploadId } = await start.json()
  const parts = []
  for (let offset = 0, number = 1; offset < bytes.length; offset += partSize, number++) {
    const part = await call('PUT', `/shares/${id}/media/${fileId}/${number}?uploadId=${uploadId}`, { token, body: bytes.slice(offset, offset + partSize), contentType: 'application/octet-stream' })
    expect(part.status).toBe(200)
    parts.push(await part.json())
  }
  return call('POST', `/shares/${id}/media/${fileId}/done`, { token, body: { uploadId, parts } })
}

const MEDIA = Uint8Array.from({ length: 10 }, (_, index) => index + 1)

function manifestOf(id) {
  return JSON.parse(env.BUCKET.objects.get(`shared/${id}/share.json`).body)
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-09-28T15:00:00Z'))
  vi.stubGlobal('fetch', vi.fn(fakeFetch))
  env = { BUCKET: fakeBucket(), TURNSTILE_SECRET: PASS_SECRET, ALLOWED_ORIGINS: ORIGIN }
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('share worker', () => {
  it('refuses a share without login', async () => {
    const response = await call('POST', '/shares', { body: { turnstileToken: 'ok', share: share() } })
    expect(response.status).toBe(401)
    expect(await response.json()).toEqual({ error: 'login_required' })
    expect([...env.BUCKET.objects.keys()]).toEqual([])
  })

  it('refuses a fake Google token', async () => {
    const response = await post({ token: 'token-fake' })
    expect(response.status).toBe(401)
    const removal = await call('DELETE', '/shares/AbCdEfGhIjKlMnOpQrStUv', { token: 'token-fake' })
    expect(removal.status).toBe(401)
  })

  it('refuses when Turnstile fails', async () => {
    env.TURNSTILE_SECRET = FAIL_SECRET
    const response = await post()
    expect(response.status).toBe(403)
    expect(await response.json()).toEqual({ error: 'turnstile_failed' })
    const missing = await call('POST', '/shares', { token: 'token-ana', body: { share: share() } })
    expect(missing.status).toBe(403)
  })

  it('stores only text under shared/ and keeps no counters', async () => {
    const response = await post()
    expect(response.status).toBe(201)
    const body = await response.json()
    expect(body.id).toMatch(/^[A-Za-z0-9_-]{22}$/)
    expect(Date.parse(body.expiresAt) - Date.parse(body.createdAt)).toBe(3 * 24 * 3600 * 1000)
    const keys = [...env.BUCKET.objects.keys()].sort()
    expect(keys.filter(key => key.startsWith('shared/'))).toEqual([`shared/${body.id}/Nota.json`, `shared/${body.id}/Nota.md`, `shared/${body.id}/share.json`])
    expect(keys.filter(key => !key.startsWith('shared/'))).toEqual([])
    expect(env.BUCKET.objects.get(`shared/${body.id}/Nota.md`).body).toHaveLength(1000)
    expect(JSON.parse(env.BUCKET.objects.get(`shared/${body.id}/share.json`).body)).toMatchObject({ id: body.id, kind: 'file', title: 'Nota', files: [{ id: 'f1', path: 'Nota' }] })
    const bytes = keys.filter(key => key.startsWith('shared/')).reduce((sum, key) => sum + new TextEncoder().encode(env.BUCKET.objects.get(key).body).length, 0)
    expect(body.bytes).toBe(bytes)
  })

  it('stores a folder exactly like the Drive: folders with .folder.json, <name>.md + <name>.json, questions only when sent, never attempts', async () => {
    const lesson = (id, name, extra = {}) => ({ id, name, folderId: 'mod', type: 'class', position: 0, description: '', tags: [], content: `# ${name}`, questions: [], meta: { id, name, mastery: 80 }, highlights: [{ id: 'h1', text: 'x' }], transcript: 'fala', ...extra })
    const folderShare = {
      kind: 'folder',
      title: 'Curso',
      folders: [{ id: 'root', name: 'Curso', parentId: null, position: 0, isCourse: true, description: '' }, { id: 'mod', name: 'Módulo 1', parentId: 'root', position: 0, isCourse: false, description: '' }],
      files: [lesson('a', 'Aula', { questions: [{ tipo: 'certo_errado', enunciado: 'q' }], attempts: [{ id: 'try' }] }), lesson('b', 'Aula')],
    }
    const response = await call('POST', '/shares', { token: 'token-ana', body: { turnstileToken: 'ok', share: folderShare } })
    const { id } = await response.json()
    const keys = [...env.BUCKET.objects.keys()].filter(key => key.startsWith(`shared/${id}/`)).map(key => key.slice(`shared/${id}/`.length)).sort()
    expect(keys).toEqual(['Curso/.folder.json', 'Curso/Módulo 1/.folder.json', 'Curso/Módulo 1/Aula(1).json', 'Curso/Módulo 1/Aula(1).md', 'Curso/Módulo 1/Aula.json', 'Curso/Módulo 1/Aula.md', 'share.json'])
    const first = JSON.parse(env.BUCKET.objects.get(`shared/${id}/Curso/Módulo 1/Aula.json`).body)
    expect(first).toMatchObject({ attempts: [], highlights: [{ id: 'h1' }], transcript: 'fala', questions: [{ enunciado: 'q' }], meta: { id: 'a', mastery: null, questionCount: 1 } })
    expect(JSON.stringify(first)).not.toContain('try')
    expect(JSON.parse(env.BUCKET.objects.get(`shared/${id}/Curso/Módulo 1/Aula(1).json`).body).questions).toEqual([])
    expect(JSON.parse(env.BUCKET.objects.get(`shared/${id}/Curso/.folder.json`).body)).toMatchObject({ id: 'root', name: 'Curso', isCourse: true })
  })

  it('accepts only text', async () => {
    const binary = await call('POST', '/shares', { token: 'token-ana', body: 'PK\u0003\u0004', contentType: 'application/octet-stream' })
    expect(binary.status).toBe(415)
    const withNul = share()
    withNul.files[0].content = 'abc\u0000def'
    const nul = await call('POST', '/shares', { token: 'token-ana', body: { turnstileToken: 'ok', share: withNul } })
    expect(nul.status).toBe(415)
    const noContent = share()
    noContent.files[0].content = { bytes: [1, 2, 3] }
    const object = await call('POST', '/shares', { token: 'token-ana', body: { turnstileToken: 'ok', share: noContent } })
    expect(object.status).toBe(415)
    const extra = share()
    extra.files[0].source = 'data:application/pdf;base64,JVBERi0='
    const cleaned = await call('POST', '/shares', { token: 'token-ana', body: { turnstileToken: 'ok', share: extra } })
    const { id } = await cleaned.json()
    expect(JSON.stringify([...env.BUCKET.objects.entries()].filter(([key]) => key.startsWith(`shared/${id}/`)))).not.toContain('data:application/pdf')
  })

  it('has no daily size limit: big shares, many times, from the same account and network', async () => {
    for (let round = 0; round < 4; round++) {
      const response = await post({ contentBytes: 2 * MB })
      expect(response.status).toBe(201)
      expect(await response.json()).not.toHaveProperty('remaining')
    }
    expect([...env.BUCKET.objects.keys()].filter(key => key.startsWith('counters/') || key.startsWith('grants/'))).toEqual([])
    expect((await call('GET', '/quota', { token: 'token-ana' })).status).toBe(404)
  })

  it('deleting removes the share, and only the owner can do it', async () => {
    const { id } = await (await post({ contentBytes: 100 * KB })).json()
    const stranger = await call('DELETE', `/shares/${id}`, { token: 'token-bia' })
    expect(stranger.status).toBe(403)
    const removed = await call('DELETE', `/shares/${id}`, { token: 'token-ana' })
    expect(removed.status).toBe(200)
    expect([...env.BUCKET.objects.keys()].some(key => key.includes(id))).toBe(false)
    expect((await call('DELETE', `/shares/${id}`, { token: 'token-ana' })).status).toBe(404)
  })

  it('keeps the transcription of a recorded note in the shared sidecar', async () => {
    const { id } = await meetingShare()
    expect(JSON.parse(env.BUCKET.objects.get(`shared/${id}/Reunião.json`).body).recording).toEqual(recording)
  })

  it('answers CORS only for the allowed origins', async () => {
    const blocked = await worker.fetch(new Request('https://share.test/shares', { method: 'POST', headers: { Origin: 'https://evil.test' } }), env)
    expect(blocked.status).toBe(403)
    const local = await worker.fetch(new Request('https://share.test/shares', { method: 'OPTIONS', headers: { Origin: 'http://localhost:5184' } }), env)
    expect(local.status).toBe(204)
    expect(local.headers.get('Access-Control-Allow-Origin')).toBe('http://localhost:5184')
  })

  it('serves shared files only when the dev flag is on, and not after expiry', async () => {
    const { id } = await (await post()).json()
    expect((await call('GET', `/shared/${id}/share.json`)).status).toBe(404)
    env.SERVE_SHARED = 'true'
    const served = await call('GET', `/shared/${id}/share.json`)
    expect(served.status).toBe(200)
    expect((await served.json()).id).toBe(id)
    expect(await (await call('GET', `/shared/${id}/Nota.md`)).text()).toHaveLength(1000)
    vi.setSystemTime(new Date('2026-10-01T15:00:01Z'))
    expect((await call('GET', `/shared/${id}/share.json`)).status).toBe(404)
  })
})

describe('media of a shared note', () => {
  it('uploads the media in parts under the share and lists key, type and size in the manifest', async () => {
    const { id, createdAt, mediaExpiresAt } = await meetingShare()
    expect(Date.parse(mediaExpiresAt) - Date.parse(createdAt)).toBe(3 * 24 * 3600 * 1000)
    const done = await uploadMedia(id, 'f1', MEDIA)
    expect(done.status).toBe(200)
    expect(await done.json()).toEqual({ key: `shared-media/${id}/f1`, mime: 'audio/webm', size: 10 })
    expect([...env.BUCKET.objects.get(`shared-media/${id}/f1`).body]).toEqual([...MEDIA])
    const manifest = manifestOf(id)
    expect(manifest.mediaExpiresAt).toBe(mediaExpiresAt)
    expect(manifest.files).toEqual([{ id: 'f1', path: 'Reunião', media: { key: `shared-media/${id}/f1`, mime: 'audio/webm', size: 10 } }])
    expect(env.BUCKET.objects.get(`shared/${id}/share.json`).customMetadata.owner).toMatch(/^account-/)
  })

  it('a big video goes in many parts with no size limit', async () => {
    const { id } = await meetingShare()
    const video = new Uint8Array(3 * MB + 5).fill(7)
    const done = await uploadMedia(id, 'f1', video, { mime: 'video/mp4', partSize: MB })
    expect(done.status).toBe(200)
    expect(manifestOf(id).files[0].media).toMatchObject({ mime: 'video/mp4', size: 3 * MB + 5 })
  })

  it('only the owner uploads, only audio or video, only for a note of the share', async () => {
    const { id } = await meetingShare()
    expect((await call('POST', `/shares/${id}/media/f1`, { body: { mime: 'audio/webm' } })).status).toBe(401)
    expect((await call('POST', `/shares/${id}/media/f1`, { token: 'token-bia', body: { mime: 'audio/webm' } })).status).toBe(403)
    expect((await call('POST', `/shares/${id}/media/f1`, { token: 'token-ana', body: { mime: 'application/pdf' } })).status).toBe(415)
    expect((await call('POST', `/shares/${id}/media/outra`, { token: 'token-ana', body: { mime: 'audio/webm' } })).status).toBe(404)
    expect(env.BUCKET.uploads.size).toBe(0)
  })

  it('the shared view plays it from the worker: whole file, or the asked range to seek', async () => {
    const { id } = await meetingShare()
    await uploadMedia(id, 'f1', MEDIA)
    const whole = await call('GET', `/media/${id}/f1`, { origin: null })
    expect(whole.status).toBe(200)
    expect(whole.headers.get('Content-Type')).toBe('audio/webm')
    expect(whole.headers.get('Accept-Ranges')).toBe('bytes')
    expect([...new Uint8Array(await whole.arrayBuffer())]).toEqual([...MEDIA])
    const seek = await call('GET', `/media/${id}/f1`, { origin: null, range: 'bytes=4-6' })
    expect(seek.status).toBe(206)
    expect(seek.headers.get('Content-Range')).toBe('bytes 4-6/10')
    expect(seek.headers.get('Content-Length')).toBe('3')
    expect([...new Uint8Array(await seek.arrayBuffer())]).toEqual([5, 6, 7])
    const tail = await call('GET', `/media/${id}/f1`, { range: 'bytes=8-' })
    expect(tail.headers.get('Content-Range')).toBe('bytes 8-9/10')
    expect(tail.headers.get('Access-Control-Allow-Origin')).toBe(ORIGIN)
    expect((await call('GET', `/media/${id}/f1`, { origin: null, range: 'bytes=20-' })).status).toBe(416)
    expect((await call('GET', `/media/${id}/f1`, { origin: 'https://evil.test' })).status).toBe(403)
  })

  it('reads ranges like a browser asks them', () => {
    expect(rangeOf('bytes=0-', 10)).toEqual({ start: 0, end: 9 })
    expect(rangeOf('bytes=-3', 10)).toEqual({ start: 7, end: 9 })
    expect(rangeOf('bytes=2-100', 10)).toEqual({ start: 2, end: 9 })
    expect(rangeOf('bytes=5-2', 10)).toBeNull()
    expect(rangeOf(null, 10)).toBeNull()
    expect(rangeOf('bytes=10-', 10)).toBe('unsatisfiable')
  })

  it('after 3 days the media answers 410 and is deleted, while the manifest stays as it was', async () => {
    const { id } = await meetingShare()
    await uploadMedia(id, 'f1', MEDIA)
    vi.setSystemTime(new Date('2026-10-01T14:59:59Z'))
    expect((await call('GET', `/media/${id}/f1`, { origin: null })).status).toBe(200)
    vi.setSystemTime(new Date('2026-10-01T15:00:00Z'))
    const expired = await call('GET', `/media/${id}/f1`, { origin: null })
    expect(expired.status).toBe(410)
    expect(await expired.json()).toEqual({ error: 'media_expired' })
    expect(env.BUCKET.objects.has(`shared-media/${id}/f1`)).toBe(false)
    expect((await call('GET', `/media/${id}/f1`, { origin: null, range: 'bytes=0-1' })).status).toBe(410)
    expect((await call('POST', `/shares/${id}/media/f1`, { token: 'token-ana', body: { mime: 'audio/webm' } })).status).toBe(410)
    expect(manifestOf(id).files[0].media).toMatchObject({ size: 10 })
  })

  it('deleting the share deletes its media too', async () => {
    const { id } = await meetingShare()
    await uploadMedia(id, 'f1', MEDIA)
    expect((await call('DELETE', `/shares/${id}`, { token: 'token-ana' })).status).toBe(200)
    expect([...env.BUCKET.objects.keys()]).toEqual([])
    expect((await call('GET', `/media/${id}/f1`, { origin: null })).status).toBe(404)
  })
})
