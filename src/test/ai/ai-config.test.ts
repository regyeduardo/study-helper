import { describe, expect, it } from 'vitest'

import { aiConfigOf, compatible, fromLegacy, legacyAiOf, normalizeSettings, targetFor, targetOf, transcriptionOf, uidFor, visionOf, withoutModels, withoutProvider } from '@/lib/ai/config'
import { defaultSettings } from '@/lib/defaults'
import type { AiConfig, Settings } from '@/types/domain'

const base = (): Settings => defaultSettings()

function config(patch: Partial<AiConfig> = {}): AiConfig {
  return {
    providers: [
      { id: 'di', type: 'deepinfra', name: 'DeepInfra', key: 'di-key', base: '' },
      { id: 'or', type: 'openrouter', name: 'OpenRouter', key: '', base: '' },
      { id: 'mine', type: 'custom', name: 'Minha IA', key: 'k', base: 'https://minha.exemplo/v1/' },
      { id: 'ant', type: 'anthropic', name: 'Anthropic', key: '', base: '' },
    ],
    models: [
      { uid: 'di::deepseek-ai/DeepSeek-V4.1-Flash', pid: 'di', mid: 'deepseek-ai/DeepSeek-V4.1-Flash', name: 'DeepSeek-V4.1-Flash' },
      { uid: 'di::openai/whisper-large-v3', pid: 'di', mid: 'openai/whisper-large-v3', name: 'whisper-large-v3' },
      { uid: 'di::nvidia/Nemotron-3-Nano-Omni', pid: 'di', mid: 'nvidia/Nemotron-3-Nano-Omni', name: 'Nemotron-3-Nano-Omni' },
      { uid: 'or::openai/whisper-1', pid: 'or', mid: 'openai/whisper-1', name: 'whisper-1' },
      { uid: 'mine::modelo', pid: 'mine', mid: 'modelo', name: 'modelo' },
      { uid: 'ant::claude', pid: 'ant', mid: 'claude', name: 'Claude' },
    ],
    defaults: {},
    steps: {},
    ...patch,
  }
}

const withConfig = (aiConfig: AiConfig): Settings => ({ ...base(), aiConfig })

