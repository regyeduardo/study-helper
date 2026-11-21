import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import worker from './index.js'

const ORIGIN = 'https://study.ryns.me'
const ENV = { GOOGLE_CLIENT_ID: 'client-id', GOOGLE_CLIENT_SECRET: 'secret', ALLOWED_ORIGINS: `${ORIGIN},https://regyeduardo.github.io` }

let sent

beforeEach(() => {
  sent = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url, init) => {
      sent.push(Object.fromEntries(new URLSearchParams(init.body)))
      return new Response(JSON.stringify({ access_token: 'access', expires_in: 3600, refresh_token: 'refresh', scope: 'drive.appdata' }))
    }),
  )
})

afterEach(() => vi.unstubAllGlobals())

function call(path, body, origin = ORIGIN) {
  const headers = { 'Content-Type': 'application/json', ...(origin ? { Origin: origin } : {}) }
  return worker.fetch(new Request(`https://auth.example.workers.dev${path}`, { method: 'POST', headers, body: JSON.stringify(body) }), ENV)
}

describe('token', () => {
  it('trades the code of the Google window with postmessage', async () => {
    const response = await call('/token', { code: 'c1' })
    expect(response.status).toBe(200)
    expect(sent[0]).toMatchObject({ grant_type: 'authorization_code', code: 'c1', redirect_uri: 'postmessage', client_id: 'client-id' })
  })

  it('trades the code of a sign-in made in the same tab with the address Google sent the person back to', async () => {
    const response = await call('/token', { code: 'c2', redirect_uri: `${ORIGIN}/` })
    expect(response.status).toBe(200)
    expect((await response.json()).refresh_token).toBe('refresh')
    expect(sent[0]).toMatchObject({ code: 'c2', redirect_uri: `${ORIGIN}/` })
  })

  it('accepts a page of the app under a base path', async () => {
    const response = await call('/token', { code: 'c3', redirect_uri: `${ORIGIN}/estudo/` }, ORIGIN)
    expect(response.status).toBe(200)
  })

  it('refuses an address of another site, even if it only starts like the origin', async () => {
    for (const redirect_uri of ['https://evil.example/', `${ORIGIN}.evil.example/`, 'javascript:alert(1)']) {
      const response = await call('/token', { code: 'c4', redirect_uri })
      expect(response.status).toBe(400)
      expect((await response.json()).error).toBe('invalid_redirect_uri')
    }
    expect(sent).toHaveLength(0)
  })

  it('refuses a request from an origin that is not listed', async () => {
    expect((await call('/token', { code: 'c5' }, 'https://evil.example')).status).toBe(403)
    expect((await call('/token', { code: 'c5' }, null)).status).toBe(403)
  })

  it('lets the local dev server ask for its own address', async () => {
    const response = await call('/token', { code: 'c6', redirect_uri: 'http://localhost:5191/' }, 'http://localhost:5191')
    expect(response.status).toBe(200)
    expect(sent[0].redirect_uri).toBe('http://localhost:5191/')
  })
})
