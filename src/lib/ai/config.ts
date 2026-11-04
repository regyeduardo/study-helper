import type { AiConfig, AiModel, AiProvider, AiProviderId, AiSettings, AiStep, AiUse, ProviderEngine, Settings, TranscriptionCredential, TranscriptionEngine, TranscriptionSettings } from '@/types/domain'
import { baseUrlOf, isKnownProvider, missingSetup, PROVIDERS, providerOf } from '@/lib/ai/providers'
import { defaultSettings } from '@/lib/defaults'

/** What a model can take. `null`: the provider does not say. */
export type Media = 'texto' | 'imagem' | 'audio' | 'video' | 'pdf'
export type MediaInfo = Record<Media, boolean | null>

export const MEDIA: [Media, string][] = [
  ['texto', 'texto'],
  ['imagem', 'imagem'],
  ['audio', 'áudio'],
  ['video', 'vídeo'],
  ['pdf', 'PDF'],
]
export const MEDIA_LABEL = Object.fromEntries(MEDIA) as Record<Media, string>

export interface UseInfo<Id extends string = AiUse> {
  id: Id
  label: string
  needs: Media[]
  main?: boolean
  from?: AiUse
  /** Said instead of "X recebe…" when the use routes that media elsewhere. */
  route?: string
  note?: string
}

export interface UseGroup {
  id: 'estudo' | 'midia' | 'reuniao'
  title: string
  uses: UseInfo[]
}

const TEXT: Media[] = ['texto']

export const USE_GROUPS: UseGroup[] = [
  {
    id: 'estudo',
    title: 'Estudo',
    uses: [
      { id: 'estudo', label: 'Estudo', needs: TEXT, main: true },
      { id: 'aula', label: 'Aula', needs: ['texto', 'pdf', 'imagem'], route: 'PDF e foto da Aula vão pela Leitura de tela.', from: 'estudo' },
      { id: 'explicacao', label: 'Explicação', needs: TEXT, from: 'estudo' },
      { id: 'prova', label: 'Prova', needs: TEXT, from: 'estudo' },
      { id: 'web', label: 'Questões da web', needs: TEXT, from: 'estudo', note: 'Precisa de um modelo que pesquise na web.' },
      { id: 'cartoes', label: 'Cartões', needs: TEXT, from: 'estudo' },
      { id: 'mapa', label: 'Mapa mental', needs: TEXT, from: 'estudo' },
      { id: 'tutor', label: 'Tutor', needs: TEXT, from: 'estudo' },
      { id: 'curso', label: 'Análise de curso', needs: TEXT, from: 'estudo' },
      { id: 'titulo', label: 'Título e etiquetas', needs: TEXT, from: 'estudo' },
    ],
  },
  {
    id: 'midia',
    title: 'Mídia',
    uses: [
      { id: 'midia', label: 'Vídeo e áudio', needs: ['video', 'audio'], main: true },
      { id: 'transcricao', label: 'Transcrição', needs: ['audio'], from: 'midia' },
      { id: 'tela', label: 'Leitura de tela', needs: ['imagem'], from: 'midia' },
    ],
  },
  { id: 'reuniao', title: 'Reunião', uses: [{ id: 'ata', label: 'Ata', needs: TEXT, from: 'estudo' }] },
]

export const ATA_STEPS: UseInfo<AiStep>[] = [
  { id: 'contexto', label: 'Contexto', needs: TEXT },
  { id: 'tarefas', label: 'Tarefas', needs: TEXT },
  { id: 'revisar', label: 'Revisar', needs: TEXT },
  { id: 'semdono', label: 'Sem dono', needs: TEXT },
  { id: 'escrever', label: 'Escrever', needs: TEXT },
]

export const USES: UseInfo[] = USE_GROUPS.flatMap(group => group.uses)
export const useInfo = (id: AiUse): UseInfo => USES.find(use => use.id === id)!

const STEP_IDS = new Set<string>(ATA_STEPS.map(step => step.id))

const isStep = (id: AiUse | AiStep): id is AiStep => STEP_IDS.has(id)

const known = (config: AiConfig, uid: string | undefined): string | undefined => (uid && config.models.some(model => model.uid === uid) ? uid : undefined)

/**
 * The model uid a use (or an Ata step) takes by default: its own, else its mother's; none when nothing is set.
 * `qualifies` filters the inherited one (Questões da web only inherits a model that searches the web).
 */
export function uidFor(config: AiConfig, id: AiUse | AiStep, qualifies: (uid: string) => boolean = () => true): string | undefined {
  if (isStep(id)) return known(config, config.steps[id]) ?? uidFor(config, 'ata')
  const own = known(config, config.defaults[id])
  if (own) return own
  const from = useInfo(id).from
  const inherited = from ? known(config, config.defaults[from]) : undefined
  return inherited && qualifies(inherited) ? inherited : undefined
}

export const modelByUid = (config: AiConfig, uid: string | undefined): AiModel | undefined => config.models.find(model => model.uid === uid)
export const providerById = (config: AiConfig, id: string | undefined): AiProvider | undefined => config.providers.find(provider => provider.id === id)

