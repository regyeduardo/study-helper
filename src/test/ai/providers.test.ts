import { describe, expect, it } from 'vitest'
import { baseUrlOf, intervalOf, isFreeChoice, isKnownProvider, missingSetup, modelOf, PROVIDERS, providerOf } from '@/lib/ai/providers'
import { defaultSettings } from '@/lib/defaults'
import type { AiSettings } from '@/types/domain'

function settings(overrides: Partial<AiSettings>): AiSettings {
  return { provider: 'gemini', baseUrl: '', apiKey: '', model: '', ...overrides }
}

describe('provider catalog', () => {
  it('lists exactly the supported providers', () => {
    expect(PROVIDERS.map(provider => provider.id).sort()).toEqual(
      ['anthropic', 'custom', 'gemini', 'openai', 'xai'].sort(),
    )
  })

  it('uses the expected display names including Personalizado for custom', () => {
    const names = Object.fromEntries(PROVIDERS.map(provider => [provider.id, provider.name]))
    expect(names.anthropic).toBe('Anthropic')
    expect(names.openai).toBe('OpenAI')
    expect(names.gemini).toMatch(/Gemini/)
    expect(names.xai).toBe('xAI')
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

  it('knows which saved provider ids still exist', () => {
    expect(isKnownProvider('gemini')).toBe(true)
    for (const id of ['groq', 'mistral', 'openrouter', 'ollama', 'free', 'ovh', 'pollinations']) expect(isKnownProvider(id)).toBe(false)
  })
})

describe('default provider', () => {
  it('is Gemini without key or model', () => {
    expect(defaultSettings().ai).toEqual({ provider: 'gemini', baseUrl: '', apiKey: '', model: '' })
  })

  it('default settings ask for the Gemini key before generating', () => {
    expect(missingSetup(defaultSettings().ai)).toBe('Falta a chave de Google Gemini nas Configurações.')
  })
})

describe('endpoint and model resolution', () => {

  it('explicit base URL wins and loses trailing slashes', () => {
    expect(baseUrlOf(settings({ provider: 'custom', baseUrl: ' https://x.example/v1/// ' }))).toBe('https://x.example/v1')
  })

  it('explicit model wins over keyless model', () => {
    expect(modelOf(settings({ provider: 'openai', model: 'gpt-oss-120b' }))).toBe('gpt-oss-120b')
  })

  it('custom provider without URL asks for a base URL', () => {
    expect(missingSetup(settings({ provider: 'custom' }))).toMatch(/URL base/)
  })

  it('keyed provider without key asks for it by name', () => {
    expect(missingSetup(settings({ provider: 'gemini', model: 'gemini-3.5-flash-lite' }))).toBe('Falta a chave de Google Gemini nas Configurações.')
  })

  it('keyed provider without model asks to choose one', () => {
    expect(missingSetup(settings({ provider: 'openai', apiKey: 'sk' }))).toMatch(/modelo/)
  })
})

describe('free model warning flag', () => {
  it('is on for free providers', () => {
    for (const id of ['gemini'] as const) expect(isFreeChoice(settings({ provider: id }))).toBe(true)
  })

  it('is off for paid providers with a paid model', () => {
    for (const id of ['anthropic', 'openai', 'xai', 'custom'] as const) expect(isFreeChoice(settings({ provider: id, model: 'some-model' }))).toBe(false)
  })

  it('is on for any model id ending with :free', () => {
    expect(isFreeChoice(settings({ provider: 'custom', model: 'meta/llama:free' }))).toBe(true)
  })
})
