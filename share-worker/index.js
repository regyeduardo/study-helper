const LOCAL_ORIGIN = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/
const GOOGLE_API_BASE = 'https://www.googleapis.com'
const TURNSTILE_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify'
const TIME_ZONE = 'America/Sao_Paulo'
const KB = 1024
const LIMITS = { account: 300 * KB, ip: 900 * KB, site: 100 * KB * KB }
const SHARE_DAYS = 3
const DAY_MS = 24 * 3600 * 1000
const CAS_ATTEMPTS = 10
const SHARED_PREFIX = 'shared/'
const SHARED_CACHE = 'public, max-age=60'
const SHARE_PATH = /^\/shares\/([A-Za-z0-9_-]{16,64})$/
const SHARED_FILE_PATH = /^\/shared\/([A-Za-z0-9_-]{16,64})\/(.+)$/
const MANIFEST_NAME = 'share.json'
const FOLDER_META_NAME = '.folder.json'

function allowedOrigin(origin, env) {
  if (!origin) return null
  const listed = (env.ALLOWED_ORIGINS ?? '').split(',').map(item => item.trim()).filter(Boolean)
  return listed.includes(origin) || LOCAL_ORIGIN.test(origin) ? origin : null
}

function corsHeaders(origin) {
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  }
}

function json(body, status, headers) {
  return new Response(JSON.stringify(body), { status, headers: { ...headers, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } })
}

export function dayOf(time) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(time))
}

async function hashOf(text) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('').slice(0, 32)
}

function bytesOf(text) {
  return new TextEncoder().encode(text).length
}

function newShareId() {
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

async function identify(request, env) {
  const token = (request.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '').trim()
  if (!token) return null
  const response = await fetch(`${env.GOOGLE_API_BASE || GOOGLE_API_BASE}/drive/v3/about?fields=user(emailAddress,permissionId)`, { headers: { Authorization: `Bearer ${token}` } }).catch(() => null)
  if (!response?.ok) return null
  const body = await response.json().catch(() => null)
  const permissionId = body?.user?.permissionId
  return typeof permissionId === 'string' && permissionId ? `account-${await hashOf(permissionId)}` : null
}

async function ipKeyOf(request) {
  return `ip-${await hashOf(request.headers.get('CF-Connecting-IP') ?? 'unknown')}`
}

async function turnstilePassed(token, request, env) {
  if (typeof token !== 'string' || !token || !env.TURNSTILE_SECRET) return false
  const form = new FormData()
  form.append('secret', env.TURNSTILE_SECRET)
  form.append('response', token)
  const ip = request.headers.get('CF-Connecting-IP')
  if (ip) form.append('remoteip', ip)
  const response = await fetch(TURNSTILE_URL, { method: 'POST', body: form }).catch(() => null)
  const body = await response?.json().catch(() => null)
  if (body?.success !== true) console.log(JSON.stringify({ turnstile: body?.['error-codes'] ?? 'no_response', hostname: body?.hostname ?? null }))
  return body?.success === true
}

function counterKey(day, name) {
  return `counters/${day}/${name}.json`
}

async function readCounter(bucket, key) {
  const object = await bucket.get(key)
  if (!object) return { used: 0, etag: null }
  const body = await object.json().catch(() => ({}))
  return { used: Number(body.used) || 0, etag: object.etag }
}

async function adjust(bucket, key, delta, limit) {
  for (let attempt = 0; attempt < CAS_ATTEMPTS; attempt++) {
    const { used, etag } = await readCounter(bucket, key)
    const next = Math.max(0, used + delta)
    if (delta > 0 && next > limit) return { ok: false, remaining: Math.max(0, limit - used) }
    const written = await bucket.put(key, JSON.stringify({ used: next }), {
      httpMetadata: { contentType: 'application/json' },
      onlyIf: etag ? { etagMatches: etag } : { etagDoesNotMatch: '*' },
    })
    if (written) return { ok: true, remaining: Math.max(0, limit - next) }
  }
  throw new Error('counter_busy')
}

async function factorOf(bucket, accountKey) {
  return (await bucket.get(`grants/${accountKey}.json`)) ? 2 : 1
}

function countersOf(day, accountKey, ipKey, factor = 1) {
  return [
    { name: 'account', key: counterKey(day, accountKey), limit: LIMITS.account * factor },
    { name: 'ip', key: counterKey(day, ipKey), limit: LIMITS.ip },
    { name: 'site', key: counterKey(day, 'site'), limit: LIMITS.site },
  ]
}

async function reserve(bucket, counters, bytes) {
  const done = []
  for (const counter of counters) {
    const result = await adjust(bucket, counter.key, bytes, counter.limit)
    if (!result.ok) {
      for (const previous of done) await adjust(bucket, previous.key, -bytes, previous.limit)
      return { ok: false, failed: counter.name, remaining: result.remaining }
    }
    done.push(counter)
  }
  return { ok: true }
}

async function quotaOf(bucket, counters) {
  const parts = {}
  for (const counter of counters) {
    const { used } = await readCounter(bucket, counter.key)
    parts[counter.name] = { used, limit: counter.limit }
  }
  const remaining = Math.max(0, Math.min(...counters.map(counter => counter.limit - parts[counter.name].used)))
  return { remaining, ...parts }
}

function hasBinary(text) {
  return text.includes('\u0000')
}

function isText(value) {
  return typeof value === 'string' && !hasBinary(value)
}

function textOrEmpty(value) {
  return typeof value === 'string' ? value : ''
}

function cleanFolder(folder) {
  if (!folder || typeof folder !== 'object' || !isText(folder.id) || !isText(folder.name)) return null
  return {
    id: folder.id,
    name: folder.name,
    parentId: isText(folder.parentId) ? folder.parentId : null,
    position: Number(folder.position) || 0,
    isCourse: folder.isCourse === true,
    description: textOrEmpty(folder.description),
  }
}

function plainObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) && !hasBinary(JSON.stringify(value)) ? value : null
}

