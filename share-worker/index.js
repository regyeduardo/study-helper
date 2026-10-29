const LOCAL_ORIGIN = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/
const GOOGLE_API_BASE = 'https://www.googleapis.com'
const TURNSTILE_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify'
const SHARE_DAYS = 3
const MEDIA_DAYS = 3
const DAY_MS = 24 * 3600 * 1000
const CAS_ATTEMPTS = 10
const SHARED_PREFIX = 'shared/'
const MEDIA_PREFIX = 'shared-media/'
const SHARED_CACHE = 'public, max-age=60'
const MEDIA_CACHE = 'private, max-age=3600'
const MEDIA_TYPE = /^(audio|video)\//i
const SHARE_PATH = /^\/shares\/([A-Za-z0-9_-]{16,64})$/
const MEDIA_UPLOAD_PATH = /^\/shares\/([A-Za-z0-9_-]{16,64})\/media\/([A-Za-z0-9_-]{1,64})(?:\/(\d{1,5}|done))?$/
const MEDIA_PATH = /^\/media\/([A-Za-z0-9_-]{16,64})\/([A-Za-z0-9_-]{1,64})$/
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
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, Range',
    'Access-Control-Expose-Headers': 'Content-Range, Content-Length, Accept-Ranges',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  }
}

function json(body, status, headers) {
  return new Response(JSON.stringify(body), { status, headers: { ...headers, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } })
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
  if (file.recording !== undefined && !plainObject(file.recording)) return null
  return {
    meta: plainObject(file.meta) ?? {},
    highlights,
    transcript: isText(file.transcript) ? file.transcript : undefined,
    recording: file.recording,
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

export function shareTree(share, id, createdAt, expiresAt, mediaExpiresAt) {
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
    const sidecar = { meta, questions: file.questions, attempts: [], highlights: file.highlights, ...(file.transcript !== undefined ? { transcript: file.transcript } : {}), ...(file.recording !== undefined ? { recording: file.recording } : {}) }
    objects.push({ key: `${root}${path}.md`, body: file.content, type: 'text/markdown' })
    objects.push({ key: `${root}${path}.json`, body: JSON.stringify(sidecar, null, 2), type: 'application/json' })
    return { id: file.id, path }
  })
  const manifest = { version: 2, id, kind: share.kind, title: share.title, createdAt, expiresAt, mediaExpiresAt, folders, files }
  objects.unshift({ key: `${root}${MANIFEST_NAME}`, body: JSON.stringify(manifest, null, 2), type: 'application/json' })
  return objects
}

function manifestKey(id) {
  return `${SHARED_PREFIX}${id}/${MANIFEST_NAME}`
}

function mediaKey(id, fileId) {
  return `${MEDIA_PREFIX}${id}/${fileId}`
}

async function removePrefix(bucket, prefix) {
  let cursor
  do {
    const page = await bucket.list({ prefix, cursor })
    const keys = page.objects.map(object => object.key)
    if (keys.length) await bucket.delete(keys)
    cursor = page.truncated ? page.cursor : undefined
  } while (cursor)
}

async function removeShareObjects(bucket, id) {
  await removePrefix(bucket, `${SHARED_PREFIX}${id}/`)
  await removePrefix(bucket, `${MEDIA_PREFIX}${id}/`)
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
  const mediaExpiresAt = new Date(now + MEDIA_DAYS * DAY_MS).toISOString()
  const objects = shareTree(share, id, createdAt, expiresAt, mediaExpiresAt)
  const bytes = objects.reduce((sum, object) => sum + bytesOf(object.body), 0)
  try {
    for (const object of objects) {
      await env.BUCKET.put(object.key, object.body, {
        httpMetadata: { contentType: `${object.type}; charset=utf-8`, cacheControl: SHARED_CACHE },
        customMetadata: object.key.endsWith(`/${MANIFEST_NAME}`) ? { owner: accountKey, bytes: String(bytes), expiresAt } : { expiresAt },
      })
    }
  } catch (error) {
    await removeShareObjects(env.BUCKET, id).catch(() => undefined)
    throw error
  }
  return json({ id, createdAt, expiresAt, mediaExpiresAt, bytes }, 201, headers)
}

