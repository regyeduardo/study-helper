import type { ModelPrice } from '@/controllers/models.controller'
import { modelByUid, providerById, uidFor, useInfo, USES } from '@/lib/ai/config'
import { type Capability, type Ruler, type UseRequirement, USE_REQUIREMENTS } from '@/lib/ai/use-requirements'
import type { AiConfig, AiProviderId, AiUse } from '@/types/domain'

/**
 * The list the app ships with: one model + provider pair per use, and the ladder of each use (FR-047, FR-048, FR-050, FR-056).
 * Source: specs/002-mapas-hierarquia-explorador/mocks/indicacao-de-modelos/pesquisa.md. Pure: no network.
 */

/**
 * Fixed list date. The owner decided (FR-052): when the list is more than about 30 days old (`listReviewDue`),
 * the development agent asks him once, in one line, whether to refresh it (new web research plus the quality tests),
 * and never refreshes it without his yes.
 */
export const LIST_DATE = '2026-11-07'
export const LIST_DATE_LABEL = LIST_DATE.split('-').reverse().join('/')
export const LIST_TITLE = `Recomendação do app · lista de ${LIST_DATE_LABEL}`

const DAY_MS = 86_400_000

/** True when the fixed list is older than `days` (about a month, by default). */
export function listReviewDue(now: Date, days = 30): boolean {
  return now.getTime() - Date.parse(`${LIST_DATE}T00:00:00Z`) > days * DAY_MS
}

/** US$ per 1M tokens, plus the fee of each web search; or US$ per hour of audio (speech models). */
export type Price = { per: 'token'; input: number; output: number; search?: number } | { per: 'hour'; hour: number }

/** Reasoning is billed as output: the visible output counts double (the real range is 1× to 4×). */
export const REASONING_FACTOR = 2
/** Exa, through the OpenRouter `web` plugin, for any model. */
const OPENROUTER_SEARCH = 0.007

/** US$ for one typical note; null when the price is unknown or cannot bill this ruler ("?"). */
export function costPerNote(price: Price | null | undefined, ruler: Ruler, factor = REASONING_FACTOR): number | null {
  if (!price) return null
  if (price.per === 'hour') return ruler.hours === undefined ? null : price.hour * ruler.hours
  return (ruler.input * price.input + ruler.output * factor * price.output) / 1e6 + (ruler.searches ?? 0) * (price.search ?? 0)
}

/** What the provider's catalog says, as a Price; null when a cost cannot be computed from it. */
export function priceFromCatalog(price: ModelPrice | null | undefined): Price | null {
  if (!price) return null
  if ('unit' in price) return price.unit === '/h' ? { per: 'hour', hour: price.value } : null
  return price.input === null || price.output === null ? null : { per: 'token', input: price.input, output: price.output }
}

/** The same model in two providers is two pairs: each has its own price and score. */
export interface ModelPair {
  provider: AiProviderId
  /** The id in that provider. */
  model: string
  name: string
  price: Price | null
  takes: Capability[]
  context: number
}

const WRITES: Capability[] = ['texto', 'json']
const SEES_VIDEO: Capability[] = [...WRITES, 'imagem', 'video']
const HEARS_AND_SEES: Capability[] = [...SEES_VIDEO, 'audio']
const READS_FILES: Capability[] = [...WRITES, 'imagem', 'pdf']
const EVERYTHING: Capability[] = [...HEARS_AND_SEES, 'pdf']
const SPEECH: Capability[] = ['audio']

const MILLION = 1_000_000
const CONTEXT_262K = 262_144

