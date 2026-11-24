import { create } from 'zustand'

import {
  ApiError,
  apiMessage,
  getMe,
  googleSignInUrl,
  loginWithGoogleToken,
  loginWithPassword,
  logout,
  registerWithPassword,
  type ServerMe,
  setStructure,
  redeemCode as redeemCodeController,
} from '@/controllers/api.controller'
import { page } from '@/controllers/google-redirect.controller'

/**
 * The account of the Estudo backend (spec 003, "Usar a estrutura do app"): who is signed in on the server, by Google or by e-mail and
 * password. It lives apart from the Google accounts of the Drive (`stores/account.ts`), which keep working as they do.
 */
export type ServerAccountStatus = 'unknown' | 'signed-out' | 'signed-in' | 'offline'

interface ServerAccountState {
  me: ServerMe | null
  status: ServerAccountStatus
  /**
   * The last session the server gave in this browser, while it does not answer (história 6): the library opens without internet with
   * what it had. Only the library reads it; `me` stays empty until the server answers.
   */
  remembered: ServerMe | null
  refresh(): Promise<void>
  /** Leaves for Google in this same tab; the server brings the person back to this page. */
  signInWithGoogle(): void
  /** Signs in with the Google token the app already has (the Drive account); false when Google or the server refuse it. */
  signInWithGoogleToken(accessToken: string): Promise<boolean>
  signInWithPassword(email: string, password: string): Promise<void>
  register(email: string, password: string, name: string): Promise<void>
  signOut(): Promise<void>
  /** Frees the account with a promo code; a refusal throws the sentence the person reads. */
  redeemCode(code: string): Promise<{ status: 'enabled'; alreadyEnabled?: boolean }>
  setStructure(on: boolean): Promise<void>
}

const OUTCOMES: Record<string, string> = {
  refused: 'Você não autorizou no Google. Nada mudou.',
  expired: 'O login demorou demais. Tente de novo.',
  failed: 'O Google não respondeu agora. Tente de novo em instantes.',
}

/** On the way back from the server's sign-in with Google: the sentence for a failed one (null when it went well or this is no return), taking `login` out of the address. */
export function loginOutcome(): string | null {
  const url = new URL(window.location.href)
  const outcome = url.searchParams.get('login')
  if (outcome === null) return null
  url.searchParams.delete('login')
  window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}${url.hash}`)
  return OUTCOMES[outcome] ?? OUTCOMES.failed
}

const REMEMBERED = 'study-helper-ultima-sessao'

function remember(me: ServerMe | null): void {
  try {
    if (me) localStorage.setItem(REMEMBERED, JSON.stringify(me))
    else localStorage.removeItem(REMEMBERED)
  } catch {
    // a browser that keeps nothing only does not open without internet
  }
}

function rememberedSession(): ServerMe | null {
  try {
    const kept = localStorage.getItem(REMEMBERED)
    return kept ? (JSON.parse(kept) as ServerMe) : null
  } catch {
    return null
  }
}

/** Runs a call and throws the sentence the person reads. */
async function readable<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run()
  } catch (error) {
    throw new Error(apiMessage(error), { cause: error })
  }
}

export const useServerAccount = create<ServerAccountState>((set, get) => ({
  me: null,
  status: 'unknown',
  remembered: null,

  refresh: async () => {
    try {
      const me = await getMe()
      remember(me)
      set({ me, status: me ? 'signed-in' : 'signed-out', remembered: null })
    } catch (error) {
      if (error instanceof ApiError && error.code === 'offline') set({ status: 'offline', remembered: rememberedSession() })
      else throw error
    }
  },

  signInWithGoogle: () => {
    page.go(googleSignInUrl(`${window.location.pathname}${window.location.search}${window.location.hash}`))
  },

  signInWithGoogleToken: async accessToken => {
    try {
      await loginWithGoogleToken(accessToken)
      await get().refresh()
      return get().status === 'signed-in'
    } catch {
      return false
    }
  },

  signInWithPassword: async (email, password) => {
    await readable(() => loginWithPassword(email, password))
    await get().refresh()
  },

  register: async (email, password, name) => {
    await readable(() => registerWithPassword(email, password, name))
    await get().refresh()
  },

  signOut: async () => {
    await readable(() => logout())
    remember(null)
    set({ me: null, status: 'signed-out', remembered: null })
  },

  redeemCode: async code => {
    const result = await readable(() => redeemCodeController(code))
    await get().refresh()
    return result
  },

  setStructure: async on => {
    await readable(() => setStructure(on))
    await get().refresh()
  },
}))