function cleanFile(file) {
  if (!file || typeof file !== 'object' || !isText(file.id) || !isText(file.name) || !isText(file.content)) return null
  if (file.questions !== undefined && !Array.isArray(file.questions)) return null
  if (file.highlights !== undefined && !Array.isArray(file.highlights)) return null
  const questions = file.questions ?? []
  const highlights = file.highlights ?? []
  if ([...questions, ...highlights].some(item => !plainObject(item))) return null
  if (file.transcript !== undefined && !isText(file.transcript)) return null
  return {
    meta: plainObject(file.meta) ?? {},
    highlights,
    transcript: isText(file.transcript) ? file.transcript : undefined,
    id: file.id,
    name: file.name,
    folderId: isText(file.folderId) ? file.folderId : null,
    type: textOrEmpty(file.type),
    position: Number(file.position) || 0,
    description: textOrEmpty(file.description),
    tags: Array.isArray(file.tags) ? file.tags.filter(isText) : [],
    content: file.content,
    questions,
  }
}

export function cleanShare(share) {
  if (!share || typeof share !== 'object' || (share.kind !== 'file' && share.kind !== 'folder') || !isText(share.title)) return null
  if (!Array.isArray(share.files) || !share.files.length || (share.folders !== undefined && !Array.isArray(share.folders))) return null
  const folders = (share.folders ?? []).map(cleanFolder)
  const files = share.files.map(cleanFile)
  if (folders.includes(null) || files.includes(null)) return null
  return { kind: share.kind, title: share.title, folders, files }
}

function safeName(name) {
  return name.replace(/[\\/]/g, '-').replace(/^\.+/, '').trim() || 'sem nome'
}