const pair = (provider: AiProviderId, model: string, name: string, price: Price, takes: Capability[], context: number): ModelPair => ({ provider, model, name, price, takes, context })
const deepInfra = (model: string, name: string, input: number, output: number, takes: Capability[], context = MILLION) => pair('deepinfra', model, name, { per: 'token', input, output }, takes, context)
const speech = (model: string, name: string, hour: number) => pair('deepinfra', model, name, { per: 'hour', hour }, SPEECH, 0)
/** On OpenRouter any model searches the web with the `web` plugin; a native search has its own fee. */
const openRouter = (model: string, name: string, input: number, output: number, takes: Capability[], context = MILLION, search = OPENROUTER_SEARCH) => pair('openrouter', model, name, { per: 'token', input, output, search }, [...takes, 'web'], context)

const DEEPSEEK_DI = deepInfra('deepseek-ai/DeepSeek-V4-Flash-0731', 'DeepSeek V4 Flash 0731', 0.06, 0.18, WRITES)
const DEEPSEEK_OR = openRouter('deepseek/deepseek-v4-flash-0731', 'DeepSeek V4 Flash 0731', 0.046, 0.3, WRITES)
const DEEPSEEK_41_OR = openRouter('deepseek/deepseek-v4.1-flash-1017', 'DeepSeek V4.1 Flash 1017', 0.15, 0.6, [...WRITES, 'imagem'])
const MIMO_DI = deepInfra('XiaomiMiMo/MiMo-V2.6-Flash', 'MiMo-V2.6-Flash', 0.14, 0.28, HEARS_AND_SEES)
const GLM_OR = openRouter('z-ai/glm-5.3-flash', 'GLM-5.3-Flash', 0.15, 0.5, SEES_VIDEO)
const GEMMA_26B_OR = openRouter('google/gemma-4-26b-a4b-it', 'Gemma 4 26B A4B', 0.068, 0.225, SEES_VIDEO, CONTEXT_262K)
const LING_OR = openRouter('inclusionai/ling-3.0-flash', 'Ling-3.0-flash', 0.021, 0.063, WRITES, CONTEXT_262K)
const HAIKU_OR = openRouter('anthropic/claude-haiku-5.5', 'Claude Haiku 5.5', 0.1, 0.5, READS_FILES)
const LUNA_OR = openRouter('openai/gpt-6-luna', 'GPT-6 Luna', 0.1, 0.5, READS_FILES, MILLION, 0.01)
const OMNI_OR = openRouter('qwen/qwen3.8-omni-flash', 'Qwen3.8 Omni Flash', 0.15, 0.47, HEARS_AND_SEES)
const GEMINI_LITE_OR = openRouter('google/gemini-3.5-flash-lite', 'Gemini 3.5 Flash-Lite', 0.3, 2.5, EVERYTHING, MILLION, 0.014)
const GEMINI_38_OR = openRouter('google/gemini-3.8-flash', 'Gemini 3.8 Flash', 0.75, 3.75, EVERYTHING, MILLION, 0.014)
const WHISPER_TURBO_DI = speech('openai/whisper-large-v3-turbo', 'whisper-large-v3-turbo', 0.012)
const WHISPER_DI = speech('openai/whisper-large-v3', 'whisper-large-v3', 0.027)
const QWEN_ASR_DI = speech('Qwen/Qwen3-ASR-1.7B', 'Qwen3-ASR-1.7B', 0.027)
const VOXTRAL_DI = speech('mistralai/Voxtral-Small-24B-2507', 'Voxtral Small 24B', 0.18)

export const PAIRS: ModelPair[] = [DEEPSEEK_DI, DEEPSEEK_OR, DEEPSEEK_41_OR, MIMO_DI, GLM_OR, GEMMA_26B_OR, LING_OR, HAIKU_OR, LUNA_OR, OMNI_OR, GEMINI_LITE_OR, GEMINI_38_OR, WHISPER_TURBO_DI, WHISPER_DI, QWEN_ASR_DI, VOXTRAL_DI]

export const findPair = (provider: AiProviderId, model: string): ModelPair | undefined => PAIRS.find(item => item.provider === provider && item.model === model)

