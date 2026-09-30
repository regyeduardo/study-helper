const DEEPINFRA_URL = 'https://api.deepinfra.com/v1/inference/openai/whisper-large-v3'
const GOOGLE_API_BASE = 'https://www.googleapis.com'
const LOCAL_ORIGIN = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/
const TIME_ZONE = 'America/Sao_Paulo'
const ACCOUNT_DAILY_SECONDS = 30 * 60
const IP_DAILY_SECONDS = 90 * 60
const MAX_AUDIO_BYTES = 100 * 1024 * 1024
const WAV_HEADER_BYTES = 44
const WRITE_ATTEMPTS = 8
const CHAT_URL = 'https://api.deepinfra.com/v1/openai/chat/completions'
const CHAT_MODEL = 'inclusionAI/Ling-3.0-flash'
const ACCOUNT_DAILY_INPUT_TOKENS = 214983
const ACCOUNT_DAILY_OUTPUT_TOKENS = 48159
const IP_DAILY_INPUT_TOKENS = ACCOUNT_DAILY_INPUT_TOKENS * 3
const IP_DAILY_OUTPUT_TOKENS = ACCOUNT_DAILY_OUTPUT_TOKENS * 3
const UNLOCK_ATTEMPTS_PER_DAY = 3
const BONUS_FACTOR = 2

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

async function hashOf(text) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('').slice(0, 32)
}

async function bonusKeyOf(person) {
  return `grants/account-${await hashOf(person)}.json`
}

async function factorOf(env, person) {
  return (await env.BUCKET.get(await bonusKeyOf(person))) ? BONUS_FACTOR : 1
}

async function spendAttempt(bucket, key) {
  for (let attempt = 0; attempt < WRITE_ATTEMPTS; attempt++) {
    const object = await bucket.get(key)
    const used = Number((await object?.json().catch(() => null))?.attempts) || 0
    if (used >= UNLOCK_ATTEMPTS_PER_DAY) return false
    const onlyIf = object ? { etagMatches: object.etag } : new Headers({ 'If-None-Match': '*' })
    if (await bucket.put(key, JSON.stringify({ attempts: used + 1 }), { onlyIf, httpMetadata: { contentType: 'application/json' } })) return true
  }
  throw new CounterBusy()
}

async function unlock(request, env, day, person, headers) {
  const input = await request.json().catch(() => null)
  if (!(await spendAttempt(env.BUCKET, `counters/unlock/${day}/${encodeURIComponent(person)}.json`))) return json({ error: 'too_many_attempts' }, 429, headers)
  if (!env.UNLOCK_CODE || typeof input?.code !== 'string' || input.code.trim() !== env.UNLOCK_CODE) return json({ error: 'wrong_code' }, 403, headers)
  await env.BUCKET.put(await bonusKeyOf(person), JSON.stringify({ factor: BONUS_FACTOR, at: new Date().toISOString() }), { httpMetadata: { contentType: 'application/json' } })
  return json({ ok: true }, 200, headers)
}

function aiCounterKeys(day, person, ip) {
  return {
    account: `counters/ai/${day}/account/${encodeURIComponent(person)}.json`,
    ip: `counters/ai/${day}/ip/${encodeURIComponent(ip)}.json`,
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

async function tokensIn(object) {
  if (!object) return { input: 0, output: 0 }
  const body = await object.json().catch(() => null)
  return { input: Number(body?.input) || 0, output: Number(body?.output) || 0 }
}

async function addTokens(bucket, key, input, output) {
  for (let attempt = 0; attempt < WRITE_ATTEMPTS; attempt++) {
    const object = await bucket.get(key)
    const used = await tokensIn(object)
    const onlyIf = object ? { etagMatches: object.etag } : new Headers({ 'If-None-Match': '*' })
    const written = await bucket.put(key, JSON.stringify({ input: used.input + input, output: used.output + output }), { onlyIf, httpMetadata: { contentType: 'application/json' } })
    if (written) return
  }
  throw new CounterBusy()
}

async function aiBalanceOf(env, day, person, ip, factor) {
  const keys = aiCounterKeys(day, person, ip)
  const [account, address] = await Promise.all([env.BUCKET.get(keys.account).then(tokensIn), env.BUCKET.get(keys.ip).then(tokensIn)])
  const input = Math.max(0, Math.min(ACCOUNT_DAILY_INPUT_TOKENS * factor - account.input, IP_DAILY_INPUT_TOKENS - address.input))
  const output = Math.max(0, Math.min(ACCOUNT_DAILY_OUTPUT_TOKENS * factor - account.output, IP_DAILY_OUTPUT_TOKENS - address.output))
  return { keys, input, output, factor }
}

function aiBalanceBody(balance) {
  return {
    input_tokens_remaining: balance.input,
    output_tokens_remaining: balance.output,
    account_daily_input_tokens: ACCOUNT_DAILY_INPUT_TOKENS * balance.factor,
    account_daily_output_tokens: ACCOUNT_DAILY_OUTPUT_TOKENS * balance.factor,
  }
}

async function chargeTokens(env, balance, usage) {
  const input = Number(usage?.prompt_tokens) || 0
  const output = Number(usage?.completion_tokens) || 0
  if (!input && !output) return
  await Promise.allSettled([addTokens(env.BUCKET, balance.keys.account, input, output), addTokens(env.BUCKET, balance.keys.ip, input, output)])
}

async function relayStream(body, writable, env, balance) {
  const writer = writable.getWriter()
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let usage = null
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      await writer.write(value)
      buffer += decoder.decode(value, { stream: true })
      let cut = buffer.indexOf('\n')
      while (cut >= 0) {
        const line = buffer.slice(0, cut).trim()
        buffer = buffer.slice(cut + 1)
        if (line.startsWith('data:') && line.includes('"usage"')) usage = JSON.parse(line.slice(5)).usage ?? usage
        cut = buffer.indexOf('\n')
      }
    }
  } finally {
    await writer.close().catch(() => undefined)
    await chargeTokens(env, balance, usage)
  }
}