async function deleteShare(request, env, headers, id) {
  const accountKey = await identify(request, env)
  if (!accountKey) return json({ error: 'login_required' }, 401, headers)
  const object = await env.BUCKET.head(manifestKey(id))
  if (!object) return json({ error: 'not_found' }, 404, headers)
  if (object.customMetadata?.owner !== accountKey) return json({ error: 'not_owner' }, 403, headers)
  await removeShareObjects(env.BUCKET, id)
  return json({ deleted: true }, 200, headers)
}

async function ownedShare(request, env, headers, id, fileId) {
  const accountKey = await identify(request, env)
  if (!accountKey) return { refused: json({ error: 'login_required' }, 401, headers) }
  const object = await env.BUCKET.get(manifestKey(id))
  if (!object) return { refused: json({ error: 'not_found' }, 404, headers) }
  if (object.customMetadata?.owner !== accountKey) return { refused: json({ error: 'not_owner' }, 403, headers) }
  const manifest = await object.json().catch(() => null)
  if (!manifest?.files?.some(file => file.id === fileId)) return { refused: json({ error: 'not_found' }, 404, headers) }
  if (!(Date.parse(manifest.mediaExpiresAt ?? '') > Date.now())) return { refused: json({ error: 'media_expired' }, 410, headers) }
  return { manifest }
}

async function startMedia(request, env, headers, id, fileId) {
  const input = await request.json().catch(() => null)
  const mime = typeof input?.mime === 'string' ? input.mime.trim() : ''
  if (!MEDIA_TYPE.test(mime) || hasBinary(mime)) return json({ error: 'media_only' }, 415, headers)
  const { refused, manifest } = await ownedShare(request, env, headers, id, fileId)
  if (refused) return refused
  const upload = await env.BUCKET.createMultipartUpload(mediaKey(id, fileId), { httpMetadata: { contentType: mime }, customMetadata: { expiresAt: manifest.mediaExpiresAt } })
  return json({ uploadId: upload.uploadId }, 201, headers)
}

async function putMediaPart(request, env, headers, id, fileId, partNumber) {
  const uploadId = new URL(request.url).searchParams.get('uploadId')
  if (!uploadId || !request.body || partNumber < 1) return json({ error: 'invalid_part' }, 400, headers)
  const { refused } = await ownedShare(request, env, headers, id, fileId)
  if (refused) return refused
  const part = await env.BUCKET.resumeMultipartUpload(mediaKey(id, fileId), uploadId).uploadPart(partNumber, request.body)
  return json({ partNumber: part.partNumber, etag: part.etag }, 200, headers)
}

async function addMediaToManifest(bucket, id, fileId, media) {
  for (let attempt = 0; attempt < CAS_ATTEMPTS; attempt++) {
    const object = await bucket.get(manifestKey(id))
    if (!object) return false
    const manifest = await object.json()
    manifest.files = manifest.files.map(file => (file.id === fileId ? { ...file, media } : file))
    const written = await bucket.put(manifestKey(id), JSON.stringify(manifest, null, 2), { httpMetadata: object.httpMetadata, customMetadata: object.customMetadata, onlyIf: { etagMatches: object.etag } })
    if (written) return true
  }
  throw new Error('manifest_busy')
}

async function finishMedia(request, env, headers, id, fileId) {
  const input = await request.json().catch(() => null)
  const parts = Array.isArray(input?.parts) ? input.parts.filter(part => Number.isInteger(part?.partNumber) && typeof part?.etag === 'string') : []
  if (typeof input?.uploadId !== 'string' || !parts.length) return json({ error: 'invalid_part' }, 400, headers)
  const { refused } = await ownedShare(request, env, headers, id, fileId)
  if (refused) return refused
  const key = mediaKey(id, fileId)
  const object = await env.BUCKET.resumeMultipartUpload(key, input.uploadId).complete(parts.map(part => ({ partNumber: part.partNumber, etag: part.etag })))
  const media = { key, mime: object.httpMetadata?.contentType ?? '', size: object.size }
  if (!(await addMediaToManifest(env.BUCKET, id, fileId, media))) {
    await env.BUCKET.delete(key)
    return json({ error: 'not_found' }, 404, headers)
  }
  return json(media, 200, headers)
}

