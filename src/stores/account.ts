import { create } from 'zustand'

import {
  getGoogleProfileController,
  type GoogleToken,
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
  active(): Account
  addGoogleAccount(): Promise<Account>
  switchTo(id: string): void
  forgetAccount(id: string): Promise<void>
  tokenFor(id: string): Promise<string>
  reauthorize(id: string): Promise<void>
}

const renewals = new Map<string, Promise<GoogleToken>>()

export const useAccountStore = create<AccountState>((set, get) => {
  const accounts = readSaved()
  return {
    accounts,
    activeId: readActive(accounts),

    active: () => get().accounts.find(account => account.id === get().activeId) ?? LOCAL_ACCOUNT,

    addGoogleAccount: async () => {
      const token = await requestGoogleTokenController({ prompt: 'select_account' })
      const profile = await getGoogleProfileController(token.accessToken)
      const account: Account = { id: profile.sub, kind: 'google', name: profile.name, email: profile.email, picture: profile.picture, token }
      const others = get().accounts.filter(item => item.id !== account.id)
      const next = [...others, account]
      set({ accounts: next, activeId: account.id })
      persist(next, account.id)
      return account
    },

    switchTo: id => {
      set({ activeId: id })
      persist(get().accounts, id)
    },

    forgetAccount: async id => {
      const account = get().accounts.find(item => item.id === id)
      if (!account || account.kind === 'local') return
      if (account.token) await revokeGoogleTokenController(account.token.accessToken)
      const next = get().accounts.filter(item => item.id !== id)
      const activeId = get().activeId === id ? LOCAL_ACCOUNT_ID : get().activeId
      set({ accounts: next, activeId })
      persist(next, activeId)
    },

    tokenFor: async id => {
      const account = get().accounts.find(item => item.id === id)
      if (!account || account.kind !== 'google') throw new Error('Conta sem login do Google.')
      if (account.token && account.token.expiresAt - RENEW_MARGIN_MS > Date.now()) return account.token.accessToken
      if (!renewals.has(id)) {
        const renewal = requestGoogleTokenController({ prompt: '', loginHint: account.email }).catch(() =>
          requestGoogleTokenController({ prompt: 'select_account', loginHint: account.email }),
        )
        renewals.set(id, renewal)
        renewal.finally(() => renewals.delete(id)).catch(() => undefined)
      }
      const token = await renewals.get(id)!
      const next = get().accounts.map(item => (item.id === id ? { ...item, token } : item))
      set({ accounts: next })
      persist(next, get().activeId)
      return token.accessToken
    },

    reauthorize: async id => {
      const account = get().accounts.find(item => item.id === id)
      if (!account || account.kind !== 'google') return
      const token = await requestGoogleTokenController({ prompt: 'consent', loginHint: account.email })
      const next = get().accounts.map(item => (item.id === id ? { ...item, token } : item))
      set({ accounts: next })
      persist(next, get().activeId)
    },
  }
})