/** Where a call to that model goes: the provider type, its key and, for Personalizado, its address. */
export function targetOf(config: AiConfig, uid: string | undefined): AiSettings | null {
  const model = modelByUid(config, uid)
  const provider = providerById(config, model?.pid)
  if (!model || !provider) return null
  return { provider: provider.type, baseUrl: provider.type === 'custom' ? provider.base : '', apiKey: provider.key, model: model.mid }
}

const emptyAi = (): AiSettings => defaultSettings().ai

/** The AI a use talks to: the model chosen at generation time, else the default; an empty one asks to choose. */
export function targetFor(settings: Settings, id: AiUse | AiStep, pick?: string | null): AiSettings {
  const config = aiConfigOf(settings)
  return targetOf(config, known(config, pick ?? undefined) ?? uidFor(config, id)) ?? emptyAi()
}

/** The old single `ai` field, kept in step with the Tutor model (TutorDialog still reads it). */
export function legacyAiOf(config: AiConfig): AiSettings {
  return targetOf(config, uidFor(config, 'tutor')) ?? emptyAi()
}

export function visionOf(settings: Settings, pick?: string | null): AiSettings | null {
  const config = aiConfigOf(settings)
  const target = targetOf(config, known(config, pick ?? undefined) ?? uidFor(config, 'tela'))
  return target && !missingSetup(target) ? target : null
}

// Models served by /audio/transcriptions; any other model hears through chat/completions.
const SPEECH_MODEL = /whisper|transcri|voxtral|parakeet|canary|speech|asr|\bstt\b/i

function engineOf(type: AiProviderId, model: string): ProviderEngine {
  if (type === 'gemini') return 'gemini'
  if (!SPEECH_MODEL.test(model)) return 'chat'
  if (type === 'openai') return 'openai'
  if (type === 'deepinfra') return 'deepinfra'
  return 'custom'
}

/** What `transcribe` needs, from the Transcrição model (own or inherited from Vídeo e áudio) or the one picked now. */
export function transcriptionOf(settings: Settings, pick?: string | null): TranscriptionSettings {
  const saved = { ...defaultSettings().transcription, ...settings.transcription }
  const config = aiConfigOf(settings)
  const target = targetOf(config, known(config, pick ?? undefined) ?? uidFor(config, 'transcricao'))
  const common = { language: saved.language, ...(saved.terms !== undefined ? { terms: saved.terms } : {}), speakersEngine: '' as const }
  if (!target) return { ...common, engine: '' as TranscriptionEngine, credentials: {} }
  const engine = engineOf(target.provider, target.model)
  const credential: TranscriptionCredential = { apiKey: target.apiKey, baseUrl: baseUrlOf(target), model: target.model, extra: engine === 'custom' ? (saved.credentials?.custom?.extra ?? '') : '' }
  return { ...common, engine, credentials: { [engine]: credential } }
}

/** True unless the provider says the model does NOT take something the use receives. */
export function compatible(media: MediaInfo | null | undefined, needs: Media[]): boolean {
  return !media || !needs.some(need => media[need] === false)
}

/* ---------- removing ---------- */

export function withoutModels(config: AiConfig, gone: Set<string>): AiConfig {
  const keep = <K extends string>(box: Partial<Record<K, string>>) => Object.fromEntries(Object.entries(box).filter(([, uid]) => !gone.has(uid as string))) as Partial<Record<K, string>>
  return { ...config, models: config.models.filter(model => !gone.has(model.uid)), defaults: keep(config.defaults), steps: keep(config.steps) }
}

export function withoutProvider(config: AiConfig, id: string): AiConfig {
  const gone = withoutModels(config, new Set(config.models.filter(model => model.pid === id).map(model => model.uid)))
  return { ...gone, providers: gone.providers.filter(provider => provider.id !== id) }
}

/* ---------- old settings → config ---------- */

const LEGACY_MODELS: Partial<Record<AiProviderId, string>> = { gemini: 'gemini-3.5-flash-lite' }
const ENGINE_MODELS: Record<'openai' | 'deepinfra' | 'gemini', string> = { openai: 'gpt-4o-transcribe-diarize', deepinfra: 'openai/whisper-large-v3', gemini: 'gemini-flash-latest' }
const trimmed = (url: string) => url.trim().replace(/\/+$/, '')

/** A Personalizado pointing to the exact address of a known type becomes that type (it reads media and price live). */
function typeOf(id: AiProviderId, base: string): { type: AiProviderId; base: string } {
  if (id !== 'custom') return { type: id, base: '' }
  const same = PROVIDERS.find(provider => provider.id !== 'custom' && provider.baseUrl && trimmed(provider.baseUrl) === trimmed(base))
  return same ? { type: same.id, base: '' } : { type: 'custom', base: trimmed(base) }
}

export function seedConfig(): AiConfig {
  return {
    providers: [
      { id: 'deepinfra', type: 'deepinfra', name: 'DeepInfra', key: '', base: '' },
      { id: 'openrouter', type: 'openrouter', name: 'OpenRouter', key: '', base: '' },
    ],
    models: [],
    defaults: {},
    steps: {},
  }
}

