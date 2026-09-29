import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import worker, { dayOf } from './index.js'

const ORIGIN = 'https://study.ryns.me'
const KB = 1024
const PASS_SECRET = '1x0000000000000000000000000000000AA'
const FAIL_SECRET = '2x0000000000000000000000000000000AA'

function fakeBucket() {
  const objects = new Map()
  let version = 0
  const allowed = (current, onlyIf) => {
    if (!onlyIf) return true
    if (onlyIf.etagMatches !== undefined) return Boolean(current) && current.etag === onlyIf.etagMatches
    if (onlyIf.etagDoesNotMatch === '*') return !current
    return true
  }
  const view = (key, stored) => ({
    key,
    etag: stored.etag,
    customMetadata: stored.customMetadata,
    httpMetadata: stored.httpMetadata,
    body: stored.body,
    json: async () => JSON.parse(stored.body),
    text: async () => stored.body,
  })
  return {
    objects,
    async get(key) {
      const stored = objects.get(key)
      return stored ? view(key, stored) : null
    },
    async head(key) {
      const stored = objects.get(key)
      return stored ? view(key, stored) : null
    },
    async put(key, body, options = {}) {
      if (!allowed(objects.get(key), options.onlyIf)) return null
      const stored = { body, etag: `e${++version}`, customMetadata: options.customMetadata ?? {}, httpMetadata: options.httpMetadata ?? {} }
      objects.set(key, stored)
      return view(key, stored)
    },
    async delete(key) {
      objects.delete(key)
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

function call(method, path, { token, ip = '1.1.1.1', body, contentType = 'application/json' } = {}) {
  const headers = { Origin: ORIGIN, 'CF-Connecting-IP': ip }
  if (token) headers.Authorization = `Bearer ${token}`
  if (body !== undefined) headers['Content-Type'] = contentType
  return worker.fetch(new Request(`https://share.test${path}`, { method, headers, body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body) }), env)
}

function post(options = {}) {
  return call('POST', '/shares', { token: 'token-ana', body: { turnstileToken: 'XXXX.DUMMY.TOKEN.XXXX', share: share(options.contentBytes) }, ...options })
}

async function sizeOf(contentBytes) {
  const response = await post({ contentBytes })
  const body = await response.json()
  return body.bytes
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
    const quota = await call('GET', '/quota', { token: 'token-fake' })
    expect(quota.status).toBe(401)
  })

  it('refuses when Turnstile fails', async () => {
    env.TURNSTILE_SECRET = FAIL_SECRET
    const response = await post()
    expect(response.status).toBe(403)
    expect(await response.json()).toEqual({ error: 'turnstile_failed' })
    const missing = await call('POST', '/shares', { token: 'token-ana', body: { share: share() } })
    expect(missing.status).toBe(403)
  })

  it('stores only text under shared/ and counters apart', async () => {
    const response = await post()
    expect(response.status).toBe(201)
    const body = await response.json()
    expect(body.id).toMatch(/^[A-Za-z0-9_-]{22}$/)
    expect(Date.parse(body.expiresAt) - Date.parse(body.createdAt)).toBe(3 * 24 * 3600 * 1000)
    const keys = [...env.BUCKET.objects.keys()].sort()
    expect(keys.filter(key => key.startsWith('shared/'))).toEqual([`shared/${body.id}.json`])
    expect(keys.filter(key => key.startsWith('counters/2026-09-28/'))).toHaveLength(3)
    const stored = JSON.parse(env.BUCKET.objects.get(`shared/${body.id}.json`).body)
    expect(stored.files[0].content).toHaveLength(1000)
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
    expect(JSON.parse(env.BUCKET.objects.get(`shared/${id}.json`).body).files[0].source).toBeUndefined()
  })

  it('refuses an account over 300 KB with the remaining', async () => {
    const first = await post({ contentBytes: 200 * KB })
    expect(first.status).toBe(201)
    const used = (await first.json()).bytes
    const second = await post({ contentBytes: 150 * KB })
    expect(second.status).toBe(429)
    const body = await second.json()
    expect(body.error).toBe('account_limit')
    expect(body.remaining).toBe(300 * KB - used)
    const quota = await (await call('GET', '/quota', { token: 'token-ana' })).json()
    expect(quota.remaining).toBe(300 * KB - used)
    expect(quota.account.used).toBe(used)
  })

  it('refuses an IP over 900 KB even for different accounts', async () => {
    const tokens = Object.fromEntries(Array.from({ length: 4 }, (_, index) => [`token-${index}`, `perm-${index}`]))
    Object.assign(accounts, tokens)
    for (const token of ['token-0', 'token-1', 'token-2']) expect((await post({ token, contentBytes: 290 * KB })).status).toBe(201)
    const refused = await post({ token: 'token-3', contentBytes: 290 * KB })
    expect(refused.status).toBe(429)
    expect((await refused.json()).error).toBe('ip_limit')
    const accountKeys = [...env.BUCKET.objects.keys()].filter(key => key.includes('/account-'))
    const touched = accountKeys.map(key => JSON.parse(env.BUCKET.objects.get(key).body).used)
    expect(touched.filter(used => used === 0)).toHaveLength(1)
    expect((await post({ token: 'token-3', ip: '2.2.2.2', contentBytes: 290 * KB })).status).toBe(201)
  })

  it('refuses when the site passed 100 MB', async () => {
    const day = dayOf(Date.now())
    await env.BUCKET.put(`counters/${day}/site.json`, JSON.stringify({ used: 100 * KB * KB - 500 }))
    const refused = await post({ contentBytes: 1000 })
    expect(refused.status).toBe(429)
    const body = await refused.json()
    expect(body).toMatchObject({ error: 'site_limit', remaining: 500 })
    const accountKey = [...env.BUCKET.objects.keys()].find(key => key.includes('/account-'))
    expect(JSON.parse(env.BUCKET.objects.get(accountKey).body).used).toBe(0)
  })

  it('turns the day at midnight in America/Sao_Paulo', async () => {
    vi.setSystemTime(new Date('2026-09-29T02:59:00Z'))
    expect(dayOf(Date.now())).toBe('2026-09-28')
    expect((await post({ contentBytes: 290 * KB })).status).toBe(201)
    expect((await post({ contentBytes: 20 * KB })).status).toBe(429)
    vi.setSystemTime(new Date('2026-09-29T03:00:00Z'))
    expect(dayOf(Date.now())).toBe('2026-09-29')
    expect((await post({ contentBytes: 20 * KB })).status).toBe(201)
  })

  it('gives the KB back when deleting on the same day only', async () => {
    const bytes = await sizeOf(100 * KB)
    const [sameDayId] = [...env.BUCKET.objects.keys()].filter(key => key.startsWith('shared/')).map(key => key.slice(7, -5))
    const stranger = await call('DELETE', `/shares/${sameDayId}`, { token: 'token-bia' })
    expect(stranger.status).toBe(403)
    const removed = await call('DELETE', `/shares/${sameDayId}`, { token: 'token-ana' })
    expect(removed.status).toBe(200)
    expect(await removed.json()).toEqual({ returned: bytes, remaining: 300 * KB })
    expect(env.BUCKET.objects.has(`shared/${sameDayId}.json`)).toBe(false)

    const created = await post({ contentBytes: 100 * KB })
    const { id: oldId } = await created.json()
    vi.setSystemTime(new Date('2026-09-29T15:00:00Z'))
    await post({ contentBytes: 10 * KB })
    const before = await (await call('GET', '/quota', { token: 'token-ana' })).json()
    const late = await call('DELETE', `/shares/${oldId}`, { token: 'token-ana' })
    const after = await late.json()
    expect(after.returned).toBe(0)
    expect(after.remaining).toBe(before.remaining)
    expect(JSON.parse(env.BUCKET.objects.get('counters/2026-09-28/site.json').body).used).toBe(bytes)
    const gone = await call('DELETE', `/shares/${oldId}`, { token: 'token-ana' })
    expect(gone.status).toBe(404)
  })

  it('does not let concurrent shares both pass the limit', async () => {
    const results = await Promise.all([post({ contentBytes: 200 * KB }), post({ contentBytes: 200 * KB }), post({ contentBytes: 200 * KB })])
    expect(results.map(response => response.status).sort()).toEqual([201, 429, 429])
  })

  it('answers CORS only for the allowed origins', async () => {
    const blocked = await worker.fetch(new Request('https://share.test/quota', { headers: { Origin: 'https://evil.test' } }), env)
    expect(blocked.status).toBe(403)
    const local = await worker.fetch(new Request('https://share.test/quota', { method: 'OPTIONS', headers: { Origin: 'http://localhost:5184' } }), env)
    expect(local.status).toBe(204)
    expect(local.headers.get('Access-Control-Allow-Origin')).toBe('http://localhost:5184')
  })

  it('serves shared files only when the dev flag is on, and not after expiry', async () => {
    const { id } = await (await post()).json()
    expect((await call('GET', `/shared/${id}.json`)).status).toBe(404)
    env.SERVE_SHARED = 'true'
    const served = await call('GET', `/shared/${id}.json`)
    expect(served.status).toBe(200)
    expect((await served.json()).id).toBe(id)
    vi.setSystemTime(new Date('2026-10-01T15:00:01Z'))
    expect((await call('GET', `/shared/${id}.json`)).status).toBe(404)
  })
})