function uniqueName(name, taken) {
  let candidate = safeName(name)
  for (let copy = 1; taken.has(candidate.toLowerCase()); copy++) candidate = `${safeName(name)}(${copy})`
  taken.add(candidate.toLowerCase())
  return candidate
}

export function shareTree(share, id, createdAt, expiresAt) {
  const root = `${SHARED_PREFIX}${id}/`
  const folderPaths = new Map()
  const taken = new Map()
  const namesIn = path => taken.get(path) ?? taken.set(path, new Set()).get(path)
  const pathOf = folder => {
    if (folderPaths.has(folder.id)) return folderPaths.get(folder.id)
    const parent = share.folders.find(item => item.id === folder.parentId)
    const base = parent ? pathOf(parent) : ''
    const path = `${base}${uniqueName(folder.name, namesIn(base))}/`
    folderPaths.set(folder.id, path)
    return path
  }
  const objects = []
  const folders = share.folders.map(folder => {
    const path = pathOf(folder)
    objects.push({ key: `${root}${path}${FOLDER_META_NAME}`, body: JSON.stringify(folder, null, 2), type: 'application/json' })
    return { id: folder.id, path }
  })
  const files = share.files.map(file => {
    const base = file.folderId ? (folderPaths.get(file.folderId) ?? '') : ''
    const path = `${base}${uniqueName(file.name, namesIn(base))}`
    const meta = { ...file.meta, id: file.id, name: file.name, folderId: file.folderId, type: file.type, position: file.position, description: file.description, tags: file.tags, mastery: null, lastReviewedAt: null, questionCount: file.questions.length }
    const sidecar = { meta, questions: file.questions, attempts: [], highlights: file.highlights, ...(file.transcript !== undefined ? { transcript: file.transcript } : {}) }
    objects.push({ key: `${root}${path}.md`, body: file.content, type: 'text/markdown' })
    objects.push({ key: `${root}${path}.json`, body: JSON.stringify(sidecar, null, 2), type: 'application/json' })
    return { id: file.id, path }
  })
  const manifest = { version: 2, id, kind: share.kind, title: share.title, createdAt, expiresAt, folders, files }
  objects.unshift({ key: `${root}${MANIFEST_NAME}`, body: JSON.stringify(manifest, null, 2), type: 'application/json' })
  return objects
}

async function removeShareObjects(bucket, id) {
  const prefix = `${SHARED_PREFIX}${id}/`
  let cursor
  do {
    const page = await bucket.list({ prefix, cursor })
    const keys = page.objects.map(object => object.key)
    if (keys.length) await bucket.delete(keys)
    cursor = page.truncated ? page.cursor : undefined
  } while (cursor)
}

async function createShare(request, env, headers) {
  if (!(request.headers.get('Content-Type') ?? '').toLowerCase().startsWith('application/json')) return json({ error: 'text_only' }, 415, headers)
  const input = await request.json().catch(() => null)
  if (!input) return json({ error: 'invalid_json' }, 400, headers)
  const accountKey = await identify(request, env)
  if (!accountKey) return json({ error: 'login_required' }, 401, headers)
  if (!(await turnstilePassed(input.turnstileToken, request, env))) return json({ error: 'turnstile_failed' }, 403, headers)
  const share = cleanShare(input.share)
  if (!share) return json({ error: 'text_only' }, 415, headers)
  const now = Date.now()
  const id = newShareId()
  const createdAt = new Date(now).toISOString()
  const expiresAt = new Date(now + SHARE_DAYS * DAY_MS).toISOString()
  const objects = shareTree(share, id, createdAt, expiresAt)
  const bytes = objects.reduce((sum, object) => sum + bytesOf(object.body), 0)
  const day = dayOf(now)
  const ipKey = await ipKeyOf(request)
  const counters = countersOf(day, accountKey, ipKey, await factorOf(env.BUCKET, accountKey))
  const reserved = await reserve(env.BUCKET, counters, bytes)
  if (!reserved.ok) return json({ error: `${reserved.failed}_limit`, remaining: reserved.remaining, bytes }, 429, headers)
  try {
    for (const object of objects) {
      await env.BUCKET.put(object.key, object.body, {
        httpMetadata: { contentType: `${object.type}; charset=utf-8`, cacheControl: SHARED_CACHE },
        customMetadata: object.key.endsWith(`/${MANIFEST_NAME}`) ? { owner: accountKey, ip: ipKey, day, bytes: String(bytes), expiresAt } : { expiresAt },
      })
    }
  } catch (error) {
    await removeShareObjects(env.BUCKET, id).catch(() => undefined)
    for (const counter of counters) await adjust(env.BUCKET, counter.key, -bytes, counter.limit)
    throw error
  }
  const quota = await quotaOf(env.BUCKET, counters)
  return json({ id, createdAt, expiresAt, bytes, remaining: quota.remaining }, 201, headers)
}