const PASS_STEPS: [keyof NonNullable<Settings['aiPasses']>, AiStep][] = [
  ['context', 'contexto'],
  ['candidates', 'tarefas'],
  ['review', 'revisar'],
  ['pending', 'semdono'],
  ['write', 'escrever'],
]

/** Maps the old single AI, its saved keys, per-step models, vision and transcription to providers, models and defaults. */
export function fromLegacy(settings: Settings): AiConfig {
  const providers: AiProvider[] = []
  const models: AiModel[] = []
  const defaults: AiConfig['defaults'] = {}
  const steps: AiConfig['steps'] = {}
  const credentials = settings.aiCredentials ?? {}
  const ai = settings.ai ?? emptyAi()

  const addProvider = (id: AiProviderId, key: string, base: string): AiProvider => {
    const { type, base: address } = typeOf(id, base)
    const same = providers.find(provider => provider.type === type && provider.key === key.trim() && provider.base === address)
    if (same) return same
    const count = providers.filter(provider => provider.type === type).length
    const provider = { id: count ? `${type}-${count + 1}` : type, type, name: count ? `${providerOf(type).name} (${count + 1})` : providerOf(type).name, key: key.trim(), base: address }
    providers.push(provider)
    return provider
  }
  const addModel = (provider: AiProvider, mid: string): string => {
    const uid = `${provider.id}::${mid}`
    if (!models.some(model => model.uid === uid)) models.push({ uid, pid: provider.id, mid, name: mid })
    return uid
  }
  const credentialOf = (id: AiProviderId) => credentials[id] ?? (ai.provider === id ? { apiKey: ai.apiKey, model: ai.model, baseUrl: ai.baseUrl } : undefined)

  if (isKnownProvider(ai.provider)) {
    const saved = credentials[ai.provider]
    const key = ai.apiKey || saved?.apiKey || ''
    const base = ai.baseUrl || saved?.baseUrl || ''
    const model = ai.model.trim() || LEGACY_MODELS[ai.provider] || ''
    const usable = Boolean(model) && !(providerOf(ai.provider).needsKey && !key.trim()) && !(ai.provider === 'custom' && !base.trim())
    if (usable || key.trim()) {
      const provider = addProvider(ai.provider, key, base)
      if (usable) {
        defaults.estudo = addModel(provider, model)
        for (const [pass, step] of PASS_STEPS) {
          const own = settings.aiPasses?.[pass]?.trim()
          if (own) steps[step] = addModel(provider, own)
        }
      }
    }
  }
  for (const [id, saved] of Object.entries(credentials) as [AiProviderId, NonNullable<Settings['aiCredentials'][AiProviderId]>][]) {
    if (id === ai.provider || !isKnownProvider(id) || !saved || !(saved.apiKey.trim() || (id === 'custom' && saved.baseUrl.trim()))) continue
    const provider = addProvider(id, saved.apiKey, saved.baseUrl)
    if (saved.model.trim()) addModel(provider, saved.model.trim())
  }
  const vision = settings.vision
  if (vision?.provider && isKnownProvider(vision.provider) && vision.model.trim()) {
    const saved = credentialOf(vision.provider)
    defaults.tela = addModel(addProvider(vision.provider, saved?.apiKey ?? '', saved?.baseUrl ?? ''), vision.model.trim())
  }
  const transcription = settings.transcription
  const heard = transcription?.credentials ?? {}
  const engines = (['openai', 'deepinfra', 'gemini', 'custom'] as const).filter(engine => heard[engine]).sort((a, b) => Number(b === transcription?.engine) - Number(a === transcription?.engine))
  for (const engine of engines) {
    const saved = heard[engine]!
    const base = engine === 'custom' ? saved.baseUrl.replace(/\/audio\/transcriptions\/?$/, '') : ''
    const model = saved.model.trim() || (engine === 'custom' ? '' : ENGINE_MODELS[engine])
    const inUse = engine === transcription?.engine
    const usable = engine === 'custom' ? Boolean(base.trim() && model) : Boolean(saved.apiKey.trim())
    if (!usable && !saved.apiKey.trim()) continue
    const provider = addProvider(engine, saved.apiKey, base)
    if (inUse && usable) defaults.transcricao = addModel(provider, model)
    else if (saved.model.trim()) addModel(provider, saved.model.trim())
  }
  if (!providers.length) return seedConfig()
  return { providers, models, defaults, steps }
}

/** The saved config, or the one derived from the old fields (indexes saved before this screen). */
export function aiConfigOf(settings: Settings): AiConfig {
  return settings.aiConfig ?? fromLegacy(settings)
}

/** On load: the config is always there and the old `ai` mirrors the Tutor model. */
export function normalizeSettings(settings: Settings): Settings {
  const aiConfig = aiConfigOf(settings)
  return { ...settings, aiConfig, ai: legacyAiOf(aiConfig) }
}
