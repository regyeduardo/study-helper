import type { AiConfig } from '@/types/domain'
import { create } from 'zustand'

import { env } from '@/lib/env'
import { PROVIDERS } from '@/lib/ai/providers'

/**
 * The app's AI (spec 006): with the structure on, the AI of every use is the one the administration chose for everyone, and every
 * call goes through our server, which puts the key of its env. The person never picks a model and the browser never has a key.
 * The person's own AI (providers, keys, models, defaults) stays kept as it was and is used again when the structure goes off (FR-007):
 * this config lives only here, in memory, and is never written to the person's settings.
 */

/** Stands for the server's key: the server drops it and puts the real one. */
export const APP_KEY = 'app'

interface AppAiState {
  /** The AI everyone with the structure uses; null without the structure (then the person's own). */
  config: AiConfig | null
  /** The providers with a key on the server. */
  providers: string[]
}

export const useAppAiStore = create<AppAiState>(() => ({ config: null, providers: [] }))

export function appAiConfig(): AiConfig | null {
  return useAppAiStore.getState().config
}

/** The administration's choice, ready to use: only providers with a key on the server, each with the server's key. */
export function toAppConfig(raw: unknown, providers: string[]): AiConfig {
  const chosen = (raw && typeof raw === 'object' ? raw : {}) as Partial<AiConfig>
  const kept = (chosen.providers ?? []).filter(provider => providers.includes(provider.type))
  const ids = new Set(kept.map(provider => provider.id))
  return {
    providers: kept.map(provider => ({ ...provider, key: APP_KEY, base: '' })),
    models: (chosen.models ?? []).filter(model => ids.has(model.pid)),
    defaults: chosen.defaults ?? {},
    steps: chosen.steps ?? {},
  }
}

/** What the server keeps of the administration's choice: never a key. */
export function fromAppConfig(config: AiConfig): AiConfig {
  return { ...config, providers: config.providers.map(provider => ({ ...provider, key: '', base: '' })) }
}

/** The address of each provider the app's AI can reach. */
const ORIGINS: [string, string][] = PROVIDERS.filter(provider => provider.baseUrl).map(provider => [provider.id, new URL(provider.baseUrl).origin])

/**
 * Every AI call goes through here. With the app's AI on, a call to a provider goes to our server instead
 * (`/v1/ai/<provider>/<the same path>`), without the browser's key and with the session; anything else goes as it is.
 */
export function aiFetch(input: string, init: RequestInit = {}): Promise<Response> {
  if (useAppAiStore.getState().config) {
    let url: URL | null = null
    try {
      url = new URL(input)
    } catch {
      url = null
    }
    const provider = url ? ORIGINS.find(([, origin]) => origin === url!.origin)?.[0] : undefined
    if (url && provider) {
      const headers = new Headers(init.headers)
      for (const name of ['authorization', 'x-api-key', 'x-goog-api-key']) headers.delete(name)
      headers.set('X-Estudo', '1')
      url.searchParams.delete('key')
      return fetch(`${env.apiUrl}/v1/ai/${provider}${url.pathname}${url.search}`, { ...init, headers, credentials: 'include', referrerPolicy: 'no-referrer' })
    }
  }
  return fetch(input, init)
}

let refresh: ReturnType<typeof setInterval> | null = null

/**
 * Follows the structure: on, the app's AI comes from the server and is asked again every minute (a change in the administration
 * reaches everyone in up to a minute, SC-003); off, it goes away and the person's own AI is used again, as it was.
 */
export function followAppAi(on: boolean): void {
  if (!on) {
    if (refresh) clearInterval(refresh)
    refresh = null
    if (useAppAiStore.getState().config) useAppAiStore.setState({ config: null, providers: [] })
    return
  }
  const read = async () => {
    const { appAi } = await import('@/controllers/api.controller')
    try {
      const answer = await appAi()
      useAppAiStore.setState({ config: toAppConfig(answer.uses, answer.providers), providers: answer.providers })
    } catch {
      // the server did not answer now: the last one known stays, and the next minute asks again
    }
  }
  if (!refresh) {
    refresh = setInterval(() => void read(), 60_000)
    void read()
  }
}