async function chat(request, env, ctx, balance, headers) {
  const input = await request.json().catch(() => null)
  if (!input || !Array.isArray(input.messages)) return json({ error: 'invalid_body' }, 400, headers)
  if (balance.input <= 0 || balance.output <= 0) return json({ error: 'no_tokens', ...aiBalanceBody(balance) }, 429, headers)
  const upstream = { ...input, model: CHAT_MODEL, ...(input.stream ? { stream_options: { include_usage: true } } : {}) }
  const response = await fetch(env.CHAT_URL || CHAT_URL, { method: 'POST', headers: { Authorization: `bearer ${env.DEEPINFRA_API_KEY}`, 'Content-Type': 'application/json' }, body: JSON.stringify(upstream) }).catch(() => null)
  if (!response) return json({ error: 'upstream_unreachable' }, 502, headers)
  if (!response.ok) {
    const detail = (await response.text().catch(() => '')).split(env.DEEPINFRA_API_KEY || '\u0000').join('').slice(0, 300)
    return json({ error: { message: detail } }, response.status === 400 || response.status === 422 ? response.status : 502, headers)
  }
  if (!input.stream) {
    const body = await response.json().catch(() => null)
    if (!body) return json({ error: 'upstream_invalid' }, 502, headers)
    await chargeTokens(env, balance, body.usage)
    return json(body, 200, headers)
  }
  const { readable, writable } = new TransformStream()
  ctx.waitUntil(relayStream(response.body, writable, env, balance))
  return new Response(readable, { status: 200, headers: { ...headers, 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store' } })
}

async function balanceOf(env, day, person, ip, factor) {
  const keys = counterKeys(day, person, ip)
  const [account, address] = await Promise.all([env.BUCKET.get(keys.account).then(secondsIn), env.BUCKET.get(keys.ip).then(secondsIn)])
  const accountLeft = Math.max(0, ACCOUNT_DAILY_SECONDS * factor - account)
  const ipLeft = Math.max(0, IP_DAILY_SECONDS - address)
  return { day, keys, accountLeft, ipLeft, remaining: Math.min(accountLeft, ipLeft), factor }
}

function balanceBody(balance, used = 0) {
  return {
    day: balance.day,
    remaining_seconds: Math.max(0, balance.remaining - used),
    account_remaining_seconds: Math.max(0, balance.accountLeft - used),
    ip_remaining_seconds: Math.max(0, balance.ipLeft - used),
    account_daily_seconds: ACCOUNT_DAILY_SECONDS * balance.factor,
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
  async fetch(request, env, ctx) {
    const origin = allowedOrigin(request.headers.get('Origin'), env)
    if (!origin) return new Response('Forbidden', { status: 403 })
    const headers = corsHeaders(origin)
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers })
    const path = new URL(request.url).pathname
    const route = `${request.method} ${path}`
    if (!['GET /balance', 'POST /transcribe', 'POST /chat/completions', 'POST /unlock'].includes(route)) return json({ error: 'not_found' }, 404, headers)
    try {
      const person = await personOf(request, env)
      if (!person) return json({ error: 'login_required' }, 401, headers)
      const day = dayOf(new Date())
      const ip = request.headers.get('CF-Connecting-IP') ?? 'unknown'
      if (route === 'POST /unlock') return await unlock(request, env, day, person, headers)
      const factor = await factorOf(env, person)
      if (route === 'POST /chat/completions') return await chat(request, env, ctx, await aiBalanceOf(env, day, person, ip, factor), headers)
      const balance = await balanceOf(env, day, person, ip, factor)
      if (route === 'GET /balance') return json({ ...balanceBody(balance), ...aiBalanceBody(await aiBalanceOf(env, day, person, ip, factor)) }, 200, headers)
      return await transcribe(request, env, balance, headers)
    } catch (error) {
      return json({ error: error instanceof CounterBusy ? 'counter_busy' : 'internal' }, error instanceof CounterBusy ? 503 : 500, headers)
    }
  },
}
