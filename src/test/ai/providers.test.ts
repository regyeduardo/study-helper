import { describe, expect, it } from 'vitest'

import { baseUrlOf, isKnownProvider, missingSetup, modelOf, PROVIDER_LEFT, PROVIDERS, providerOf } from '@/lib/ai/providers'
import { defaultSettings } from '@/lib/defaults'
import type { AiProviderId, AiSettings } from '@/types/domain'

function settings(overrides: Partial<AiSettings>): AiSettings {
  return { provider: 'openai', baseUrl: '', apiKey: '', model: '', ...overrides }
}

describe('provider types', () => {
  it('are the types of the Provedores tab, in its order, with Personalizado last', () => {
    expect(PROVIDERS.map(provider => provider.name)).toEqual(['DeepInfra', 'OpenRouter', 'Vercel AI Gateway', 'DeepSeek', 'xAI', 'Anthropic', 'Mistral', 'OpenAI', 'Google Gemini', 'Groq', 'Together', 'Personalizado'])
    expect(PROVIDERS.filter(provider => provider.format === 'anthropic').map(provider => provider.id)).toEqual(['anthropic'])
    expect(PROVIDERS.filter(provider => !provider.needsKey).map(provider => provider.id)).toEqual(['deepinfra', 'openrouter', 'vercel', 'custom'])
    expect(providerOf('deepinfra').baseUrl).toBe('https://api.deepinfra.com/v1/openai')
  })

  it('a provider that left the app asks to choose another one', () => {
    for (const id of ['free', 'ovh', 'pollinations', 'llm7']) {
      expect(isKnownProvider(id)).toBe(false)
      expect(missingSetup({ provider: id as AiProviderId, baseUrl: '', apiKey: '', model: 'x' })).toBe(PROVIDER_LEFT)
    }
  })
})

describe('what a call needs', () => {
  it('the type address unless Personalizado gives its own, without trailing slashes', () => {
    expect(baseUrlOf(settings({ provider: 'groq' }))).toBe('https://api.groq.com/openai/v1')
    expect(baseUrlOf(settings({ provider: 'custom', baseUrl: ' https://x.example/v1/// ' }))).toBe('https://x.example/v1')
    expect(modelOf(settings({ model: ' gpt-x ' }))).toBe('gpt-x')
  })

  it('asks for a model first, then the address, then the key', () => {
    expect(missingSetup(defaultSettings().ai)).toBe('Escolha um modelo em Configurações › Inteligência artificial › Padrões por uso, ou na hora de gerar.')
    expect(missingSetup(settings({ provider: 'custom', model: 'm' }))).toMatch(/URL base/)
    expect(missingSetup(settings({ model: 'gpt-x' }))).toBe('Falta a chave de OpenAI em Configurações › Inteligência artificial › Provedores.')
    expect(missingSetup(settings({ provider: 'deepinfra', model: 'm' }))).toBeNull()
  })
})
