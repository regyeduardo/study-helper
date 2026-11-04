import type { AiProviderId, AiSettings } from '@/types/domain'

export type ProviderFormat = 'anthropic' | 'openai'

export const PROVIDER_LEFT = 'O provedor de IA que você usava saiu do app. Escolha outro em Configurações › Inteligência artificial.'
export const NO_MODEL = 'Escolha um modelo em Configurações › Inteligência artificial › Padrões por uso, ou na hora de gerar.'

export interface ProviderInfo {
  id: AiProviderId
  name: string
  format: ProviderFormat
  /** Where the chat calls go; empty for Personalizado (the user types it). */
  baseUrl: string
  needsKey: boolean
}

/** The provider types of Configurações › Inteligência artificial › Provedores, in the order of the chips. */
export const PROVIDERS: ProviderInfo[] = [
  { id: 'deepinfra', name: 'DeepInfra', format: 'openai', baseUrl: 'https://api.deepinfra.com/v1/openai', needsKey: false },
  { id: 'openrouter', name: 'OpenRouter', format: 'openai', baseUrl: 'https://openrouter.ai/api/v1', needsKey: false },
  { id: 'vercel', name: 'Vercel AI Gateway', format: 'openai', baseUrl: 'https://ai-gateway.vercel.sh/v1', needsKey: false },
  { id: 'deepseek', name: 'DeepSeek', format: 'openai', baseUrl: 'https://api.deepseek.com', needsKey: true },
  { id: 'xai', name: 'xAI', format: 'openai', baseUrl: 'https://api.x.ai/v1', needsKey: true },
  { id: 'anthropic', name: 'Anthropic', format: 'anthropic', baseUrl: 'https://api.anthropic.com', needsKey: true },
  { id: 'mistral', name: 'Mistral', format: 'openai', baseUrl: 'https://api.mistral.ai/v1', needsKey: true },
  { id: 'openai', name: 'OpenAI', format: 'openai', baseUrl: 'https://api.openai.com/v1', needsKey: true },
  { id: 'gemini', name: 'Google Gemini', format: 'openai', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', needsKey: true },
  { id: 'groq', name: 'Groq', format: 'openai', baseUrl: 'https://api.groq.com/openai/v1', needsKey: true },
  { id: 'together', name: 'Together', format: 'openai', baseUrl: 'https://api.together.xyz/v1', needsKey: true },
  { id: 'custom', name: 'Personalizado', format: 'openai', baseUrl: '', needsKey: false },
]

export function providerOf(id: AiProviderId): ProviderInfo {
  return PROVIDERS.find(provider => provider.id === id) ?? PROVIDERS[PROVIDERS.length - 1]
}

export function isKnownProvider(id: string): id is AiProviderId {
  return PROVIDERS.some(provider => provider.id === id)
}

export function baseUrlOf(settings: AiSettings): string {
  if (settings.baseUrl.trim()) return settings.baseUrl.trim().replace(/\/+$/, '')
  return providerOf(settings.provider).baseUrl
}

export function modelOf(settings: AiSettings): string {
  return settings.model.trim()
}

export function missingSetup(settings: AiSettings): string | null {
  if (!isKnownProvider(settings.provider)) return PROVIDER_LEFT
  const provider = providerOf(settings.provider)
  if (!modelOf(settings)) return NO_MODEL
  if (!baseUrlOf(settings)) return 'Informe a URL base do provedor em Configurações › Inteligência artificial › Provedores.'
  if (provider.needsKey && !settings.apiKey.trim()) return `Falta a chave de ${provider.name} em Configurações › Inteligência artificial › Provedores.`
  return null
}
