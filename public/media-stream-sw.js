// The app's service worker. It does one thing: stream a media kept in the Google Drive to the player. A <video src> cannot send the
// Authorization header the Drive needs, so the player asks for /media-stream/<Drive file id> on the app's own address and this worker
// asks the Drive for the same bytes (the Range the browser asked for) with the token. The token comes from the page on each request
// (src/lib/storage/media-stream.ts): it is never kept here nor put in an address. Every other request goes to the network untouched.

const STREAM = new URL('media-stream/', self.registration.scope).pathname
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
  if (request.method !== 'GET' || url.origin !== self.location.origin || !url.pathname.startsWith(STREAM)) return
  event.respondWith(stream(event, idOf(url.pathname.slice(STREAM.length))))
})

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