export function rangeOf(header, size) {
  const match = /^bytes=(\d*)-(\d*)$/.exec((header ?? '').trim())
  if (!match || (!match[1] && !match[2]) || (match[1] && match[2] && Number(match[2]) < Number(match[1]))) return null
  const suffix = !match[1]
  const start = suffix ? Math.max(0, size - Number(match[2])) : Number(match[1])
  const end = !suffix && match[2] ? Math.min(Number(match[2]), size - 1) : size - 1
  if (start >= size || (suffix && !Number(match[2]))) return 'unsatisfiable'
  return { start, end }
}

async function mediaExpiryOf(bucket, id, media) {
  if (media) return media.customMetadata?.expiresAt
  const object = await bucket.get(manifestKey(id))
  const manifest = object ? await object.json().catch(() => null) : null
  return manifest?.mediaExpiresAt
}

async function serveMedia(request, env, headers, id, fileId) {
  const key = mediaKey(id, fileId)
  const media = await env.BUCKET.head(key)
  const expiresAt = await mediaExpiryOf(env.BUCKET, id, media)
  if (expiresAt && Date.parse(expiresAt) <= Date.now()) {
    if (media) await env.BUCKET.delete(key).catch(() => undefined)
    return json({ error: 'media_expired' }, 410, headers)
  }
  if (!media) return json({ error: 'not_found' }, 404, headers)
  const size = media.size
  const range = rangeOf(request.headers.get('Range'), size)
  const common = { ...headers, 'Content-Type': media.httpMetadata?.contentType ?? 'application/octet-stream', 'Accept-Ranges': 'bytes', 'Cache-Control': MEDIA_CACHE }
  if (range === 'unsatisfiable') return new Response(null, { status: 416, headers: { ...common, 'Content-Range': `bytes */${size}` } })
  const object = await env.BUCKET.get(key, range ? { range: { offset: range.start, length: range.end - range.start + 1 } } : undefined)
  if (!object) return json({ error: 'not_found' }, 404, headers)
  if (!range) return new Response(object.body, { status: 200, headers: { ...common, 'Content-Length': String(size) } })
  return new Response(object.body, { status: 206, headers: { ...common, 'Content-Length': String(range.end - range.start + 1), 'Content-Range': `bytes ${range.start}-${range.end}/${size}` } })
}

async function serveShared(env, headers, id, path) {
  const object = await env.BUCKET.get(`${SHARED_PREFIX}${id}/${decodeURIComponent(path)}`)
  if (!object || Date.parse(object.customMetadata?.expiresAt ?? '') <= Date.now()) return json({ error: 'not_found' }, 404, headers)
  return new Response(object.body, { status: 200, headers: { ...headers, 'Content-Type': object.httpMetadata?.contentType ?? 'application/json; charset=utf-8', 'Cache-Control': SHARED_CACHE } })
}

export default {
  async fetch(request, env) {
    const path = new URL(request.url).pathname
    const asked = request.headers.get('Origin')
    const origin = allowedOrigin(asked, env)
    const mediaMatch = path.match(MEDIA_PATH)
    if (mediaMatch && request.method === 'GET' && (origin || !asked)) return serveMedia(request, env, origin ? corsHeaders(origin) : {}, mediaMatch[1], mediaMatch[2])
    if (!origin) return new Response('Forbidden', { status: 403 })
    const headers = corsHeaders(origin)
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers })
    const shareMatch = path.match(SHARE_PATH)
    const uploadMatch = path.match(MEDIA_UPLOAD_PATH)
    const fileMatch = path.match(SHARED_FILE_PATH)
    if (path === '/shares' && request.method === 'POST') return createShare(request, env, headers)
    if (shareMatch && request.method === 'DELETE') return deleteShare(request, env, headers, shareMatch[1])
    if (uploadMatch && !uploadMatch[3] && request.method === 'POST') return startMedia(request, env, headers, uploadMatch[1], uploadMatch[2])
    if (uploadMatch && uploadMatch[3] === 'done' && request.method === 'POST') return finishMedia(request, env, headers, uploadMatch[1], uploadMatch[2])
    if (uploadMatch && /^\d+$/.test(uploadMatch[3] ?? '') && request.method === 'PUT') return putMediaPart(request, env, headers, uploadMatch[1], uploadMatch[2], Number(uploadMatch[3]))
    if (fileMatch && request.method === 'GET' && env.SERVE_SHARED === 'true') return serveShared(env, headers, fileMatch[1], fileMatch[2])
    return json({ error: 'not_found' }, 404, headers)
  },
}
