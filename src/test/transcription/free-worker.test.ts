import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Blob as NodeBlob, File as NodeFile } from 'node:buffer'

import worker from '../../../transcription-worker/index.js'

const KEY = 'di-secret-key-123'
const ORIGIN = 'https://study.ryns.me'
const BYTES_PER_SECOND = 100

class FakeBucket {
  objects = new Map<string, { body: string; etag: string }>()
  private serial = 0

  async get(key: string) {
    const object = this.objects.get(key)
    return object ? { etag: object.etag, json: async () => JSON.parse(object.body) } : null
  }

  async put(key: string, body: string, options: { onlyIf: Headers | { etagMatches: string } }) {
    await Promise.resolve()
    const current = this.objects.get(key)
    const match = options.onlyIf instanceof Headers ? null : options.onlyIf.etagMatches
    if (options.onlyIf instanceof Headers && options.onlyIf.get('If-None-Match') === '*' && current) return null
    if (match && current?.etag !== match) return null
    const etag = `e${++this.serial}`
    this.objects.set(key, { body, etag })
    return { etag }
  }

  seconds(key: string): number {
    const object = this.objects.get(key)
    return object ? JSON.parse(object.body).seconds : 0
  }
}

interface Upstream {
  url: string
  init: RequestInit
}

let bucket: FakeBucket
let upstream: Upstream[]
let spokenMs: number | null
let deepinfraStatus: number
const people: Record<string, string> = { 'token-ana': 'perm-ana', 'token-bia': 'perm-bia', 'token-caio': 'perm-caio', 'token-duda': 'perm-duda' }
const responses: string[] = []

function wav(seconds: number): Blob {
  const header = new Uint8Array(44)
  const view = new DataView(header.buffer)
  header.set([...'RIFF'].map(char => char.charCodeAt(0)), 0)
  header.set([...'WAVE'].map(char => char.charCodeAt(0)), 8)
  view.setUint32(28, BYTES_PER_SECOND, true)
  return new NodeBlob([header, new Uint8Array(Math.round(seconds * BYTES_PER_SECOND))], { type: 'audio/wav' }) as unknown as Blob
}

function env() {
  return { BUCKET: bucket, DEEPINFRA_API_KEY: KEY, ALLOWED_ORIGINS: 'https://study.ryns.me,https://regyeduardo.github.io' }
}

async function call(path: string, { token, ip = '1.2.3.4', audio, origin = ORIGIN }: { token?: string; ip?: string; audio?: Blob; origin?: string } = {}) {
  const headers = new Headers({ Origin: origin, 'CF-Connecting-IP': ip })
  if (token) headers.set('Authorization', `Bearer ${token}`)
  let body: FormData | undefined
  if (audio) {
    body = new FormData()
    body.append('audio', audio, 'trecho.wav')
    body.append('language', 'pt')
  }
  const response = await worker.fetch(new Request(`https://transcription.test${path}`, { method: audio ? 'POST' : 'GET', headers, body }), env())
  const text = await response.text()
  responses.push(text, JSON.stringify([...response.headers]))
  return { status: response.status, body: text ? JSON.parse(text.startsWith('{') ? text : '{}') : {} }
}