describe('old settings become providers, models and defaults (nothing lost)', () => {
  it('a fresh index starts with DeepInfra and OpenRouter, no models and no defaults', () => {
    expect(fromLegacy(base())).toEqual({
      providers: [
        { id: 'deepinfra', type: 'deepinfra', name: 'DeepInfra', key: '', base: '' },
        { id: 'openrouter', type: 'openrouter', name: 'OpenRouter', key: '', base: '' },
      ],
      models: [],
      defaults: {},
      steps: {},
    })
  })

  it('the old text AI, its per-step models, the vision and the transcription keep working, with one provider per key', () => {
    const old: Settings = {
      ...base(),
      ai: { provider: 'custom', baseUrl: 'https://api.deepinfra.com/v1/openai', apiKey: 'di-1', model: 'deepseek-ai/DeepSeek-V4.1-Flash' },
      aiCredentials: { gemini: { apiKey: 'AQ.g', model: 'gemini-3.5-flash-lite', baseUrl: '' } },
      aiPasses: { review: 'Qwen/Qwen3.7-Max', write: 'deepseek-ai/DeepSeek-V4.1-Flash' },
      vision: { provider: 'gemini', model: 'gemini-3.5-flash' },
      transcription: { engine: 'deepinfra', language: 'pt', credentials: { deepinfra: { apiKey: 'di-1', baseUrl: '', model: '', extra: '' } }, speakersEngine: '', terms: 'API' },
    }
    const made = fromLegacy(old)
    expect(made.providers).toEqual([
      { id: 'deepinfra', type: 'deepinfra', name: 'DeepInfra', key: 'di-1', base: '' },
      { id: 'gemini', type: 'gemini', name: 'Google Gemini', key: 'AQ.g', base: '' },
    ])
    expect(made.models.map(model => model.uid)).toEqual([
      'deepinfra::deepseek-ai/DeepSeek-V4.1-Flash',
      'deepinfra::Qwen/Qwen3.7-Max',
      'gemini::gemini-3.5-flash-lite',
      'gemini::gemini-3.5-flash',
      'deepinfra::openai/whisper-large-v3',
    ])
    expect(made.defaults).toEqual({ estudo: 'deepinfra::deepseek-ai/DeepSeek-V4.1-Flash', tela: 'gemini::gemini-3.5-flash', transcricao: 'deepinfra::openai/whisper-large-v3' })
    expect(made.steps).toEqual({ revisar: 'deepinfra::Qwen/Qwen3.7-Max', escrever: 'deepinfra::deepseek-ai/DeepSeek-V4.1-Flash' })
    expect(transcriptionOf(old)).toMatchObject({ engine: 'deepinfra', language: 'pt', terms: 'API', credentials: { deepinfra: { apiKey: 'di-1', model: 'openai/whisper-large-v3' } } })
    expect(visionOf(old)).toEqual({ provider: 'gemini', baseUrl: '', apiKey: 'AQ.g', model: 'gemini-3.5-flash' })
  })

  it('an unknown address stays Personalizado with its URL; a provider that left the app is not brought', () => {
    const custom = fromLegacy({ ...base(), ai: { provider: 'custom', baseUrl: 'https://api.llm7.io/v1', apiKey: '', model: 'default' } })
    expect(custom.providers).toEqual([{ id: 'custom', type: 'custom', name: 'Personalizado', key: '', base: 'https://api.llm7.io/v1' }])
    expect(custom.defaults.estudo).toBe('custom::default')
    const gone = fromLegacy({ ...base(), ai: { provider: 'ovh' as never, baseUrl: '', apiKey: 'x', model: 'm' } })
    expect(gone.models).toEqual([])
  })

  it('a different key for the same provider becomes a second provider; the custom transcription keeps its address', () => {
    const made = fromLegacy({
      ...base(),
      ai: { provider: 'openai', baseUrl: '', apiKey: 'sk-text', model: 'gpt-x' },
      transcription: { engine: 'custom', language: 'pt', credentials: { custom: { apiKey: 'c', baseUrl: 'https://agrupador.example/v1/audio/transcriptions', model: 'whisper-large', extra: '{"diarize": true}' }, openai: { apiKey: 'sk-audio', baseUrl: '', model: '', extra: '' } }, speakersEngine: '' },
    })
    expect(made.providers).toEqual([
      { id: 'openai', type: 'openai', name: 'OpenAI', key: 'sk-text', base: '' },
      { id: 'custom', type: 'custom', name: 'Personalizado', key: 'c', base: 'https://agrupador.example/v1' },
      { id: 'openai-2', type: 'openai', name: 'OpenAI (2)', key: 'sk-audio', base: '' },
    ])
    expect(made.defaults.transcricao).toBe('custom::whisper-large')
  })

  it('reading old settings derives the config; a saved config is used as is', () => {
    const saved = config({ defaults: { estudo: 'mine::modelo' } })
    expect(aiConfigOf(withConfig(saved))).toBe(saved)
    expect(aiConfigOf({ ...base(), ai: { provider: 'xai', baseUrl: '', apiKey: 'x', model: 'grok' } }).defaults.estudo).toBe('xai::grok')
  })

  it('on load the config is filled in and the old "ai" follows the Tutor model, or the factory one', () => {
    const loaded = normalizeSettings({ ...base(), ai: { provider: 'xai', baseUrl: '', apiKey: 'x', model: 'grok' } })
    expect(loaded.aiConfig?.defaults.estudo).toBe('xai::grok')
    expect(loaded.ai).toEqual({ provider: 'xai', baseUrl: '', apiKey: 'x', model: 'grok' })
    expect(legacyAiOf(config({ defaults: { tutor: 'mine::modelo' } }))).toEqual({ provider: 'custom', baseUrl: 'https://minha.exemplo/v1/', apiKey: 'k', model: 'modelo' })
    expect(legacyAiOf(config())).toEqual(defaultSettings().ai)
  })
})

describe('which model each use takes', () => {
  it('the uses inherit from their mother; a use with its own model keeps it; the steps inherit from the Ata', () => {
    const made = config({ defaults: { estudo: 'mine::modelo', cartoes: 'ant::claude', midia: 'di::nvidia/Nemotron-3-Nano-Omni' }, steps: { revisar: 'ant::claude' } })
    expect(uidFor(made, 'aula')).toBe('mine::modelo')
    expect(uidFor(made, 'cartoes')).toBe('ant::claude')
    expect(uidFor(made, 'ata')).toBe('mine::modelo')
    expect(uidFor(made, 'transcricao')).toBe('di::nvidia/Nemotron-3-Nano-Omni')
    expect(uidFor(made, 'tela')).toBe('di::nvidia/Nemotron-3-Nano-Omni')
    expect(uidFor(made, 'revisar')).toBe('ant::claude')
    expect(uidFor(made, 'escrever')).toBe('mine::modelo')
  })

  it('without a default nothing is chosen; a model that left is ignored', () => {
    expect(uidFor(config(), 'prova')).toBeUndefined()
    expect(uidFor(config({ defaults: { estudo: 'gone::x' } }), 'prova')).toBeUndefined()
  })

  it('Questões da web inherits Estudo only when that model searches the web', () => {
    const made = config({ defaults: { estudo: 'mine::modelo' } })
    expect(uidFor(made, 'web', uid => uid === 'mine::modelo')).toBe('mine::modelo')
    expect(uidFor(made, 'web', () => false)).toBeUndefined()
    expect(uidFor({ ...made, defaults: { ...made.defaults, web: 'ant::claude' } }, 'web', () => false)).toBe('ant::claude')
  })

  it('the call goes to the provider of the model, with its key; Personalizado with its own address', () => {
    expect(targetOf(config(), 'mine::modelo')).toEqual({ provider: 'custom', baseUrl: 'https://minha.exemplo/v1/', apiKey: 'k', model: 'modelo' })
    expect(targetOf(config(), 'di::openai/whisper-large-v3')).toEqual({ provider: 'deepinfra', baseUrl: '', apiKey: 'di-key', model: 'openai/whisper-large-v3' })
    const settings = withConfig(config({ defaults: { estudo: 'mine::modelo' } }))
    expect(targetFor(settings, 'prova').model).toBe('modelo')
    expect(targetFor(settings, 'prova', 'ant::claude').model).toBe('claude')
    expect(targetFor(withConfig(config()), 'prova')).toEqual(defaultSettings().ai)
  })
})