/**
 * Per use: why, and each pair with its list score (null: the list has not tested it).
 * PROVISIONAL scores, until the developer runs the miniature battery before publishing the list (about US$ 0.20):
 * no test has run yet. Those of r-a2-geral.wf and r-a-lista-e-escada.wf were kept (the indicated pair of each use and the
 * whole Ata); the rest follow them per model. A pair cheaper than the indicated one stays null ("não testado"), as
 * Ling-3.0-flash in the wireframe, because a score at or above the minimum would make it the indicated one.
 */
const LIST: Record<AiUse, { why: string; rungs: [ModelPair, number | null][] }> = {
  estudo: {
    why: 'o mais barato que lê a nota inteira (1M) e devolve estruturado',
    rungs: [[DEEPSEEK_DI, 9], [GEMMA_26B_OR, 8], [MIMO_DI, 8], [GLM_OR, 10], [GEMINI_38_OR, 10]],
  },
  aula: {
    why: 'o mais barato que lê a aula inteira (1M) e devolve estruturado',
    rungs: [[DEEPSEEK_DI, 9], [GLM_OR, 10]],
  },
  explicacao: {
    why: 'barato e claro em português; se o texto não agradar, sobe para o GLM',
    rungs: [[DEEPSEEK_DI, 8], [GLM_OR, 10]],
  },
  prova: {
    why: 'JSON confiável',
    rungs: [[LING_OR, null], [DEEPSEEK_DI, 9], [MIMO_DI, 8], [GLM_OR, 10]],
  },
  web: {
    why: 'a DeepInfra não pesquisa; no OpenRouter, qualquer modelo pesquisa',
    rungs: [[GEMMA_26B_OR, null], [DEEPSEEK_OR, 8], [LUNA_OR, 9], [GEMINI_LITE_OR, 9]],
  },
  cartoes: {
    why: 'JSON confiável',
    rungs: [[DEEPSEEK_DI, 9], [GLM_OR, 10]],
  },
  mapa: {
    why: 'a árvore do mapa em JSON, sem quebrar (código 69)',
    rungs: [[DEEPSEEK_DI, 9], [GLM_OR, 10]],
  },
  tutor: {
    why: 'a nota volta a cada pergunta, e a entrada barata pesa',
    rungs: [[DEEPSEEK_DI, 9], [HAIKU_OR, 9], [MIMO_DI, 8]],
  },
  curso: {
    why: 'contexto longo',
    rungs: [[DEEPSEEK_DI, 8], [DEEPSEEK_41_OR, 9]],
  },
  titulo: {
    why: 'custo irrelevante',
    rungs: [[LING_OR, null], [DEEPSEEK_DI, 10]],
  },
  midia: {
    why: 'o único barato que ouve e vê',
    rungs: [[MIMO_DI, 8], [OMNI_OR, 8], [GEMINI_LITE_OR, 9], [GEMINI_38_OR, 10]],
  },
  transcricao: {
    why: 'WER 4,17 em português, quase de graça',
    rungs: [[WHISPER_TURBO_DI, 9], [WHISPER_DI, 9], [QWEN_ASR_DI, 9], [MIMO_DI, null], [VOXTRAL_DI, null]],
  },
  tela: {
    why: 'vê imagem e lê o texto, sem configurar nada',
    rungs: [[GEMMA_26B_OR, null], [MIMO_DI, 9], [GLM_OR, 10], [GEMINI_LITE_OR, 10]],
  },
  ata: {
    why: 'contexto longo e JSON nos 5 passos',
    rungs: [[LING_OR, null], [DEEPSEEK_DI, 9], [DEEPSEEK_OR, 8], [GEMMA_26B_OR, 7], [MIMO_DI, 8], [GLM_OR, 10], [GEMINI_38_OR, 10]],
  },
}

/** Fits the DiagnosisRecord of data-model.md: one result of the person's diagnosis. */
export interface TestedPair {
  use: AiUse
  provider: AiProviderId
  model: string
  name?: string
  score: number | null
  costPerNote: number | null
  at: string
}

export interface RungCost {
  per: string
  value: number | null
}

