import { describe, expect, it } from 'vitest'
import { baseUrlOf, intervalOf, isFreeChoice, isKnownProvider, missingSetup, modelOf, PROVIDERS, providerOf } from '@/lib/ai/providers'
import { defaultSettings } from '@/lib/defaults'
import type { AiSettings } from '@/types/domain'

function settings(overrides: Partial<AiSettings>): AiSettings {
  return { provider: 'ovh', baseUrl: '', apiKey: '', model: '', ...overrides }
}

describe('provider catalog', () => {
  it('lists exactly the supported providers', () => {
    expect(PROVIDERS.map(provider => provider.id).sort()).toEqual(
      ['anthropic', 'custom', 'free', 'gemini', 'llm7', 'openai', 'ovh', 'pollinations', 'xai'].sort(),
    )
  })

  it('uses the expected display names including Personalizado for custom', () => {
    const names = Object.fromEntries(PROVIDERS.map(provider => [provider.id, provider.name]))
    expect(names.anthropic).toBe('Anthropic')
    expect(names.openai).toBe('OpenAI')
    expect(names.gemini).toMatch(/Gemini/)
    expect(names.xai).toBe('xAI')
    expect(names.ovh).toBe('OVHcloud')
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

  it('OVHcloud works without a key; LLM7, Pollinations and the others require one', () => {
    expect(providerOf('ovh').needsKey).toBe(false)
    for (const id of ['llm7', 'pollinations', 'anthropic', 'openai', 'gemini', 'xai'] as const) expect(providerOf(id).needsKey).toBe(true)
  })

  it('free providers offer only the model tested for them', () => {
    expect(providerOf('ovh').models).toEqual(['Meta-Llama-3_3-70B-Instruct'])
    expect(providerOf('gemini').models).toEqual(['gemini-3.5-flash-lite'])
    expect(providerOf('pollinations').models).toEqual(['openai'])
    expect(providerOf('llm7').models).toEqual(['default'])
    for (const id of ['anthropic', 'openai', 'xai', 'custom'] as const) expect(providerOf(id).models).toBeUndefined()
  })

  it('OVHcloud without key goes one request at a time, 31 s apart; with key there is no line', () => {
    expect(intervalOf(settings({ provider: 'ovh' }))).toBe(31000)
    expect(intervalOf(settings({ provider: 'ovh', apiKey: 'k' }))).toBe(0)
    expect(intervalOf(settings({ provider: 'llm7', apiKey: 'k' }))).toBe(0)
  })

  it('knows which saved provider ids still exist', () => {
    expect(isKnownProvider('ovh')).toBe(true)
    for (const id of ['groq', 'mistral', 'openrouter', 'ollama']) expect(isKnownProvider(id)).toBe(false)
  })
})

describe('default provider', () => {
  it('is OVHcloud without key or model', () => {
    expect(defaultSettings().ai).toEqual({ provider: 'ovh', baseUrl: '', apiKey: '', model: '' })
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

  it('OVHcloud without key uses its endpoint and Llama 3.3 70B', () => {
    const keyless = settings({ provider: 'ovh' })
    expect(baseUrlOf(keyless)).toBe('https://oai.endpoints.kepler.ai.cloud.ovh.net/v1')
    expect(modelOf(keyless)).toBe('Meta-Llama-3_3-70B-Instruct')
  })

  it('LLM7 without key asks for the key', () => {
    expect(missingSetup(settings({ provider: 'llm7', model: 'default' }))).toBe('Falta a chave de LLM7 nas Configurações.')
  })

  it('explicit base URL wins and loses trailing slashes', () => {
    expect(baseUrlOf(settings({ provider: 'custom', baseUrl: ' https://x.example/v1/// ' }))).toBe('https://x.example/v1')
  })

  it('explicit model wins over keyless model', () => {
    expect(modelOf(settings({ provider: 'ovh', model: 'gpt-oss-120b' }))).toBe('gpt-oss-120b')
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
    for (const id of ['ovh', 'pollinations', 'llm7', 'gemini'] as const) expect(isFreeChoice(settings({ provider: id }))).toBe(true)
  })

  it('is off for paid providers with a paid model', () => {
    for (const id of ['anthropic', 'openai', 'xai', 'custom'] as const) expect(isFreeChoice(settings({ provider: id, model: 'some-model' }))).toBe(false)
  })

  it('is on for any model id ending with :free', () => {
    expect(isFreeChoice(settings({ provider: 'custom', model: 'meta/llama:free' }))).toBe(true)
  })
})
