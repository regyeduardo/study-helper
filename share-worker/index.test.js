import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import worker, { rangeOf, renderSharePage } from './index.js'

const ORIGIN = 'https://study.ryns.me'
const APP_URL = 'https://study.ryns.me'
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
    httpEtag: `"${stored.etag}"`,
    uploaded: stored.uploaded,
    size: bytesOf(stored.body).length,
    customMetadata: stored.customMetadata,
    httpMetadata: stored.httpMetadata,
    body: range ? bytesOf(stored.body).slice(range.offset, range.offset + range.length) : stored.body,
    json: async () => JSON.parse(stored.body),
    text: async () => stored.body,
  })
  const store = (key, body, options = {}) => {
    const stored = { body, etag: `e${++version}`, uploaded: new Date('2026-11-03T12:00:00Z'), customMetadata: options.customMetadata ?? {}, httpMetadata: options.httpMetadata ?? {} }
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
          // like the real R2 (links of 29/10 came out with mime ""): the object complete() returns has no httpMetadata
          return { ...(await store(key, body, upload.options)), httpMetadata: {} }
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
  env = { BUCKET: fakeBucket(), TURNSTILE_SECRET: PASS_SECRET, ALLOWED_ORIGINS: ORIGIN, APP_URL }
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

  it('keeps the Ata of a meeting note in the shared sidecar; a note without one stays as it was', async () => {
    const ata = { id: 'ata-1', kind: 'ata', parts: ['resumo'], markdown: '## Resumo\n\n![quadro](imagens/quadro-1.png)', images: [{ name: 'quadro-1.png', dataUrl: 'data:image/png;base64,iVBORw0KGgo=' }], createdAt: '2026-09-28T12:00:00.000Z', models: {} }
    const meeting = { kind: 'file', title: 'Reunião', folders: [], files: [{ id: 'f1', name: 'Reunião', folderId: null, type: 'meeting', position: 0, description: '', tags: [], content: '# Ata', questions: [], recording, documents: [ata] }] }
    const { id } = await (await call('POST', '/shares', { token: 'token-ana', body: { turnstileToken: 'ok', share: meeting } })).json()
    expect(JSON.parse(env.BUCKET.objects.get(`shared/${id}/Reunião.json`).body).documents).toEqual([ata])
    const plain = await (await post()).json()
    expect(JSON.parse(env.BUCKET.objects.get(`shared/${plain.id}/Nota.json`).body)).not.toHaveProperty('documents')
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

  it('the media carries validators, so the browser keeps the downloaded ranges and a second visit does not download again', async () => {
    const { id } = await meetingShare()
    await uploadMedia(id, 'f1', MEDIA)
    const etag = (await env.BUCKET.head(`shared-media/${id}/f1`)).httpEtag
    for (const range of [null, 'bytes=4-6']) {
      const answer = await call('GET', `/media/${id}/f1`, { origin: null, range })
      expect(answer.headers.get('ETag')).toBe(etag)
      expect(answer.headers.get('Last-Modified')).toBe('Tue, 03 Nov 2026 12:00:00 GMT')
    }
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

describe('plain page of a share, for AI agents and people without login', () => {
  const question = { storedId: 'q1', tipo: 'unica', enunciado: 'Quanto custou?', alternativas: { A: 'Mil', B: 'Dois mil', C: 'Três mil' }, correta: 'B', explicacao: 'Foi dito em 01:12.' }
  const ataDocument = { id: 'ata-1', kind: 'ata', parts: ['resumo'], markdown: '## Resumo\n\nFechamos o preço em dois mil.', images: [], createdAt: '2026-09-28T12:00:00.000Z', models: {} }

  async function noteShare(fields = {}, title = 'Reunião') {
    const note = { id: 'f1', name: 'Reunião', folderId: null, type: 'meeting', position: 0, description: 'Preço do projeto', tags: ['vendas'], content: '# Ata\n\n- Preço [▸ 01:12](#t=72)', questions: [question], recording, documents: [ataDocument], ...fields }
    const response = await call('POST', '/shares', { token: 'token-ana', body: { turnstileToken: 'ok', share: { kind: 'file', title, folders: [], files: [note] } } })
    return (await response.json()).id
  }

  async function courseShare() {
    const lesson = (id, name, folderId, position) => ({ id, name, folderId, type: 'class', position, description: '', tags: [], content: `Texto de ${name}`, questions: [] })
    const course = {
      kind: 'folder',
      title: 'Curso',
      folders: [{ id: 'root', name: 'Curso', parentId: null, position: 0, isCourse: true, description: '' }, { id: 'm2', name: 'Módulo 2', parentId: 'root', position: 1, isCourse: false, description: '' }, { id: 'm1', name: 'Módulo 1', parentId: 'root', position: 0, isCourse: false, description: '' }],
      files: [lesson('b', 'Aula 2', 'm1', 1), lesson('c', 'Aula 3', 'm2', 0), lesson('a', 'Aula 1', 'm1', 0)],
    }
    const response = await call('POST', '/shares', { token: 'token-ana', body: { turnstileToken: 'ok', share: course } })
    return (await response.json()).id
  }

  function open(path) {
    return call('GET', path, { origin: null })
  }

  function inOrder(text, parts) {
    const found = parts.map(part => text.indexOf(part))
    expect(found.every(index => index >= 0)).toBe(true)
    expect(found).toEqual([...found].sort((a, b) => a - b))
  }

  it('serves the whole note as plain HTML, with no login and no Origin', async () => {
    const id = await noteShare()
    await uploadMedia(id, 'f1', MEDIA)
    const response = await open(`/s/${id}`)
    expect(response.status).toBe(200)
    expect(response.headers.get('Content-Type')).toBe('text/html; charset=utf-8')
    expect(response.headers.get('Cache-Control')).toBe('public, max-age=60')
    expect(response.headers.get('X-Robots-Tag')).toBe('noindex')
    const html = await response.text()
    expect(html).toContain('<html lang="pt-BR">')
    expect(html).toContain('<title>Reunião</title>')
    expect(html).toContain('<meta name="robots" content="noindex">')
    expect(html).toMatch(/<meta name="description" content="[^"]+">/)
    expect(html).toContain('<h1>Reunião</h1>')
    expect(html).toContain('28/09/2026 15:00 UTC')
    expect(html).toContain('01/10/2026 15:00 UTC')
    inOrder(html, ['<h2>Reunião</h2>', 'Tipo: Reunião', 'Preço do projeto', 'Tags: vendas', '# Ata\n\n- Preço [▸ 01:12](#t=72)', '<h3>Ata</h3>', '<h3>Transcrição</h3>', '<h3>Questões</h3>'])
    expect(html).toContain('## Resumo\n\nFechamos o preço em dois mil.')
    expect(html).toContain('Você [00:00]: Bom dia.\nspeaker_0 [01:12]: Custou dois mil.')
    expect(html).toContain('1. Quanto custou?\nA) Mil\nB) Dois mil\nC) Três mil\nGabarito: B) Dois mil\nExplicação: Foi dito em 01:12.')
    expect(html).toContain(`Mídia (audio/webm, 10 bytes): <a href="https://share.test/media/${id}/f1">https://share.test/media/${id}/f1</a>`)
    expect(html).toContain(`<script>location.replace("${APP_URL}/shared/${id}")</script>`)
    expect(html).toContain(`<a href="${APP_URL}/shared/${id}">Abrir no Estudo</a>`)
    expect(html).not.toMatch(/<link\b|<img\b|\ssrc=/)
  })

  it('lists a folder share under its folders, in the order of their positions', async () => {
    const id = await courseShare()
    const html = await (await open(`/s/${id}`)).text()
    expect(html).toContain('<h1>Curso</h1>')
    inOrder(html, ['<h2>Curso</h2>', '<h3>Módulo 1</h3>', '<h4>Aula 1</h4>', 'Texto de Aula 1', '<h4>Aula 2</h4>', '<h3>Módulo 2</h3>', '<h4>Aula 3</h4>'])
  })

  it('/s/<id>/arquivo/<fileId> shows only that note and sends people to it in the app', async () => {
    const id = await courseShare()
    const html = await (await open(`/s/${id}/arquivo/b`)).text()
    expect(html).toContain('<h1>Curso</h1>')
    expect(html).toContain('<h2>Aula 2</h2>')
    expect(html).toContain('Texto de Aula 2')
    expect(html).not.toContain('Aula 1')
    expect(html).not.toContain('Módulo')
    expect(html).toContain(`location.replace("${APP_URL}/shared/${id}/arquivo/b")`)
    expect(await (await open(`/s/${id}/arquivo/outra`)).text()).toContain('Texto de Aula 1')
  })

  it('answers the same content as Markdown at /s/<id>.md', async () => {
    const id = await noteShare()
    await uploadMedia(id, 'f1', MEDIA)
    const response = await open(`/s/${id}.md`)
    expect(response.status).toBe(200)
    expect(response.headers.get('Content-Type')).toBe('text/markdown; charset=utf-8')
    expect(response.headers.get('X-Robots-Tag')).toBe('noindex')
    const markdown = await response.text()
    expect(markdown.startsWith('# Reunião\n')).toBe(true)
    expect(markdown).toContain(`[Abrir no Estudo](${APP_URL}/shared/${id})`)
    inOrder(markdown, ['## Reunião', 'Tipo: Reunião', '# Ata\n\n- Preço', '### Ata\n\n## Resumo\n\nFechamos o preço em dois mil.', '### Transcrição\n\nVocê [00:00]: Bom dia.\nspeaker_0 [01:12]: Custou dois mil.', '### Questões', 'Gabarito: B) Dois mil'])
    expect(markdown).toContain(`Mídia (audio/webm, 10 bytes): [https://share.test/media/${id}/f1](https://share.test/media/${id}/f1)`)
    expect(markdown).not.toContain('<')
  })

  it('an expired link answers 410 and an unknown one 404, with a short page', async () => {
    const id = await noteShare()
    const unknown = await open('/s/AbCdEfGhIjKlMnOpQrStUv')
    expect(unknown.status).toBe(404)
    expect(unknown.headers.get('Content-Type')).toBe('text/html; charset=utf-8')
    expect(await unknown.text()).toContain('não existe')
    const manifest = env.BUCKET.objects.get(`shared/${id}/share.json`)
    manifest.customMetadata = { ...manifest.customMetadata, expiresAt: '2026-09-28T14:00:00.000Z' }
    expect((await open(`/s/${id}`)).status).toBe(410)
    manifest.customMetadata = { ...manifest.customMetadata, expiresAt: '2026-10-01T15:00:00.000Z' }
    vi.setSystemTime(new Date('2026-10-01T15:00:00Z'))
    const expired = await open(`/s/${id}`)
    expect(expired.status).toBe(410)
    expect(expired.headers.get('X-Robots-Tag')).toBe('noindex')
    expect(expired.headers.get('Cache-Control')).toBe('public, max-age=60')
    const html = await expired.text()
    expect(html).toContain('O link expirou')
    expect(html).not.toContain('Bom dia')
    expect((await open(`/s/${id}.md`)).status).toBe(410)
  })

  it('escapes the HTML that comes in names and content', async () => {
    const evil = '<img src=x onerror=alert(1)>'
    const id = await noteShare({ name: evil, description: '"><script>alert(2)</script>', tags: ['<b>'], content: '</pre><script>alert(3)</script>' }, evil)
    const html = await (await open(`/s/${id}`)).text()
    expect(html).not.toContain('<img')
    expect(html).not.toMatch(/<script>alert/)
    expect(html).not.toContain('<b>')
    expect(html).toContain('<title>&lt;img src=x onerror=alert(1)&gt;</title>')
    expect(html).toContain('&lt;/pre&gt;&lt;script&gt;alert(3)&lt;/script&gt;')
    expect(html).toContain('&quot;&gt;&lt;script&gt;alert(2)&lt;/script&gt;')
  })

  it('is open to any GET with or without Origin, and the other routes stay as they were', async () => {
    const id = await noteShare()
    expect((await call('GET', `/s/${id}`, { origin: 'https://evil.test' })).status).toBe(200)
    expect((await call('POST', `/s/${id}`, { origin: null })).status).toBe(403)
    expect((await call('GET', `/shared/${id}/share.json`, { origin: null })).status).toBe(403)
    expect((await call('GET', `/shared/${id}/share.json`)).status).toBe(404)
  })

  const mapArtifact = { id: 'mapa-1', kind: 'mapa', name: 'Decisões do reajuste', diagram: { form: 'arvore', root: { id: 'r', text: 'Reajuste', children: [] } }, mermaid: 'flowchart LR\n  m0(["Reajuste"])\n  m0 --> m1\n  m1["Índice#58; IPCA"]' }
  const cardsArtifact = { id: 'baralho-1', kind: 'cartoes', name: 'Datas', cards: [{ id: 'c1', front: 'Quando reajusta?', back: 'Em março.' }, { id: 'c2', front: 'Qual índice?', back: 'IPCA.' }] }
  const tutorArtifact = { id: 'conversa-1', kind: 'tutor', name: 'Por que IPCA', turns: [{ who: 'você', text: 'Por que o IPCA?' }, { who: 'tutor', text: 'Porque mede a inflação oficial.' }] }

  it('keeps the artifacts in the shared sidecar; an old share without them stays as it was', async () => {
    const id = await noteShare({ artifacts: [mapArtifact, cardsArtifact, tutorArtifact] })
    expect(JSON.parse(env.BUCKET.objects.get(`shared/${id}/Reunião.json`).body).artifacts).toEqual([mapArtifact, cardsArtifact, tutorArtifact])
    const plain = await (await post()).json()
    expect(JSON.parse(env.BUCKET.objects.get(`shared/${plain.id}/Nota.json`).body)).not.toHaveProperty('artifacts')
  })

  it('refuses artifacts that are not a list of objects, or carry binary bytes', async () => {
    for (const artifacts of ['mapa', { 0: mapArtifact }, [mapArtifact, 'texto'], [null], [{ ...mapArtifact, mermaid: 'flowchart\u0000' }]]) {
      const note = { ...share().files[0], artifacts }
      const response = await call('POST', '/shares', { token: 'token-ana', body: { turnstileToken: 'ok', share: { ...share(), files: [note] } } })
      expect(response.status).toBe(415)
    }
    expect([...env.BUCKET.objects.keys()]).toEqual([])
  })

  it('prints a section per artifact after the note text: the Mermaid code, the cards front and back, one Tutor turn per line', async () => {
    const id = await noteShare({ artifacts: [mapArtifact, cardsArtifact, tutorArtifact] })
    const html = await (await open(`/s/${id}`)).text()
    inOrder(html, ['# Ata\n\n- Preço', '<h3>Mapa mental: Decisões do reajuste</h3>', '<pre>flowchart LR\n  m0([&quot;Reajuste&quot;])\n  m0 --&gt; m1\n  m1[&quot;Índice#58; IPCA&quot;]</pre>', '<h3>Cartões: Datas</h3>', '<h3>Conversa do Tutor: Por que IPCA</h3>', '<h3>Transcrição</h3>'])
    expect(html).toContain('<pre>Frente: Quando reajusta?\nVerso: Em março.</pre>')
    expect(html).toContain('<pre>Frente: Qual índice?\nVerso: IPCA.</pre>')
    expect(html).toContain('<pre>Você: Por que o IPCA?\nTutor: Porque mede a inflação oficial.</pre>')
    const markdown = await (await open(`/s/${id}.md`)).text()
    expect(markdown).toContain(`### Mapa mental: Decisões do reajuste\n\n\`\`\`mermaid\n${mapArtifact.mermaid}\n\`\`\``)
    expect(markdown).toContain('### Cartões: Datas\n\nFrente: Quando reajusta?\nVerso: Em março.\n\nFrente: Qual índice?\nVerso: IPCA.')
    expect(markdown).toContain('### Conversa do Tutor: Por que IPCA\n\nVocê: Por que o IPCA?\nTutor: Porque mede a inflação oficial.')
    const old = await noteShare()
    expect(await (await open(`/s/${old}`)).text()).not.toMatch(/Mapa mental|Cartões|Conversa do Tutor/)
  })

  it('escapes the HTML that comes in the artifacts', async () => {
    const evil = '<img src=x onerror=alert(1)>'
    const artifacts = [
      { ...mapArtifact, name: evil, mermaid: '</pre><script>alert(2)</script>' },
      { ...cardsArtifact, name: evil, cards: [{ id: 'c1', front: '<b>frente</b>', back: '<i>verso</i>' }] },
      { ...tutorArtifact, name: evil, turns: [{ who: 'tutor', text: '<script>alert(3)</script>' }] },
    ]
    const html = await (await open(`/s/${await noteShare({ artifacts })}`)).text()
    expect(html).not.toMatch(/<img|<script>alert|<b>|<i>/)
    expect(html).toContain('<h3>Mapa mental: &lt;img src=x onerror=alert(1)&gt;</h3>')
    expect(html).toContain('&lt;/pre&gt;&lt;script&gt;alert(2)&lt;/script&gt;')
    expect(html).toContain('Frente: &lt;b&gt;frente&lt;/b&gt;')
    expect(html).toContain('Tutor: &lt;script&gt;alert(3)&lt;/script&gt;')
  })

  it('renders every question type with its gabarito, and an old plain transcript', () => {
    const share = {
      id: 'AbCdEfGhIjKlMnOpQrStUv',
      kind: 'file',
      title: 'Prova',
      createdAt: '2026-09-28T15:00:00.000Z',
      expiresAt: '2026-10-01T15:00:00.000Z',
      folders: [],
      files: [{ id: 'f1', name: 'Prova', folderId: null, type: 'class', position: 0, description: '', tags: [], content: 'Texto', transcript: 'Professor [00:05]: Olá.', questions: [
        { tipo: 'multipla', enunciado: 'Quais?', alternativas: { B: 'dois', A: 'um', C: 'três' }, corretas: ['A', 'C'], explicacao: '' },
        { tipo: 'certo_errado', enunciado: 'A Terra é plana.', alternativas: {}, certo: false, explicacao: 'Não é.' },
        { tipo: 'ordenar', enunciado: 'Ordene.', alternativas: {}, passos: ['abrir', 'ler', 'fechar'], explicacao: '' },
        { tipo: 'associar', enunciado: 'Associe.', alternativas: {}, pares: [{ esquerda: 'H2O', direita: 'água' }], explicacao: '' },
        { tipo: 'lacuna', enunciado: 'Metade é ___.', alternativas: {}, lacunas: [{ opcoes: ['1/2', '1/3'], correta: '1/2' }], explicacao: '', fonte: 'https://prova.test/1' },
      ] }],
    }
    const markdown = renderSharePage(share, { origin: 'https://share.test', appUrl: APP_URL, format: 'md' })
    expect(markdown).toContain('### Transcrição\n\nProfessor [00:05]: Olá.')
    expect(markdown).toContain('1. Quais?\nA) um\nB) dois\nC) três\nGabarito: A) um; C) três\n\n')
    expect(markdown).toContain('2. A Terra é plana.\nGabarito: Errado\nExplicação: Não é.')
    expect(markdown).toContain('3. Ordene.\nGabarito: 1. abrir; 2. ler; 3. fechar')
    expect(markdown).toContain('4. Associe.\nGabarito: H2O → água')
    expect(markdown).toContain('5. Metade é ___.\nGabarito: [1] 1/2\nFonte: https://prova.test/1')
    expect(renderSharePage(share, { origin: 'https://share.test', appUrl: APP_URL })).toContain('<pre>Professor [00:05]: Olá.</pre>')
  })
})

describe('share of an entrada with its family (FR-070)', () => {
  const mapOfAta = { id: 'm1', kind: 'mapa', name: 'Portal novo', diagram: { form: 'arvore', root: { id: 'r', text: 'Portal', children: [] } }, mermaid: 'flowchart LR\n  m0(["Portal"])' }
  const note = (id, name, parentFileId, fields = {}) => ({ id, name, folderId: null, type: 'class', position: 0, description: '', tags: [], content: `Texto de ${name}`, questions: [], meta: { parentFileId }, ...fields })
  const entrada = {
    id: 'e',
    name: 'Reunião de planejamento',
    folderId: null,
    type: 'meeting',
    position: 0,
    description: '',
    tags: [],
    content: '',
    questions: [],
    recording,
    meta: { role: 'entrada', kept: 'arquivo', parentFileId: null, origin: { input: 'file', name: 'planejamento.mp4', mime: 'video/mp4', storage: 'none' } },
  }
  // sent in the order of the tree: each note after its mother
  const family = [entrada, note('ata', 'Ata', 'e', { type: 'meeting', artifacts: [mapOfAta] }), note('aula', 'Aula', 'e'), note('exp', 'Explicação', 'aula', { type: 'explanation' }), note('extra', 'Pontos jurídicos', 'exp', { type: 'explanation' })]

  async function entradaShare(files = family) {
    const response = await call('POST', '/shares', { token: 'token-ana', body: { turnstileToken: 'ok', share: { kind: 'entrada', title: 'Reunião de planejamento', folders: [], files } } })
    expect(response.status).toBe(201)
    return (await response.json()).id
  }

  function inOrder(text, parts) {
    const found = parts.map(part => text.indexOf(part))
    expect(found.every(index => index >= 0)).toBe(true)
    expect(found).toEqual([...found].sort((a, b) => a - b))
  }

  it('accepts kind "entrada" and keeps who is the entrada and the mother of each note', async () => {
    const id = await entradaShare()
    expect(manifestOf(id)).toMatchObject({ kind: 'entrada', title: 'Reunião de planejamento' })
    expect(JSON.parse(env.BUCKET.objects.get(`shared/${id}/Explicação.json`).body).meta).toMatchObject({ parentFileId: 'aula' })
    expect(JSON.parse(env.BUCKET.objects.get(`shared/${id}/Reunião de planejamento.json`).body).meta).toMatchObject({ role: 'entrada', parentFileId: null })
    expect((await call('POST', '/shares', { token: 'token-ana', body: { turnstileToken: 'ok', share: { kind: 'familia', title: 'x', folders: [], files: family } } })).status).toBe(415)
  })

  it('the page carries the entrada, its media and transcription, and the notes nested under their mothers, one heading deeper per level', async () => {
    const id = await entradaShare()
    await uploadMedia(id, 'e', MEDIA, { mime: 'video/mp4' })
    const html = await (await call('GET', `/s/${id}`, { origin: null })).text()
    expect(html).toContain('<h1>Reunião de planejamento</h1>')
    expect(html).toMatch(/<meta name="description" content="Reunião de planejamento: uma entrada com 4 notas[^"]*">/)
    inOrder(html, [
      '<h2>Reunião de planejamento</h2>',
      'Tipo: Entrada · planejamento.mp4',
      `Mídia (video/mp4, 10 bytes): <a href="https://share.test/media/${id}/e">`,
      '<h3>Transcrição</h3>',
      '<h3>Ata</h3>',
      'Texto de Ata',
      '<h4>Mapa mental: Portal novo</h4>',
      '<h3>Aula</h3>',
      'Texto de Aula',
      '<h4>Explicação</h4>',
      'Texto de Explicação',
      '<h5>Pontos jurídicos</h5>',
    ])
    const markdown = await (await call('GET', `/s/${id}.md`, { origin: null })).text()
    inOrder(markdown, ['## Reunião de planejamento', '### Transcrição', '### Ata', '#### Mapa mental: Portal novo', '### Aula', '#### Explicação', '##### Pontos jurídicos'])
  })

  it('only what was chosen: a note left out is not on the page, and a note whose mother did not come hangs from the entrada', async () => {
    const id = await entradaShare([entrada, note('ata', 'Ata', 'e'), note('solta', 'Nota solta', 'fora')])
    const html = await (await call('GET', `/s/${id}`, { origin: null })).text()
    expect(html).not.toMatch(/<h\d>(Aula|Explicação|Pontos jurídicos)<\/h\d>|Texto de (Aula|Explicação)/)
    inOrder(html, ['<h2>Reunião de planejamento</h2>', '<h3>Ata</h3>', '<h3>Nota solta</h3>'])
    expect(html).toMatch(/content="Reunião de planejamento: uma entrada com 2 notas/)
  })

  it('an entrada with no note goes alone, with its transcription', async () => {
    const id = await entradaShare([entrada])
    const html = await (await call('GET', `/s/${id}`, { origin: null })).text()
    inOrder(html, ['<h2>Reunião de planejamento</h2>', '<h3>Transcrição</h3>', 'Você [00:00]: Bom dia.'])
    expect(html).toMatch(/content="Reunião de planejamento: uma entrada, sem notas/)
  })
})
