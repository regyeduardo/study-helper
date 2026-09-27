import { vi } from 'vitest'

export const WORKER = 'https://auth.example.workers.dev'
export const API = 'https://api.example.test'
export const DRIVE = 'https://www.googleapis.com/auth/drive.file'

export interface Profile {
  sub: string
  name: string
  email: string
  picture: string
}

export interface GoogleFake {
  codeConfigs: Record<string, unknown>[]
  tokenConfigs: Record<string, unknown>[]
  tokenRequests: { prompt?: string; login_hint?: string }[]
  revoked: string[]
  nextCode: { code?: string; scope?: string; error?: string }
  tokenReplies: ({ access_token?: string; expires_in?: number; scope?: string; error?: string } | 'popup_closed')[]
}

export function installGoogle(): GoogleFake {
  const fake: GoogleFake = { codeConfigs: [], tokenConfigs: [], tokenRequests: [], revoked: [], nextCode: { code: 'auth-code', scope: `${DRIVE} openid` }, tokenReplies: [] }
  window.google = {
    accounts: {
      oauth2: {
        initCodeClient: config => {
          fake.codeConfigs.push(config as unknown as Record<string, unknown>)
          return { requestCode: () => queueMicrotask(() => config.callback(fake.nextCode)) }
        },
        initTokenClient: config => {
          fake.tokenConfigs.push(config as unknown as Record<string, unknown>)
          return {
            requestAccessToken: options => {
              fake.tokenRequests.push(options ?? {})
              const reply = fake.tokenReplies.shift() ?? { access_token: 'popup-token', expires_in: 3600, scope: DRIVE }
              queueMicrotask(() => (reply === 'popup_closed' ? config.error_callback?.({ type: 'popup_closed' }) : config.callback(reply)))
            },
          }
        },
        revoke: (token, done) => {
          fake.revoked.push(token)
          done?.()
        },
      },
    },
  }
  return fake
}

export interface WorkerFake {
  fetch: ReturnType<typeof vi.fn>
  calls: { url: string; body: Record<string, string> }[]
  tokenReply: Record<string, unknown>
  refreshReply: Record<string, unknown>
  profiles: Record<string, Profile>
}

export function installFetch(): WorkerFake {
  const fake: WorkerFake = {
    fetch: vi.fn(),
    calls: [],
    tokenReply: { access_token: 'access-1', expires_in: 3600, refresh_token: 'refresh-1', scope: `${DRIVE} openid email profile` },
    refreshReply: { access_token: 'access-renewed', expires_in: 3600 },
    profiles: {},
  }
  fake.fetch.mockImplementation(async (url: string, init?: RequestInit) => {
    const body = init?.body ? (JSON.parse(init.body as string) as Record<string, string>) : {}
    fake.calls.push({ url, body })
    if (url === `${WORKER}/token`) return new Response(JSON.stringify(fake.tokenReply))
    if (url === `${WORKER}/refresh`) return new Response(JSON.stringify(fake.refreshReply), { status: fake.refreshReply.error ? 400 : 200 })
    if (url === `${API}/oauth2/v3/userinfo`) {
      const token = (init?.headers as Record<string, string>).Authorization.replace('Bearer ', '')
      const profile = fake.profiles[token]
      return profile ? new Response(JSON.stringify(profile)) : new Response('{}', { status: 401 })
    }
    return new Response('not found', { status: 404 })
  })
  vi.stubGlobal('fetch', fake.fetch)
  return fake
}
