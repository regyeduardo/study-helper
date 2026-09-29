import type { AiProviderId, AiSettings } from '@/types/domain'
import { env } from '@/lib/env'

export type ProviderFormat = 'anthropic' | 'openai'

export interface ProviderInfo {
  id: AiProviderId
  name: string
  tag: string
  format: ProviderFormat
  baseUrl: string
  keyedBaseUrl?: string
  needsKey: boolean
  free: boolean
  keylessModel?: string
  keylessOneAtATime?: boolean
  keylessIntervalMs?: number
  models?: string[]
  keyHelpUrl?: string
}

export const PROVIDERS: ProviderInfo[] = [
  { id: 'free', name: 'Grátis (Ling)', tag: 'com login Google', format: 'openai', baseUrl: '', needsKey: false, free: true, models: ['inclusionAI/Ling-3.0-flash'] },
  { id: 'ovh', name: 'OVHcloud', tag: 'sem chave', format: 'openai', baseUrl: 'https://oai.endpoints.kepler.ai.cloud.ovh.net/v1', needsKey: false, free: true, keylessModel: 'Meta-Llama-3_3-70B-Instruct', keylessOneAtATime: true, keylessIntervalMs: 31000, models: ['Meta-Llama-3_3-70B-Instruct'] },
  { id: 'gemini', name: 'Google Gemini', tag: 'chave grátis', format: 'openai', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', needsKey: true, free: true, models: ['gemini-3.5-flash-lite'], keyHelpUrl: 'https://aistudio.google.com/apikey' },
  { id: 'pollinations', name: 'Pollinations', tag: 'chave grátis', format: 'openai', baseUrl: 'https://gen.pollinations.ai/v1', needsKey: true, free: true, models: ['openai'], keyHelpUrl: 'https://enter.pollinations.ai' },
  { id: 'llm7', name: 'LLM7', tag: 'chave grátis', format: 'openai', baseUrl: 'https://api.llm7.io/v1', needsKey: true, free: true, models: ['default'], keyHelpUrl: 'https://token.llm7.io' },
  { id: 'anthropic', name: 'Anthropic', tag: 'chave paga', format: 'anthropic', baseUrl: 'https://api.anthropic.com', needsKey: true, free: false, keyHelpUrl: 'https://console.anthropic.com/settings/keys' },
  { id: 'openai', name: 'OpenAI', tag: 'chave paga', format: 'openai', baseUrl: 'https://api.openai.com/v1', needsKey: true, free: false, keyHelpUrl: 'https://platform.openai.com/api-keys' },
  { id: 'xai', name: 'xAI', tag: 'chave paga', format: 'openai', baseUrl: 'https://api.x.ai/v1', needsKey: true, free: false, keyHelpUrl: 'https://console.x.ai' },
  { id: 'custom', name: 'Personalizado', tag: 'formato OpenAI', format: 'openai', baseUrl: '', needsKey: false, free: false },
]

export function providerOf(id: AiProviderId): ProviderInfo {
  return PROVIDERS.find(provider => provider.id === id) ?? PROVIDERS[PROVIDERS.length - 1]
}

export function baseUrlOf(settings: AiSettings): string {
  const provider = providerOf(settings.provider)
  if (provider.id === 'free') return env.transcriptionWorkerUrl
  if (settings.baseUrl.trim()) return settings.baseUrl.trim().replace(/\/+$/, '')
  if (settings.apiKey && provider.keyedBaseUrl) return provider.keyedBaseUrl
  return provider.baseUrl
}

export function modelOf(settings: AiSettings): string {
  const provider = providerOf(settings.provider)
  return settings.model.trim() || (!settings.apiKey ? provider.keylessModel : undefined) || provider.models?.[0] || ''
}

export function oneAtATimeOf(settings: AiSettings): boolean {
  return !settings.apiKey && Boolean(providerOf(settings.provider).keylessOneAtATime)
}

export function intervalOf(settings: AiSettings): number {
  return oneAtATimeOf(settings) ? (providerOf(settings.provider).keylessIntervalMs ?? 0) : 0
}

export function isKnownProvider(id: string): id is AiProviderId {
  return PROVIDERS.some(provider => provider.id === id)
}

export function isFreeChoice(settings: AiSettings): boolean {
  return providerOf(settings.provider).free || settings.model.endsWith(':free')
}

export function missingSetup(settings: AiSettings): string | null {
  const provider = providerOf(settings.provider)
  if (!baseUrlOf(settings)) return 'Informe a URL base da IA nas Configurações.'
  if (provider.needsKey && !settings.apiKey.trim()) return `Falta a chave de ${provider.name} nas Configurações.`
  if (!modelOf(settings)) return 'Escolha o modelo da IA nas Configurações.'
  return null
}
