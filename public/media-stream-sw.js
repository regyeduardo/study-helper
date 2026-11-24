// The app's service worker. It does two things. It streams a media kept in the Google Drive to the player: a <video src> cannot send the
// Authorization header the Drive needs, so the player asks for /media-stream/<Drive file id> on the app's own address and this worker
// asks the Drive for the same bytes (the Range the browser asked for) with the token. The token comes from the page on each request
// (src/lib/storage/media-stream.ts): it is never kept here nor put in an address.
// And it keeps the app's own files (the page and the pieces of the build), so the app opens without internet (spec 003, história 6):
// the page comes from the network when there is one, else from the copy; a piece of the build has its hash in the name and never
// changes, so it comes from the copy. Never the API (/v1/), the media, another address or anything but a read.

const STREAM = new URL('media-stream/', self.registration.scope).pathname
const SCOPE = new URL(self.registration.scope).pathname
const SHELL = 'estudo-app-v1'
// each version of the app brings pieces with new names: past this, the ones kept longest ago leave
const MAX_ASSETS = 300
// what is never kept: the API, the media, and what the dev server serves while the app is being written
const NEVER = /^(v1\/|media-stream\/|src\/|@|node_modules\/)/
// a Drive file id, nothing else: no way to reach another address of the Drive's API
const DRIVE_ID = /^[A-Za-z0-9_-]{1,200}$/
const RANGE = /^bytes=(\d*)-(\d*)$/
// the page may need a moment to renew the Google sign-in
const ASK_MS = 30000
const KEPT = ['Content-Type', 'Content-Length', 'Content-Range', 'ETag', 'Last-Modified']

self.addEventListener('install', () => void self.skipWaiting())
// the first time, the page that registered it is taken at once: it plays without reloading
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()))
// a page loaded without the worker (a hard reload) asks to be taken
self.addEventListener('message', event => {
  if (event.data && event.data.type === 'claim') event.waitUntil(self.clients.claim())
})

self.addEventListener('fetch', event => {
  const request = event.request
  const url = new URL(request.url)
  if (request.method !== 'GET' || url.origin !== self.location.origin || !url.pathname.startsWith(SCOPE)) return
  if (url.pathname.startsWith(STREAM)) return event.respondWith(stream(event, idOf(url.pathname.slice(STREAM.length))))
  const inside = url.pathname.slice(SCOPE.length)
  if (NEVER.test(inside)) return
  if (request.mode === 'navigate') return event.respondWith(fresh(request, SCOPE))
  if (inside.startsWith('assets/')) return event.respondWith(kept(request))
  return event.respondWith(fresh(request))
})

/** From the network, keeping a copy of a good answer (under `key`: every page of the app is the same page); without it, the copy. */
async function fresh(request, key) {
  try {
    const answer = await fetch(request)
    if (answer.ok) {
      const cache = await caches.open(SHELL)
      await cache.put(key || request, answer.clone())
      if (!key) await prune(cache)
    }
    return answer
  } catch (error) {
    const copy = await (await caches.open(SHELL)).match(key || request)
    if (copy) return copy
    throw error
  }
}

async function prune(cache) {
  const assets = (await cache.keys()).filter(kept => new URL(kept.url).pathname.startsWith(`${SCOPE}assets/`))
  for (const old of assets.slice(0, Math.max(0, assets.length - MAX_ASSETS))) await cache.delete(old)
}

/** A piece of the build: the copy, else the network (and then the copy). */
async function kept(request) {
  const copy = await (await caches.open(SHELL)).match(request)
  return copy || fresh(request)
}

function idOf(path) {
  try {
    const id = decodeURIComponent(path)
    return DRIVE_ID.test(id) ? id : null
  } catch {
    return null
  }
}

async function stream(event, id) {
  if (!id) return new Response(null, { status: 404 })
  const range = event.request.headers.get('Range')
  let grant = await ask(event.clientId, false)
  let upstream = grant && (await drive(grant, id, range))
  if (upstream && upstream.status === 401) {
    grant = await ask(event.clientId, true)
    upstream = grant && (await drive(grant, id, range))
  }
  if (!upstream) return new Response(null, { status: 503 })
  return relay(upstream, grant, id, range)
}

/** The token, asked of the page that plays (or any open page of the app) through a channel of its own. */
async function ask(clientId, force) {
  const page = (clientId && (await self.clients.get(clientId))) || (await self.clients.matchAll({ type: 'window' }))[0]
  if (!page) return null
  return new Promise(resolve => {
    const channel = new MessageChannel()
    const timer = setTimeout(() => {
      channel.port1.close()
      resolve(null)
    }, ASK_MS)
    channel.port1.onmessage = message => {
      clearTimeout(timer)
      channel.port1.close()
      const grant = message.data
      resolve(grant && grant.token && grant.base ? grant : null)
    }
    page.postMessage({ type: 'media-stream-token', force }, [channel.port2])
  })
}

function drive(grant, id, range) {
  const headers = { Authorization: `Bearer ${grant.token}` }
  if (range) headers.Range = range
  return fetch(`${grant.base}/drive/v3/files/${id}?alt=media`, { headers }).catch(() => null)
}

/** The Drive's answer as an answer of the app itself, with the headers the player needs to play and jump in parts. */
async function relay(upstream, grant, id, range) {
  const headers = new Headers({ 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store' })
  for (const name of KEPT) {
    const value = upstream.headers.get(name)
    if (value) headers.set(name, value)
  }
  if (upstream.status === 206 && !headers.has('Content-Range')) {
    // the Drive's CORS may hide Content-Range from the worker: it is made again from the file's size
    const span = await spanOf(grant, id, range, Number(headers.get('Content-Length')))
    if (span) headers.set('Content-Range', span)
  }
  return new Response(upstream.body, { status: upstream.status, statusText: upstream.statusText, headers })
}

async function spanOf(grant, id, range, length) {
  const asked = RANGE.exec(range || '')
  if (!asked || !length) return null
  const answer = await fetch(`${grant.base}/drive/v3/files/${id}?fields=size`, { headers: { Authorization: `Bearer ${grant.token}` } }).catch(() => null)
  const size = answer && answer.ok ? Number((await answer.json().catch(() => ({}))).size) : 0
  if (!size) return null
  const start = asked[1] === '' ? size - length : Number(asked[1])
  return `bytes ${start}-${start + length - 1}/${size}`
}