export interface Rung {
  pair: ModelPair
  /** The one that counts: the person's score when it ran, else the list's. */
  score: number | null
  listScore: number | null
  testedScore: number | null
  testedAt: string | null
  /** US$ by the use's main ruler; null is "?". */
  cost: number | null
  /** By every ruler of the use (Vídeo e áudio: by the hour of video and of audio). */
  costs: RungCost[]
}

export interface UseRecommendation {
  use: AiUse
  why: string
  /** The cheapest pair at or above the minimum, ladder[0]; null when nothing passes. */
  indicated: Rung | null
  /** The pairs that do the use right, cheapest first. */
  ladder: Rung[]
  /** Not tested, below the minimum or without a price. */
  outside: Rung[]
  /** The use whose indicated pair it shares ("(herda)" in the list). */
  inherits: AiUse | null
}

const keyOf = (provider: AiProviderId, model: string) => `${provider}::${model}`

function newestByPair(records: TestedPair[]): Map<string, TestedPair> {
  const newest = new Map<string, TestedPair>()
  for (const record of records) {
    const key = keyOf(record.provider, record.model)
    const known = newest.get(key)
    if (!known || Date.parse(record.at) > Date.parse(known.at)) newest.set(key, record)
  }
  return newest
}

function rungOf(item: ModelPair, listScore: number | null, requirement: UseRequirement, record: TestedPair | undefined): Rung {
  const testedScore = record?.score ?? null
  const rulers = [requirement.ruler, ...(requirement.altRulers ?? [])]
  const cost = record?.costPerNote ?? costPerNote(item.price, requirement.ruler)
  const costs = rulers.map((ruler, index) => ({ per: ruler.per, value: index === 0 ? cost : costPerNote(item.price, ruler) }))
  return { pair: item, score: testedScore ?? listScore, listScore, testedScore, testedAt: record?.at ?? null, cost, costs }
}

/** A pair only the diagnosis knows: the catalog does not tell what it takes. */
const unlistedPair = (record: TestedPair): ModelPair => findPair(record.provider, record.model) ?? { provider: record.provider, model: record.model, name: record.name ?? record.model, price: null, takes: [], context: 0 }

const cheapestFirst = (a: Rung, b: Rung) => (a.cost ?? Infinity) - (b.cost ?? Infinity)

/** A use's ladder. With the person's results, their score replaces the list's, and the indicated pair follows. */
export function recommendationOf(use: AiUse, tested: TestedPair[] = []): UseRecommendation {
  const { why, rungs } = LIST[use]
  const requirement = USE_REQUIREMENTS[use]
  const mine = newestByPair(tested.filter(record => record.use === use))
  const listed = new Set(rungs.map(([item]) => keyOf(item.provider, item.model)))
  const all = [
    ...rungs.map(([item, score]) => rungOf(item, score, requirement, mine.get(keyOf(item.provider, item.model)))),
    ...[...mine].filter(([key]) => !listed.has(key)).map(([, record]) => rungOf(unlistedPair(record), null, requirement, record)),
  ]
  const passes = (rung: Rung) => rung.score !== null && rung.score >= requirement.minScore && rung.cost !== null
  const ladder = all.filter(passes).sort(cheapestFirst)
  const outside = all.filter(rung => !passes(rung)).sort(cheapestFirst)
  const indicated = ladder[0] ?? null
  const from = useInfo(use).from
  const mother = from && indicated ? recommendationOf(from, tested).indicated : null
  const inherits = from && indicated && mother && keyOf(mother.pair.provider, mother.pair.model) === keyOf(indicated.pair.provider, indicated.pair.model) ? from : null
  return { use, why, indicated, ladder, outside, inherits }
}

export const RECOMMENDATIONS: UseRecommendation[] = USES.map(use => recommendationOf(use.id))

/* ---------- the defaults of the person, against the list ---------- */

