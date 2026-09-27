const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token'
const LOCAL_ORIGIN = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/

function allowedOrigin(origin, env) {
  if (!origin) return null
  const listed = (env.ALLOWED_ORIGINS ?? '').split(',').map(item => item.trim()).filter(Boolean)
  return listed.includes(origin) || LOCAL_ORIGIN.test(origin) ? origin : null
}

function corsHeaders(origin) {
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  }
}

function json(body, status, headers) {
  return new Response(JSON.stringify(body), { status, headers: { ...headers, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } })
}

async function exchange(env, params) {
  const response = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET, ...params }),
  })
  const body = await response.json().catch(() => ({ error: 'invalid_response' }))
  if (!response.ok) return { status: response.status, body: { error: body.error ?? 'token_error', error_description: body.error_description ?? '' } }
  return {
    status: 200,
    body: { access_token: body.access_token, expires_in: body.expires_in, refresh_token: body.refresh_token, scope: body.scope },
  }
}

export default {
  async fetch(request, env) {
    const origin = allowedOrigin(request.headers.get('Origin'), env)
    if (!origin) return new Response('Forbidden', { status: 403 })
    const headers = corsHeaders(origin)
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers })
    if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405, headers)
    const path = new URL(request.url).pathname
    const input = await request.json().catch(() => null)
    if (path === '/token' && typeof input?.code === 'string') {
      const result = await exchange(env, { grant_type: 'authorization_code', code: input.code, redirect_uri: 'postmessage' })
      return json(result.body, result.status, headers)
    }
    if (path === '/refresh' && typeof input?.refresh_token === 'string') {
      const result = await exchange(env, { grant_type: 'refresh_token', refresh_token: input.refresh_token })
      return json(result.body, result.status, headers)
    }
    return json({ error: 'not_found' }, 404, headers)
  },
}
