const DEEPINFRA_URL = 'https://api.deepinfra.com/v1/inference/openai/whisper-large-v3-turbo'
const GOOGLE_API_BASE = 'https://www.googleapis.com'
const LOCAL_ORIGIN = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/
const TIME_ZONE = 'America/Sao_Paulo'
const ACCOUNT_DAILY_SECONDS = 30 * 60
const IP_DAILY_SECONDS = 90 * 60
const MAX_AUDIO_BYTES = 100 * 1024 * 1024
const WAV_HEADER_BYTES = 44
const WRITE_ATTEMPTS = 8

class CounterBusy extends Error {}

function allowedOrigin(origin, env) {
  if (!origin) return null
  const listed = (env.ALLOWED_ORIGINS ?? '').split(',').map(item => item.trim()).filter(Boolean)
  return listed.includes(origin) || LOCAL_ORIGIN.test(origin) ? origin : null
}

function corsHeaders(origin) {
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  }
}

function json(body, status, headers) {
  return new Response(JSON.stringify(body), { status, headers: { ...headers, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } })
}

function dayOf(now) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now)
}

function counterKeys(day, person, ip) {
  return {
    account: `counters/transcription/${day}/account/${encodeURIComponent(person)}.json`,
    ip: `counters/transcription/${day}/ip/${encodeURIComponent(ip)}.json`,
  }
}

async function personOf(request, env) {
  const token = (request.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '').trim()
  if (!token) return null
  const response = await fetch(`${env.GOOGLE_API_BASE || GOOGLE_API_BASE}/drive/v3/about?fields=user(emailAddress,permissionId)`, { headers: { Authorization: `Bearer ${token}` } }).catch(() => null)
  if (!response?.ok) return null
  const body = await response.json().catch(() => null)
  return typeof body?.user?.permissionId === 'string' && body.user.permissionId ? body.user.permissionId : null
}

async function secondsIn(object) {
  if (!object) return 0
  const body = await object.json().catch(() => null)
  return Number(body?.seconds) || 0
}

async function addSeconds(bucket, key, seconds) {
  for (let attempt = 0; attempt < WRITE_ATTEMPTS; attempt++) {
    const object = await bucket.get(key)
    const used = await secondsIn(object)
    const onlyIf = object ? { etagMatches: object.etag } : new Headers({ 'If-None-Match': '*' })
    const written = await bucket.put(key, JSON.stringify({ seconds: used + seconds }), { onlyIf, httpMetadata: { contentType: 'application/json' } })
    if (written) return
  }
  throw new CounterBusy()
}

async function balanceOf(env, day, person, ip) {
  const keys = counterKeys(day, person, ip)
  const [account, address] = await Promise.all([env.BUCKET.get(keys.account).then(secondsIn), env.BUCKET.get(keys.ip).then(secondsIn)])
  const accountLeft = Math.max(0, ACCOUNT_DAILY_SECONDS - account)
  const ipLeft = Math.max(0, IP_DAILY_SECONDS - address)
  return { day, keys, accountLeft, ipLeft, remaining: Math.min(accountLeft, ipLeft) }
}

function balanceBody(balance, used = 0) {
  return {
    day: balance.day,
    remaining_seconds: Math.max(0, balance.remaining - used),
    account_remaining_seconds: Math.max(0, balance.accountLeft - used),
    ip_remaining_seconds: Math.max(0, balance.ipLeft - used),
    account_daily_seconds: ACCOUNT_DAILY_SECONDS,
    ip_daily_seconds: IP_DAILY_SECONDS,
  }
}

async function wavSeconds(audio) {
  if (audio.size <= WAV_HEADER_BYTES) return null
  const head = new Uint8Array(await audio.slice(0, WAV_HEADER_BYTES).arrayBuffer())
  const tag = offset => String.fromCharCode(...head.subarray(offset, offset + 4))
  if (tag(0) !== 'RIFF' || tag(8) !== 'WAVE') return null
  const byteRate = new DataView(head.buffer).getUint32(28, true)
  return byteRate ? (audio.size - WAV_HEADER_BYTES) / byteRate : null
}

async function transcribe(request, env, balance, headers) {
  if (Number(request.headers.get('Content-Length') ?? 0) > MAX_AUDIO_BYTES) return json({ error: 'too_large' }, 413, headers)
  const form = await request.formData().catch(() => null)
  const audio = form?.get('audio')
  if (!audio || typeof audio === 'string') return json({ error: 'missing_audio' }, 400, headers)
  if (audio.size > MAX_AUDIO_BYTES) return json({ error: 'too_large' }, 413, headers)
  const seconds = await wavSeconds(audio)
  if (seconds === null) return json({ error: 'wav_only' }, 415, headers)
  if (seconds > balance.remaining) return json({ error: 'no_minutes', audio_seconds: seconds, ...balanceBody(balance) }, 429, headers)
  const upstream = new FormData()
  upstream.append('audio', audio, 'audio.wav')
  const language = form.get('language')
  if (typeof language === 'string' && language) upstream.append('language', language)
  const response = await fetch(env.DEEPINFRA_URL || DEEPINFRA_URL, { method: 'POST', headers: { Authorization: `bearer ${env.DEEPINFRA_API_KEY}` }, body: upstream }).catch(() => null)
  if (!response) return json({ error: 'upstream_unreachable' }, 502, headers)
  if (!response.ok) return json({ error: 'upstream_error', status: response.status }, 502, headers)
  const body = await response.json().catch(() => null)
  if (!body) return json({ error: 'upstream_invalid' }, 502, headers)
  const used = Number(body.input_length_ms) / 1000 || Number(body.duration) || seconds
  await Promise.allSettled([addSeconds(env.BUCKET, balance.keys.account, used), addSeconds(env.BUCKET, balance.keys.ip, used)])
  const segments = Array.isArray(body.segments) ? body.segments.map(segment => ({ start: Number(segment.start) || 0, end: Number(segment.end) || 0, text: String(segment.text ?? '') })) : []
  return json({ text: String(body.text ?? ''), segments, language: String(body.language ?? ''), duration: used, ...balanceBody(balance, used) }, 200, headers)
}

export default {
  async fetch(request, env) {
    const origin = allowedOrigin(request.headers.get('Origin'), env)
    if (!origin) return new Response('Forbidden', { status: 403 })
    const headers = corsHeaders(origin)
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers })
    const path = new URL(request.url).pathname
    const route = `${request.method} ${path}`
    if (route !== 'GET /balance' && route !== 'POST /transcribe') return json({ error: 'not_found' }, 404, headers)
    try {
      const person = await personOf(request, env)
      if (!person) return json({ error: 'login_required' }, 401, headers)
      const balance = await balanceOf(env, dayOf(new Date()), person, request.headers.get('CF-Connecting-IP') ?? 'unknown')
      if (route === 'GET /balance') return json(balanceBody(balance), 200, headers)
      return await transcribe(request, env, balance, headers)
    } catch (error) {
      return json({ error: error instanceof CounterBusy ? 'counter_busy' : 'internal' }, error instanceof CounterBusy ? 503 : 500, headers)
    }
  },
}
