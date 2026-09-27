import { describe, expect, it } from 'vitest'
import { baseUrlOf, isFreeChoice, missingSetup, modelOf, PROVIDERS, providerOf } from '@/lib/ai/providers'
import { defaultSettings } from '@/lib/defaults'
import type { AiSettings } from '@/types/domain'

function settings(overrides: Partial<AiSettings>): AiSettings {
  return { provider: 'llm7', baseUrl: '', apiKey: '', model: '', ...overrides }
}

describe('provider catalog', () => {
  it('lists exactly the supported providers', () => {
    expect(PROVIDERS.map(provider => provider.id).sort()).toEqual(
      ['anthropic', 'custom', 'gemini', 'groq', 'llm7', 'mistral', 'ollama', 'openai', 'openrouter', 'pollinations', 'xai'].sort(),
    )
  })

  it('uses the expected display names including Personalizado for custom', () => {
    const names = Object.fromEntries(PROVIDERS.map(provider => [provider.id, provider.name]))
    expect(names.anthropic).toBe('Anthropic')
    expect(names.openai).toBe('OpenAI')
    expect(names.gemini).toMatch(/Gemini/)
    expect(names.mistral).toBe('Mistral')
    expect(names.groq).toBe('Groq')
    expect(names.openrouter).toBe('OpenRouter')
    expect(names.xai).toBe('xAI')
    expect(names.ollama).toBe('Ollama')
    expect(names.pollinations).toBe('Pollinations')
    expect(names.llm7).toBe('LLM7')
    expect(names.custom).toBe('Personalizado')
  })

  it('does not offer DeepSeek anywhere', () => {
    const serialized = JSON.stringify(PROVIDERS).toLowerCase()
    expect(serialized).not.toContain('deepseek')
  })

  it('has unique ids', () => {
    expect(new Set(PROVIDERS.map(provider => provider.id)).size).toBe(PROVIDERS.length)
  })

  it('only Anthropic uses the anthropic wire format', () => {
    expect(PROVIDERS.filter(provider => provider.format === 'anthropic').map(provider => provider.id)).toEqual(['anthropic'])
  })

  it('LLM7 works without a key; Pollinations and the others require one', () => {
    expect(providerOf('llm7').needsKey).toBe(false)
    expect(providerOf('ollama').needsKey).toBe(false)
    for (const id of ['pollinations', 'anthropic', 'openai', 'gemini', 'mistral', 'groq', 'openrouter', 'xai'] as const) expect(providerOf(id).needsKey).toBe(true)
  })
})

describe('default provider', () => {
  it('is LLM7 without key or model', () => {
    expect(defaultSettings().ai).toEqual({ provider: 'llm7', baseUrl: '', apiKey: '', model: '' })
  })

  it('default settings are ready to generate without any setup', () => {
    expect(missingSetup(defaultSettings().ai)).toBeNull()
  })
})

describe('endpoint and model resolution', () => {
  it('Pollinations without key cannot be used and asks for the key', () => {
    expect(missingSetup(settings({ provider: 'pollinations', model: 'openai' }))).toBe('Falta a chave de Pollinations nas Configurações.')
  })

  it('Pollinations with key uses the gateway', () => {
    expect(baseUrlOf(settings({ provider: 'pollinations', apiKey: 'sk' }))).toBe('https://gen.pollinations.ai/v1')
  })

  it('LLM7 without key uses api.llm7.io and the default model', () => {
    const keyless = settings({ provider: 'llm7' })
    expect(baseUrlOf(keyless)).toBe('https://api.llm7.io/v1')
    expect(modelOf(keyless)).toBe('default')
  })

  it('explicit base URL wins and loses trailing slashes', () => {
    expect(baseUrlOf(settings({ provider: 'custom', baseUrl: ' https://x.example/v1/// ' }))).toBe('https://x.example/v1')
  })

  it('explicit model wins over keyless model', () => {
    expect(modelOf(settings({ provider: 'llm7', model: 'gpt-4o-mini' }))).toBe('gpt-4o-mini')
  })

  it('custom provider without URL asks for a base URL', () => {
    expect(missingSetup(settings({ provider: 'custom' }))).toMatch(/URL base/)
  })

  it('keyed provider without key asks for it by name', () => {
    expect(missingSetup(settings({ provider: 'groq', model: 'llama' }))).toBe('Falta a chave de Groq nas Configurações.')
  })

  it('keyed provider without model asks to choose one', () => {
    expect(missingSetup(settings({ provider: 'openai', apiKey: 'sk' }))).toMatch(/modelo/)
  })
})

describe('free model warning flag', () => {
  it('is on for free providers', () => {
    for (const id of ['pollinations', 'llm7', 'gemini', 'mistral', 'groq', 'openrouter', 'ollama'] as const) expect(isFreeChoice(settings({ provider: id }))).toBe(true)
  })

  it('is off for paid providers with a paid model', () => {
    for (const id of ['anthropic', 'openai', 'xai', 'custom'] as const) expect(isFreeChoice(settings({ provider: id, model: 'some-model' }))).toBe(false)
  })

  it('is on for any model id ending with :free', () => {
    expect(isFreeChoice(settings({ provider: 'custom', model: 'meta/llama:free' }))).toBe(true)
  })
})
