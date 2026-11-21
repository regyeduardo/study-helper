import '@/test/account/storage-shim'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { mockEnv } = vi.hoisted(() => ({ mockEnv: { apiUrl: 'https://api.example.test' } }))

vi.mock('@/lib/env', () => ({ env: mockEnv }))

import {
  ApiError,
  apiMessage,
  getMe,
  googleSignInUrl,
  loginWithPassword,
  setStructure,
  signOutDevice,
  redeemCode,
} from '@/controllers/api.controller'

type Answer = { status: number; body?: unknown }

let calls: { url: string; init: RequestInit }[]

function answer(...answers: Answer[]): void {
  const queue = [...answers]
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, init })
      const next = queue.shift() ?? { status: 200, body: {} }
      return new Response(next.body === undefined ? null : JSON.stringify(next.body), { status: next.status, headers: { 'Content-Type': 'application/json' } })
    }),
  )
}

beforeEach(() => {
  calls = []
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('api controller (spec 003, entrega 3)', () => {
  it('reads with the session cookie and changes only with the app mark', async () => {
    answer({ status: 200, body: { user: { id: 'u1', status: 'no-code' }, requireCode: true } }, { status: 200, body: { appEnabled: true } })
    await getMe()
    await setStructure(true)
    expect(calls[0].url).toBe('https://api.example.test/v1/me')
    expect(calls[0].init.credentials).toBe('include')
    expect(new Headers(calls[0].init.headers).get('X-Estudo')).toBeNull()
    expect(calls[1].url).toBe('https://api.example.test/v1/structure')
    expect(calls[1].init.method).toBe('POST')
    expect(calls[1].init.credentials).toBe('include')
    expect(new Headers(calls[1].init.headers).get('X-Estudo')).toBe('1')
    expect(JSON.parse(String(calls[1].init.body))).toEqual({ on: true })
  })

  it('says nobody is signed in instead of failing', async () => {
    answer({ status: 401, body: { error: 'no_session' } })
    await expect(getMe()).resolves.toBeNull()
  })

  it('turns an error answer into an ApiError with its code and data', async () => {
    answer({ status: 410, body: { error: 'code_expired', expiredAt: '2026-11-01T12:00:00Z' } })
    const error = await redeemCode('abcd-efgh').catch(e => e)
    expect(error).toBeInstanceOf(ApiError)
    expect(error.status).toBe(410)
    expect(error.code).toBe('code_expired')
    expect(error.data.expiredAt).toBe('2026-11-01T12:00:00Z')
  })

  it('a network failure is an ApiError the person can read', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new TypeError('Failed to fetch'))))
    const error = await loginWithPassword('ana@exemplo.com', 'senha-forte-1').catch(e => e)
    expect(error).toBeInstanceOf(ApiError)
    expect(error.code).toBe('offline')
    expect(apiMessage(error)).toMatch(/internet|servidor/i)
  })

  it('writes the sentence of each code refusal the spec asks for', () => {
    expect(apiMessage(new ApiError(404, 'code_not_found'))).toBe('Código não encontrado. Confira as letras e tente de novo.')
    expect(apiMessage(new ApiError(410, 'code_expired', { expiredAt: '2026-11-01T12:00:00Z' }))).toBe('Este código venceu em 01/11/2026. Peça um novo a quem te enviou.')
    expect(apiMessage(new ApiError(409, 'code_used_up'))).toBe('Este código já foi usado por todas as pessoas que ele permite. Peça um novo a quem te enviou.')
    expect(apiMessage(new ApiError(410, 'code_canceled'))).toBe('Este código foi cancelado. Peça um novo a quem te enviou.')
    expect(apiMessage(new ApiError(429, 'too_many_attempts', { retryAfter: '2026-11-21T15:30:00Z' }))).toMatch(/Muitas tentativas/)
    expect(apiMessage(new ApiError(401, 'wrong_credentials'))).toBe('E-mail ou senha errados.')
    expect(apiMessage(new ApiError(500, 'algo_novo'))).toMatch(/Não deu certo/)
  })

  it('sends the sign-in with Google to the server, coming back to where the person was', () => {
    expect(googleSignInUrl('/biblioteca/abc?x=1')).toBe('https://api.example.test/v1/auth/google/start?return_to=%2Fbiblioteca%2Fabc%3Fx%3D1')
  })

  it('signs a device out by its id', async () => {
    answer({ status: 200, body: { ok: true } })
    await signOutDevice('dev 1')
    expect(calls[0].url).toBe('https://api.example.test/v1/devices/dev%201')
    expect(calls[0].init.method).toBe('DELETE')
  })
})