async function deleteShare(request, env, headers, id) {
  const accountKey = await identify(request, env)
  if (!accountKey) return json({ error: 'login_required' }, 401, headers)
  const object = await env.BUCKET.head(`${SHARED_PREFIX}${id}/${MANIFEST_NAME}`)
  if (!object) return json({ error: 'not_found' }, 404, headers)
  const meta = object.customMetadata ?? {}
  if (meta.owner !== accountKey) return json({ error: 'not_owner' }, 403, headers)
  await removeShareObjects(env.BUCKET, id)
  const day = dayOf(Date.now())
  const bytes = Number(meta.bytes) || 0
  const sameDay = meta.day === day
  if (sameDay && bytes) for (const counter of countersOf(day, meta.owner, meta.ip)) await adjust(env.BUCKET, counter.key, -bytes, counter.limit)
  const quota = await quotaOf(env.BUCKET, countersOf(day, accountKey, await ipKeyOf(request), await factorOf(env.BUCKET, accountKey)))
  return json({ returned: sameDay ? bytes : 0, remaining: quota.remaining }, 200, headers)
}

async function readQuota(request, env, headers) {
  const accountKey = await identify(request, env)
  if (!accountKey) return json({ error: 'login_required' }, 401, headers)
  const day = dayOf(Date.now())
  return json({ day, ...(await quotaOf(env.BUCKET, countersOf(day, accountKey, await ipKeyOf(request), await factorOf(env.BUCKET, accountKey)))) }, 200, headers)
}

async function serveShared(env, headers, id, path) {
  const object = await env.BUCKET.get(`${SHARED_PREFIX}${id}/${decodeURIComponent(path)}`)
  if (!object || Date.parse(object.customMetadata?.expiresAt ?? '') <= Date.now()) return json({ error: 'not_found' }, 404, headers)
  return new Response(object.body, { status: 200, headers: { ...headers, 'Content-Type': object.httpMetadata?.contentType ?? 'application/json; charset=utf-8', 'Cache-Control': SHARED_CACHE } })
}

export default {
  async fetch(request, env) {
    const origin = allowedOrigin(request.headers.get('Origin'), env)
    if (!origin) return new Response('Forbidden', { status: 403 })
    const headers = corsHeaders(origin)
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers })
    const path = new URL(request.url).pathname
    const shareMatch = path.match(SHARE_PATH)
    const fileMatch = path.match(SHARED_FILE_PATH)
    if (path === '/quota' && request.method === 'GET') return readQuota(request, env, headers)
    if (path === '/shares' && request.method === 'POST') return createShare(request, env, headers)
    if (shareMatch && request.method === 'DELETE') return deleteShare(request, env, headers, shareMatch[1])
    if (fileMatch && request.method === 'GET' && env.SERVE_SHARED === 'true') return serveShared(env, headers, fileMatch[1], fileMatch[2])
    return json({ error: 'not_found' }, 404, headers)
  },
}