export interface CurrentPair {
  uid: string
  /** The provider type, what a pair of the list is compared by. */
  provider: AiProviderId
  /** The provider the person added. */
  providerId: string
  model: string
  name: string
  /** "herda": it comes from the mother of the use (Estudo, or Vídeo e áudio). */
  inherits: boolean
  from: AiUse | null
  score: number | null
  cost: number | null
}

export type Difference =
  /** Scored below the minimum (the list's score or the person's own test). */
  | { kind: 'below'; score: number; min: number }
  | { kind: 'pricier'; times: number }
  /** Another pair, with no score or no price to compare. */
  | { kind: 'other' }
  /** No default for this use. */
  | { kind: 'unset' }

export interface UseSituation {
  use: AiUse
  label: string
  min: number
  recommendation: UseRecommendation
  current: CurrentPair | null
  same: boolean
  /** null when it is the indicated pair. */
  difference: Difference | null
}

export interface SituationOptions {
  /** The person's diagnosis (Settings.aiDiagnosis). */
  tested?: TestedPair[]
  /** The live price of a pair outside the list, from the provider's catalog (`priceFromCatalog`). */
  priceOf?: (pair: { provider: AiProviderId; providerId: string; model: string }) => Price | null | undefined
  /** Whether Questões da web may inherit this model. Default: only OpenRouter models, which search through the plugin. */
  searchesWeb?: (uid: string) => boolean
}

function currentOf(config: AiConfig, use: AiUse, recommendation: UseRecommendation, options: SituationOptions): CurrentPair | null {
  const typeOf = (uid: string) => providerById(config, modelByUid(config, uid)?.pid)?.type
  const qualifies = use === 'web' ? (options.searchesWeb ?? (uid => typeOf(uid) === 'openrouter')) : undefined
  const uid = uidFor(config, use, qualifies)
  const model = modelByUid(config, uid)
  const provider = providerById(config, model?.pid)
  if (!uid || !model || !provider) return null
  const inherits = uid !== config.defaults[use]
  const rung = [...recommendation.ladder, ...recommendation.outside].find(item => item.pair.provider === provider.type && item.pair.model === model.mid)
  const live = options.priceOf?.({ provider: provider.type, providerId: provider.id, model: model.mid })
  // A live price does not bring the fee of the search plugin.
  const price = findPair(provider.type, model.mid)?.price ?? (live?.per === 'token' && live.search === undefined && provider.type === 'openrouter' ? { ...live, search: OPENROUTER_SEARCH } : live)
  return {
    uid,
    provider: provider.type,
    providerId: provider.id,
    model: model.mid,
    name: rung?.pair.name ?? findPair(provider.type, model.mid)?.name ?? model.name,
    inherits,
    from: inherits ? (useInfo(use).from ?? null) : null,
    score: rung?.score ?? null,
    cost: rung?.cost ?? costPerNote(price, USE_REQUIREMENTS[use].ruler),
  }
}

function differenceOf(current: CurrentPair | null, indicated: Rung | null, min: number, same: boolean): Difference | null {
  if (!current) return { kind: 'unset' }
  if (same) return null
  if (current.score !== null && current.score < min) return { kind: 'below', score: current.score, min }
  if (current.cost !== null && indicated?.cost != null && current.cost > indicated.cost) return { kind: 'pricier', times: current.cost / indicated.cost }
  return { kind: 'other' }
}

/** One line per use: the indicated pair, the person's default (own or inherited) and whether they differ. */
export function situationsOf(config: AiConfig, options: SituationOptions = {}): UseSituation[] {
  return USES.map(({ id: use, label }) => {
    const recommendation = recommendationOf(use, options.tested)
    const min = USE_REQUIREMENTS[use].minScore
    const current = currentOf(config, use, recommendation, options)
    const { indicated } = recommendation
    const same = Boolean(current && indicated && current.provider === indicated.pair.provider && current.model === indicated.pair.model)
    return { use, label, min, recommendation, current, same, difference: differenceOf(current, indicated, min, same) }
  })
}