describe('transcription and screen reading go by the model chosen', () => {
  const settings = (uid: string) => withConfig(config({ defaults: { transcricao: uid } }))

  it('a speech model of DeepInfra goes by the DeepInfra transcription; a video model hears through the chat', () => {
    expect(transcriptionOf(settings('di::openai/whisper-large-v3'))).toMatchObject({ engine: 'deepinfra', credentials: { deepinfra: { apiKey: 'di-key', model: 'openai/whisper-large-v3' } }, speakersEngine: '' })
    expect(transcriptionOf(settings('di::nvidia/Nemotron-3-Nano-Omni'))).toMatchObject({ engine: 'chat', credentials: { chat: { apiKey: 'di-key', baseUrl: 'https://api.deepinfra.com/v1/openai', model: 'nvidia/Nemotron-3-Nano-Omni' } } })
  })

  it('a speech model elsewhere goes by the OpenAI format /audio/transcriptions of that provider', () => {
    expect(transcriptionOf(settings('or::openai/whisper-1'))).toMatchObject({ engine: 'custom', credentials: { custom: { baseUrl: 'https://openrouter.ai/api/v1', model: 'openai/whisper-1' } } })
  })

  it('the model chosen at generation time wins; without any, transcribing asks to choose one', () => {
    expect(transcriptionOf(settings('or::openai/whisper-1'), 'di::openai/whisper-large-v3').engine).toBe('deepinfra')
    expect(transcriptionOf(withConfig(config())).engine).toBe('')
  })

  it('the screen is read by Leitura de tela, or by the video model; a provider without its key reads nothing', () => {
    expect(visionOf(withConfig(config({ defaults: { midia: 'di::nvidia/Nemotron-3-Nano-Omni' } })))).toEqual({ provider: 'deepinfra', baseUrl: '', apiKey: 'di-key', model: 'nvidia/Nemotron-3-Nano-Omni' })
    expect(visionOf(withConfig(config({ defaults: { tela: 'ant::claude' } })))).toBeNull()
    expect(visionOf(withConfig(config()))).toBeNull()
  })
})

describe('what a use needs from a model', () => {
  it('lists only the models that can take what the use receives, keeping the one already chosen', () => {
    const media = { 'di::nvidia/Nemotron-3-Nano-Omni': { texto: true, imagem: true, audio: true, video: true, pdf: null }, 'ant::claude': { texto: true, imagem: true, audio: false, video: false, pdf: true } }
    expect(compatible(media['di::nvidia/Nemotron-3-Nano-Omni'], ['video', 'audio'])).toBe(true)
    expect(compatible(media['ant::claude'], ['video', 'audio'])).toBe(false)
    expect(compatible(null, ['video', 'audio'])).toBe(true)
    expect(compatible({ texto: true, imagem: null, audio: null, video: null, pdf: null }, ['imagem'])).toBe(true)
  })
})

describe('removing keeps the defaults consistent', () => {
  it('removing a model or a provider clears the uses and steps that pointed to it', () => {
    const made = config({ defaults: { estudo: 'mine::modelo', tela: 'di::nvidia/Nemotron-3-Nano-Omni' }, steps: { revisar: 'mine::modelo' } })
    const lessModels = withoutModels(made, new Set(['mine::modelo']))
    expect(lessModels.defaults).toEqual({ tela: 'di::nvidia/Nemotron-3-Nano-Omni' })
    expect(lessModels.steps).toEqual({})
    const lessProvider = withoutProvider(made, 'di')
    expect(lessProvider.providers.map(provider => provider.id)).toEqual(['or', 'mine', 'ant'])
    expect(lessProvider.models.some(model => model.pid === 'di')).toBe(false)
    expect(lessProvider.defaults).toEqual({ estudo: 'mine::modelo' })
  })
})
