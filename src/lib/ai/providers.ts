import type { AiProviderId, AiSettings } from '@/types/domain'

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
  keylessIntervalMs?: number
  keyHelpUrl?: string
}

export const PROVIDERS: ProviderInfo[] = [
  { id: 'pollinations', name: 'Pollinations', tag: 'sem chave', format: 'openai', baseUrl: 'https://text.pollinations.ai/openai', keyedBaseUrl: 'https://gen.pollinations.ai/v1', needsKey: false, free: true, keylessModel: 'openai-fast', keylessIntervalMs: 15000, keyHelpUrl: 'https://auth.pollinations.ai' },
  { id: 'llm7', name: 'LLM7', tag: 'sem chave', format: 'openai', baseUrl: 'https://api.llm7.io/v1', needsKey: false, free: true, keylessModel: 'default', keyHelpUrl: 'https://token.llm7.io' },
  { id: 'anthropic', name: 'Anthropic', tag: 'chave paga', format: 'anthropic', baseUrl: 'https://api.anthropic.com', needsKey: true, free: false, keyHelpUrl: 'https://console.anthropic.com/settings/keys' },
  { id: 'openai', name: 'OpenAI', tag: 'chave paga', format: 'openai', baseUrl: 'https://api.openai.com/v1', needsKey: true, free: false, keyHelpUrl: 'https://platform.openai.com/api-keys' },
  { id: 'gemini', name: 'Google Gemini', tag: 'chave grátis', format: 'openai', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', needsKey: true, free: true, keyHelpUrl: 'https://aistudio.google.com/apikey' },
  { id: 'mistral', name: 'Mistral', tag: 'chave grátis', format: 'openai', baseUrl: 'https://api.mistral.ai/v1', needsKey: true, free: true, keyHelpUrl: 'https://console.mistral.ai/api-keys' },
  { id: 'groq', name: 'Groq', tag: 'chave grátis', format: 'openai', baseUrl: 'https://api.groq.com/openai/v1', needsKey: true, free: true, keyHelpUrl: 'https://console.groq.com/keys' },
  { id: 'openrouter', name: 'OpenRouter', tag: 'chave grátis', format: 'openai', baseUrl: 'https://openrouter.ai/api/v1', needsKey: true, free: true, keyHelpUrl: 'https://openrouter.ai/settings/keys' },
  { id: 'xai', name: 'xAI', tag: 'chave paga', format: 'openai', baseUrl: 'https://api.x.ai/v1', needsKey: true, free: false, keyHelpUrl: 'https://console.x.ai' },
  { id: 'ollama', name: 'Ollama', tag: 'no seu PC', format: 'openai', baseUrl: 'http://localhost:11434/v1', needsKey: false, free: true },
  { id: 'custom', name: 'Personalizado', tag: 'formato OpenAI', format: 'openai', baseUrl: '', needsKey: false, free: false },
]

export function providerOf(id: AiProviderId): ProviderInfo {
  return PROVIDERS.find(provider => provider.id === id) ?? PROVIDERS[PROVIDERS.length - 1]
}

export function baseUrlOf(settings: AiSettings): string {
  const provider = providerOf(settings.provider)
  if (settings.baseUrl.trim()) return settings.baseUrl.trim().replace(/\/+$/, '')
  if (settings.apiKey && provider.keyedBaseUrl) return provider.keyedBaseUrl
  return provider.baseUrl
}

export function modelOf(settings: AiSettings): string {
  return settings.model.trim() || (!settings.apiKey ? (providerOf(settings.provider).keylessModel ?? '') : '')
}

export function minIntervalOf(settings: AiSettings): number {
  const provider = providerOf(settings.provider)
  return !settings.apiKey ? (provider.keylessIntervalMs ?? 0) : 0
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
