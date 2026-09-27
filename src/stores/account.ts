import { create } from 'zustand'

import {
  getGoogleProfileController,
  GoogleReconnectError,
  type GoogleToken,
  isDurableLoginConfigured,
  refreshGoogleTokenController,
  requestGoogleCodeController,
  requestGoogleTokenController,
  revokeGoogleTokenController,
} from '@/controllers/google-auth.controller'
import { LOCAL_ACCOUNT_ID } from '@/lib/storage/local-repository'

const ACCOUNTS_KEY = 'study-helper:accounts'
const ACTIVE_KEY = 'study-helper:active-account'
const RENEW_MARGIN_MS = 60_000

export interface Account {
  id: string
  kind: 'local' | 'google'
  name: string
  email: string
  picture: string
  token?: GoogleToken
}

export const LOCAL_ACCOUNT: Account = { id: LOCAL_ACCOUNT_ID, kind: 'local', name: 'Local', email: 'só neste navegador', picture: '' }

function readSaved(): Account[] {
  try {
    const saved = JSON.parse(localStorage.getItem(ACCOUNTS_KEY) ?? '[]') as Account[]
    return [LOCAL_ACCOUNT, ...saved.filter(account => account.kind === 'google')]
  } catch {
    return [LOCAL_ACCOUNT]
  }
}

function persist(accounts: Account[], activeId: string): void {
  try {
    localStorage.setItem(ACCOUNTS_KEY, JSON.stringify(accounts.filter(account => account.kind === 'google')))
    localStorage.setItem(ACTIVE_KEY, activeId)
  } catch {
    return
  }
}

function readActive(accounts: Account[]): string {
  try {
    const saved = localStorage.getItem(ACTIVE_KEY)
    if (saved && accounts.some(account => account.id === saved)) return saved
  } catch {
    return LOCAL_ACCOUNT_ID
  }
  return LOCAL_ACCOUNT_ID
}

export function initialsOf(account: Account): string {
  if (account.kind === 'local') return 'L'
  const words = account.name.split(/\s+/).filter(Boolean)
  return ((words[0]?.[0] ?? '') + (words[1]?.[0] ?? '')).toUpperCase() || account.email[0]?.toUpperCase() || '?'
}

interface AccountState {
  accounts: Account[]
  activeId: string
  reconnectId: string | null
  reconnectMessage: string
  active(): Account
  addGoogleAccount(): Promise<Account>
  switchTo(id: string): void
  forgetAccount(id: string): Promise<void>
  tokenFor(id: string, options?: { force?: boolean }): Promise<string>
  reauthorize(id: string): Promise<void>
}

const RECONNECT_MESSAGE = 'O Google pediu pra você entrar de novo.'
const CONFIRM_OFFLINE_MESSAGE = 'Falta um toque: o Google precisa confirmar o acesso contínuo ao Drive.'

const renewals = new Map<string, Promise<GoogleToken>>()

export const useAccountStore = create<AccountState>((set, get) => {
  const accounts = readSaved()

  const saveToken = (id: string, token: GoogleToken) => {
    const next = get().accounts.map(item => (item.id === id ? { ...item, token } : item))
    set({ accounts: next })
    persist(next, get().activeId)
  }

  const askReconnect = (id: string, message: string): never => {
    set({ reconnectId: id, reconnectMessage: message })
    throw new GoogleReconnectError(message)
  }

  const keepRefreshToken = (token: GoogleToken, previous?: GoogleToken): GoogleToken => ({
    ...token,
    refreshToken: token.refreshToken ?? previous?.refreshToken,
  })

  const renew = async (account: Account): Promise<GoogleToken> => {
    if (!isDurableLoginConfigured()) {
      return requestGoogleTokenController({ prompt: '', loginHint: account.email }).catch(() =>
        requestGoogleTokenController({ prompt: 'select_account', loginHint: account.email }),
      )
    }
    const refreshToken = account.token?.refreshToken
    if (!refreshToken) return askReconnect(account.id, RECONNECT_MESSAGE)
    try {
      return await refreshGoogleTokenController(refreshToken)
    } catch (error) {
      if (!(error instanceof GoogleReconnectError)) throw error
      if (account.token) saveToken(account.id, { ...account.token, refreshToken: undefined })
      return askReconnect(account.id, RECONNECT_MESSAGE)
    }
  }

  return {
    accounts,
    activeId: readActive(accounts),
    reconnectId: null,
    reconnectMessage: '',

    active: () => get().accounts.find(account => account.id === get().activeId) ?? LOCAL_ACCOUNT,

    addGoogleAccount: async () => {
      const durable = isDurableLoginConfigured()
      const granted = durable ? await requestGoogleCodeController({ selectAccount: true }) : await requestGoogleTokenController({ prompt: 'select_account' })
      const profile = await getGoogleProfileController(granted.accessToken)
      const previous = get().accounts.find(item => item.id === profile.sub)
      const token = keepRefreshToken(granted, previous?.token)
      const account: Account = { id: profile.sub, kind: 'google', name: profile.name, email: profile.email, picture: profile.picture, token }
      const others = get().accounts.filter(item => item.id !== account.id)
      const next = [...others, account]
      const missingOffline = durable && !token.refreshToken
      set({ accounts: next, activeId: account.id, ...(missingOffline ? { reconnectId: account.id, reconnectMessage: CONFIRM_OFFLINE_MESSAGE } : {}) })
      persist(next, account.id)
      if (missingOffline) await revokeGoogleTokenController(granted.accessToken)
      return account
    },

    switchTo: id => {
      set({ activeId: id })
      persist(get().accounts, id)
    },

    forgetAccount: async id => {
      const account = get().accounts.find(item => item.id === id)
      if (!account || account.kind === 'local') return
      if (account.token) await revokeGoogleTokenController(account.token.refreshToken ?? account.token.accessToken)
      const next = get().accounts.filter(item => item.id !== id)
      const activeId = get().activeId === id ? LOCAL_ACCOUNT_ID : get().activeId
      set({ accounts: next, activeId, ...(get().reconnectId === id ? { reconnectId: null } : {}) })
      persist(next, activeId)
    },

    tokenFor: async (id, options = {}) => {
      const account = get().accounts.find(item => item.id === id)
      if (!account || account.kind !== 'google') throw new Error('Conta sem login do Google.')
      if (get().reconnectId === id) throw new GoogleReconnectError(get().reconnectMessage || RECONNECT_MESSAGE)
      if (!options.force && account.token && account.token.expiresAt - RENEW_MARGIN_MS > Date.now()) return account.token.accessToken
      if (!renewals.has(id)) {
        const renewal = renew(account)
        renewals.set(id, renewal)
        renewal.finally(() => renewals.delete(id)).catch(() => undefined)
      }
      const token = keepRefreshToken(await renewals.get(id)!, account.token)
      saveToken(id, token)
      return token.accessToken
    },

    reauthorize: async id => {
      const account = get().accounts.find(item => item.id === id)
      if (!account || account.kind !== 'google') return
      if (!isDurableLoginConfigured()) {
        saveToken(id, await requestGoogleTokenController({ prompt: 'consent', loginHint: account.email }))
        set({ reconnectId: null })
        return
      }
      const token = keepRefreshToken(await requestGoogleCodeController({ selectAccount: false, loginHint: account.email }), account.token)
      saveToken(id, token)
      if (!token.refreshToken) {
        await revokeGoogleTokenController(token.accessToken)
        askReconnect(id, CONFIRM_OFFLINE_MESSAGE)
      }
      set({ reconnectId: null, reconnectMessage: '' })
    },
  }
})
