import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import worker from '../../../transcription-worker/index.js'

const KEY = 'di-secret-key-123'
const ORIGIN = 'https://study.ryns.me'

class FakeBucket {
  objects = new Map<string, { body: string; etag: string }>()
  private serial = 0

  async get(key: string) {
    const object = this.objects.get(key)
    return object ? { etag: object.etag, json: async () => JSON.parse(object.body) } : null
  }

  async put(key: string, body: string, options: { onlyIf?: Headers | { etagMatches: string } } = {}) {
    const current = this.objects.get(key)
    if (options.onlyIf && (options.onlyIf instanceof Headers ? current : current?.etag !== options.onlyIf.etagMatches)) return null
    this.objects.set(key, { body, etag: `e${++this.serial}` })
    return {}
  }

  tokens(key: string) {
    const object = this.objects.get(key)
    return object ? JSON.parse(object.body) : { input: 0, output: 0 }
  }
}

let bucket: FakeBucket
let upstream: { url: string; body: Record<string, unknown> }[]
let pending: Promise<unknown>[]
const ACCOUNT = 'counters/ai/2026-09-29/account/perm-ana.json'
const IP = 'counters/ai/2026-09-29/ip/1.2.3.4.json'

function streamReply(text: string, usage: { prompt_tokens: number; completion_tokens: number }) {
  const events = [{ choices: [{ delta: { content: text } }] }, { choices: [], usage }].map(event => `data: ${JSON.stringify(event)}\n\n`).join('') + 'data: [DONE]\n\n'
  return new Response(events, { headers: { 'Content-Type': 'text/event-stream' } })
}

async function chat(body: Record<string, unknown>, { token = 'token-ana', ip = '1.2.3.4' } = {}) {
  const headers = new Headers({ Origin: ORIGIN, 'CF-Connecting-IP': ip, 'Content-Type': 'application/json' })
  if (token) headers.set('Authorization', `Bearer ${token}`)
  const response = await worker.fetch(
    new Request('https://ai.test/chat/completions', { method: 'POST', headers, body: JSON.stringify(body) }),
    { BUCKET: bucket, DEEPINFRA_API_KEY: KEY, ALLOWED_ORIGINS: ORIGIN, UNLOCK_CODE: 'segredo' },
    { waitUntil: promise => void pending.push(promise) },
  )
  const text = await response.text()
  await Promise.all(pending)
  return { status: response.status, text }
}

const request = { model: 'qualquer', stream: true, messages: [{ role: 'system', content: 's' }, { role: 'user', content: 'aula' }] }

beforeEach(() => {
  bucket = new FakeBucket()
  upstream = []
  pending = []
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-09-29T15:00:00Z'))
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit = {}) => {
      if (url.startsWith('https://www.googleapis.com/drive/v3/about')) {
        const token = new Headers(init.headers).get('Authorization')?.replace('Bearer ', '')
        return token === 'token-ana' ? new Response(JSON.stringify({ user: { permissionId: 'perm-ana' } })) : new Response('{}', { status: 401 })
      }
      upstream.push({ url, body: JSON.parse(String(init.body)) })
      return streamReply('# Aula', { prompt_tokens: 23887, completion_tokens: 5351 })
    }),
  )
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('free AI generation in the worker', () => {
  it('refuses without a Google login and never calls DeepInfra', async () => {
    expect((await chat(request, { token: '' })).status).toBe(401)
    expect(upstream).toHaveLength(0)
  })

  it('always asks DeepInfra for Ling-3.0-flash, relays the stream and charges the tokens of the usage', async () => {
    const reply = await chat(request)
    expect(reply.status).toBe(200)
    expect(reply.text).toContain('# Aula')
    expect(upstream[0].url).toBe('https://api.deepinfra.com/v1/openai/chat/completions')
    expect(upstream[0].body).toMatchObject({ model: 'inclusionAI/Ling-3.0-flash', stream_options: { include_usage: true } })
    expect(bucket.tokens(ACCOUNT)).toEqual({ input: 23887, output: 5351 })
    expect(bucket.tokens(IP)).toEqual({ input: 23887, output: 5351 })
    expect(reply.text).not.toContain(KEY)
  })

  it('lets a generation finish past the limit and refuses the next one without calling DeepInfra', async () => {
    bucket.objects.set(ACCOUNT, { body: JSON.stringify({ input: 214000, output: 1000 }), etag: 'x' })
    expect((await chat(request)).status).toBe(200)
    expect(bucket.tokens(ACCOUNT).input).toBeGreaterThan(214983)
    const refused = await chat(request)
    expect(refused.status).toBe(429)
    expect(JSON.parse(refused.text)).toMatchObject({ error: 'no_tokens', input_tokens_remaining: 0 })
    expect(upstream).toHaveLength(1)
  })

  it('refuses an IP past three accounts of output even for a fresh account', async () => {
    bucket.objects.set(IP, { body: JSON.stringify({ input: 0, output: 48159 * 3 }), etag: 'x' })
    expect((await chat(request)).status).toBe(429)
    expect(upstream).toHaveLength(0)
  })
})

async function call(path: string, method: string, body?: Record<string, unknown>) {
  const headers = new Headers({ Origin: ORIGIN, 'CF-Connecting-IP': '1.2.3.4', Authorization: 'Bearer token-ana', 'Content-Type': 'application/json' })
  const response = await worker.fetch(new Request(`https://ai.test${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined }), { BUCKET: bucket, DEEPINFRA_API_KEY: KEY, ALLOWED_ORIGINS: ORIGIN, UNLOCK_CODE: 'segredo' })
  return { status: response.status, body: await response.json() }
}

describe('secret code bonus', () => {
  it('allows three tries a day: wrong codes are refused and the fourth try is blocked even with the right code', async () => {
    for (let i = 0; i < 3; i++) expect((await call('/unlock', 'POST', { code: 'errado' })).status).toBe(403)
    expect((await call('/unlock', 'POST', { code: 'segredo' })).status).toBe(429)
    expect([...bucket.objects.keys()].some(key => key.startsWith('grants/'))).toBe(false)
  })

  it('the right code doubles the free minutes and tokens of that account for good', async () => {
    expect((await call('/balance', 'GET')).body).toMatchObject({ account_daily_seconds: 1800, account_daily_input_tokens: 214983 })
    expect((await call('/unlock', 'POST', { code: 'segredo' })).status).toBe(200)
    vi.setSystemTime(new Date('2026-10-05T15:00:00Z'))
    expect((await call('/balance', 'GET')).body).toMatchObject({ account_daily_seconds: 3600, remaining_seconds: 3600, account_daily_input_tokens: 214983 * 2, account_daily_output_tokens: 48159 * 2 })
  })
})
