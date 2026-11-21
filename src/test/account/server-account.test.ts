import '@/test/account/storage-shim'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { mockEnv } = vi.hoisted(() => ({ mockEnv: { apiUrl: 'https://api.example.test', basePath: '/' } }))

vi.mock('@/lib/env', () => ({ env: mockEnv }))

import { page } from '@/controllers/google-redirect.controller'
import { loginOutcome, useServerAccount } from '@/stores/server-account'

const ME = {
  user: { id: 'u1', email: 'ana@exemplo.com', name: 'Ana', photoUrl: null, status: 'no-code', appEnabled: false, admin: false, deleteAt: null, hasPassword: true, hasGoogle: false },
  requireCode: true,
  device: { id: 'd1', name: 'Chrome no Linux' },
  space: { notes: 0, media: 0, reserved: 0, limit: 10737418240, warnAt: 0.9 },
}

type Route = (url: string, init: RequestInit) => { status: number; body?: unknown }

function serve(route: Route): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit = {}) => {
      const next = route(url, init)
      return new Response(next.body === undefined ? null : JSON.stringify(next.body), { status: next.status })
    }),
  )
}

beforeEach(() => {
  useServerAccount.setState({ me: null, status: 'unknown' })
  window.history.replaceState(null, '', '/')
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('server account (Usar a estrutura do app)', () => {
  it('knows who is signed in, or that nobody is', async () => {
    serve(() => ({ status: 200, body: ME }))
    await useServerAccount.getState().refresh()
    expect(useServerAccount.getState().status).toBe('signed-in')
    expect(useServerAccount.getState().me?.user.email).toBe('ana@exemplo.com')

    serve(() => ({ status: 401, body: { error: 'no_session' } }))
    await useServerAccount.getState().refresh()
    expect(useServerAccount.getState().status).toBe('signed-out')
    expect(useServerAccount.getState().me).toBeNull()
  })

  it('says the server is out of reach without losing who was signed in', async () => {
    useServerAccount.setState({ me: ME as never, status: 'signed-in' })
    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new TypeError('Failed to fetch'))))
    await useServerAccount.getState().refresh()
    expect(useServerAccount.getState().status).toBe('offline')
    expect(useServerAccount.getState().me?.user.id).toBe('u1')
  })

  it('signs in with Google in the same tab and comes back to where the person was', () => {
    const go = vi.spyOn(page, 'go').mockImplementation(() => undefined)
    window.history.replaceState(null, '', '/configuracoes?aba=outros')
    useServerAccount.getState().signInWithGoogle()
    expect(go).toHaveBeenCalledWith('https://api.example.test/v1/auth/google/start?return_to=%2Fconfiguracoes%3Faba%3Doutros')
  })

  it('reads the way back from Google and cleans the address', () => {
    window.history.replaceState(null, '', '/configuracoes?aba=outros&login=refused')
    expect(loginOutcome()).toBe('Você não autorizou no Google. Nada mudou.')
    expect(window.location.search).toBe('?aba=outros')
    window.history.replaceState(null, '', '/?login=expired')
    expect(loginOutcome()).toMatch(/demorou/)
    window.history.replaceState(null, '', '/')
    expect(loginOutcome()).toBeNull()
  })

  it('signs in with e-mail and password, then knows the account', async () => {
    const seen: string[] = []
    serve((url, init) => {
      seen.push(`${init.method ?? 'GET'} ${new URL(url).pathname}`)
      return url.endsWith('/login') ? { status: 200, body: { user: { id: 'u1' } } } : { status: 200, body: ME }
    })
    await useServerAccount.getState().signInWithPassword('ana@exemplo.com', 'senha-forte-1')
    expect(seen).toEqual(['POST /v1/auth/password/login', 'GET /v1/me'])
    expect(useServerAccount.getState().status).toBe('signed-in')
  })

  it('a good code frees the account and the structure comes on', async () => {
    const freed = { ...ME, user: { ...ME.user, status: 'enabled', appEnabled: true } }
    serve(url => (url.endsWith('/v1/code/use') ? { status: 200, body: { status: 'enabled' } } : { status: 200, body: freed }))
    useServerAccount.setState({ me: ME as never, status: 'signed-in' })
    const result = await useServerAccount.getState().redeemCode('abcd efgh jkmn')
    expect(result).toEqual({ status: 'enabled' })
    expect(useServerAccount.getState().me?.user.appEnabled).toBe(true)
  })

  it('a refused code keeps everything as it was and tells why', async () => {
    serve(() => ({ status: 404, body: { error: 'code_not_found' } }))
    useServerAccount.setState({ me: ME as never, status: 'signed-in' })
    await expect(useServerAccount.getState().redeemCode('errado')).rejects.toThrow('Código não encontrado. Confira as letras e tente de novo.')
    expect(useServerAccount.getState().me?.user.appEnabled).toBe(false)
  })

  it('signing out forgets the account', async () => {
    serve(() => ({ status: 200, body: { ok: true } }))
    useServerAccount.setState({ me: ME as never, status: 'signed-in' })
    await useServerAccount.getState().signOut()
    expect(useServerAccount.getState().me).toBeNull()
    expect(useServerAccount.getState().status).toBe('signed-out')
  })
})