beforeEach(async () => {
  vi.stubGlobal('Blob', NodeBlob)
  vi.stubGlobal('File', NodeFile)
  vi.stubGlobal('FormData', (await new Response('probe=1', { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }).formData()).constructor)
  bucket = new FakeBucket()
  upstream = []
  spokenMs = null
  deepinfraStatus = 200
  responses.length = 0
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-09-28T15:00:00Z'))
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit = {}) => {
      if (url.startsWith('https://www.googleapis.com/drive/v3/about')) {
        const token = new Headers(init.headers).get('Authorization')?.replace('Bearer ', '') ?? ''
        const person = people[token]
        return person ? new Response(JSON.stringify({ user: { permissionId: person, emailAddress: `${person}@example.com` } })) : new Response('{"error":{"code":401}}', { status: 401 })
      }
      upstream.push({ url, init })
      if (deepinfraStatus !== 200) return new Response(JSON.stringify({ detail: `bad key ${KEY}` }), { status: deepinfraStatus })
      const audio = (init.body as FormData).get('audio') as Blob
      const seconds = (audio.size - 44) / BYTES_PER_SECOND
      return new Response(
        JSON.stringify({
          text: ' olá mundo ',
          segments: [{ id: 0, start: 0, end: 1.5, text: ' olá mundo ' }],
          language: 'pt',
          input_length_ms: spokenMs ?? seconds * 1000,
          duration: seconds,
          inference_status: { status: 'succeeded', runtime_ms: 300, cost: 0.0001 },
        }),
      )
    }),
  )
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('transcription worker', () => {
  it('refuses without a Google login and never calls DeepInfra', async () => {
    expect((await call('/balance')).status).toBe(401)
    const refused = await call('/transcribe', { audio: wav(10) })
    expect(refused.status).toBe(401)
    expect(refused.body.error).toBe('login_required')
    expect(upstream).toHaveLength(0)
  })

  it('refuses a token Google does not accept', async () => {
    const refused = await call('/transcribe', { token: 'forged-token', audio: wav(10) })
    expect(refused.status).toBe(401)
    expect(upstream).toHaveLength(0)
    expect(bucket.objects.size).toBe(0)
  })

  it('refuses a site outside the allowed origins', async () => {
    expect((await call('/balance', { token: 'token-ana', origin: 'https://evil.example' })).status).toBe(403)
    expect((await call('/balance', { token: 'token-ana', origin: 'http://localhost:5185' })).status).toBe(200)
  })

  it('forwards the audio with the secret key and deducts the duration DeepInfra returns', async () => {
    spokenMs = 42_000
    const done = await call('/transcribe', { token: 'token-ana', audio: wav(60) })
    expect(done.status).toBe(200)
    expect(done.body.text).toBe(' olá mundo ')
    expect(done.body.segments).toEqual([{ start: 0, end: 1.5, text: ' olá mundo ' }])
    expect(done.body.duration).toBe(42)
    expect(done.body.remaining_seconds).toBe(1800 - 42)
    expect(upstream[0].url).toBe('https://api.deepinfra.com/v1/inference/openai/whisper-large-v3-turbo')
    expect(new Headers(upstream[0].init.headers).get('Authorization')).toBe(`bearer ${KEY}`)
    expect((upstream[0].init.body as FormData).get('audio')).toBeInstanceOf(Blob)
    expect((upstream[0].init.body as FormData).get('language')).toBe('pt')
    expect(bucket.seconds(`counters/transcription/2026-09-28/account/perm-ana.json`)).toBe(42)
    expect(bucket.seconds(`counters/transcription/2026-09-28/ip/1.2.3.4.json`)).toBe(42)
    expect((await call('/balance', { token: 'token-ana' })).body.remaining_seconds).toBe(1800 - 42)
  })

  it('returns the text already transcribed even when the counters cannot be written', async () => {
    bucket.put = async () => null
    const done = await call('/transcribe', { token: 'token-ana', audio: wav(20) })
    expect(done.status).toBe(200)
    expect(done.body.text).toBe(' olá mundo ')
  })

  it('refuses an account past 30 minutes without calling DeepInfra', async () => {
    expect((await call('/transcribe', { token: 'token-ana', audio: wav(29 * 60) })).status).toBe(200)
    const refused = await call('/transcribe', { token: 'token-ana', audio: wav(61) })
    expect(refused.status).toBe(429)
    expect(refused.body).toMatchObject({ error: 'no_minutes', remaining_seconds: 60, account_remaining_seconds: 60 })
    expect(upstream).toHaveLength(1)
    expect((await call('/transcribe', { token: 'token-ana', audio: wav(60) })).status).toBe(200)
    expect((await call('/balance', { token: 'token-ana' })).body.remaining_seconds).toBe(0)
  })

  it('refuses an IP past 90 minutes even for a fresh account', async () => {
    for (const token of ['token-ana', 'token-bia', 'token-caio']) expect((await call('/transcribe', { token, audio: wav(30 * 60) })).status).toBe(200)
    const refused = await call('/transcribe', { token: 'token-duda', audio: wav(5) })
    expect(refused.status).toBe(429)
    expect(refused.body).toMatchObject({ account_remaining_seconds: 1800, ip_remaining_seconds: 0, remaining_seconds: 0 })
    expect(upstream).toHaveLength(3)
    expect((await call('/balance', { token: 'token-duda', ip: '5.6.7.8' })).body.remaining_seconds).toBe(1800)
  })

  it('turns the day at midnight in America/Sao_Paulo, not UTC', async () => {
    vi.setSystemTime(new Date('2026-09-29T02:59:00Z'))
    expect((await call('/transcribe', { token: 'token-ana', audio: wav(30 * 60) })).status).toBe(200)
    expect(bucket.seconds('counters/transcription/2026-09-28/account/perm-ana.json')).toBe(1800)
    expect((await call('/balance', { token: 'token-ana' })).body).toMatchObject({ day: '2026-09-28', remaining_seconds: 0 })
    vi.setSystemTime(new Date('2026-09-29T03:00:00Z'))
    expect((await call('/balance', { token: 'token-ana' })).body).toMatchObject({ day: '2026-09-29', remaining_seconds: 1800 })
  })

  it('counts two transcriptions at the same time without losing one', async () => {
    const [first, second] = await Promise.all([call('/transcribe', { token: 'token-ana', audio: wav(100) }), call('/transcribe', { token: 'token-ana', audio: wav(200) })])
    expect([first.status, second.status]).toEqual([200, 200])
    expect(bucket.seconds('counters/transcription/2026-09-28/account/perm-ana.json')).toBe(300)
  })

  it('never sends the DeepInfra key back, even when DeepInfra fails', async () => {
    await call('/transcribe', { token: 'token-ana', audio: wav(10) })
    deepinfraStatus = 401
    const failed = await call('/transcribe', { token: 'token-ana', audio: wav(10) })
    expect(failed.status).toBe(502)
    await call('/balance', { token: 'token-ana' })
    await call('/transcribe', { audio: wav(10) })
    expect(responses.length).toBeGreaterThan(6)
    expect(responses.some(text => text.includes(KEY) || text.includes('di-secret'))).toBe(false)
    expect(bucket.seconds('counters/transcription/2026-09-28/account/perm-ana.json')).toBe(10)
  })
})
