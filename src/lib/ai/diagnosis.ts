import { type ChatContent, chatController } from '@/controllers/ai.controller'
import { type CatalogModel, fetchModelList } from '@/controllers/models.controller'
import { askOnceController } from '@/controllers/probe.controller'
import { postAudioController } from '@/controllers/transcription.controller'
import { eLista, plain } from '@/lib/ai/catalog'
import { MEDIA_LABEL, USES } from '@/lib/ai/config'
import { baseUrlOf, providerOf } from '@/lib/ai/providers'
import { costPerNote, type Price, priceFromCatalog, REASONING_FACTOR } from '@/lib/ai/recommendations'
import { type Capability, type Expected, type FormatCheck, INVENTION_CAP, type Material, materialText, type MiniTest, PT_PT_MARKS, RETEST_MARGIN, scoreOf, USE_REQUIREMENTS, type UseRequirement, werScore } from '@/lib/ai/use-requirements'
import { extractJson } from '@/lib/generation/mermaid'
import type { AiProvider, AiProviderId, AiSettings, AiUse, DiagnosisRecord } from '@/types/domain'

/**
 * "Rodar meu diagnóstico" (FR-049, FR-050, SC-010): the provider's catalog, web research by AI, miniature tests with a known answer.
 * Everything that leaves the app goes through DiagnosisDeps; `liveDiagnosisDeps` is the real one.
 */

/* ---------- the numbers ---------- */

/** One search per family of uses, tokens and fee (pesquisa.md). */
export const RESEARCH_COST = 0.008
/** SC-010: one use on a new provider stays below this. */
export const USE_BUDGET = 0.05
/** OpenRouter's `web` plugin, per search. */
const SEARCH_FEE = 0.007
/** How many researched candidates there are for each place in the tests. */
const RESEARCH_POOL = 3
/** Out-by-the-catalog results kept per use: a big catalog must not fill the settings. */
const MAX_OUT = 12
/** Each "não" of the judge. Two of them take a perfect note below the minimum. */
const JUDGE_PENALTY = 2
const JUDGE_ANSWER_TOKENS = 20
/** No real run measured how many repeat: this keeps the estimate within 20% for 0 to about a third of the models repeating. */
const RETEST_ALLOWANCE = 0.1
const CHARS_PER_TOKEN = 4

const SYSTEM_TEXT = 'Responda em português do Brasil.'
const SYSTEM_JSON = 'Responda somente em JSON, em português do Brasil.'

/** Visible tokens of a good answer, worked back from the "custo por modelo" column of pesquisa.md. */
const ANSWER_TOKENS: Record<AiUse, number> = { estudo: 1400, aula: 1500, explicacao: 1400, prova: 900, web: 300, cartoes: 600, mapa: 800, tutor: 1200, curso: 800, titulo: 50, midia: 120, transcricao: 80, tela: 60, ata: 3500 }

const VIDEO_TOKENS_PER_SECOND = USE_REQUIREMENTS.midia.ruler.input / 3600
const AUDIO_TOKENS_PER_SECOND = USE_REQUIREMENTS.midia.altRulers![0].input / 3600
const SCREEN_TOKENS = USE_REQUIREMENTS.tela.ruler.input / 20

export type Family = 'texto' | 'json' | 'visao' | 'audio' | 'video' | 'web'

const SLOTS: Record<Family, number> = { texto: 5, json: 5, visao: 3, audio: 3, video: 3, web: 3 }

const familyOf = ({ needs }: UseRequirement): Family => (needs.includes('web') ? 'web' : needs.includes('video') ? 'video' : needs.includes('audio') ? 'audio' : needs.includes('imagem') ? 'visao' : needs.includes('json') ? 'json' : 'texto')

/* ---------- the connections ---------- */

export interface DiagnosisModel {
  /** The provider the person added, where the call goes. */
  providerId: string
  provider: AiProviderId
  model: string
  name: string
  price: Price | null
  web: boolean
}

/** A fixed file, or the screen drawn for the test. */
export type Sample = { kind: 'imagem'; data: string; mime: string } | { kind: 'audio' | 'video'; data: string; mime: string; seconds: number; file: string }

export interface DiagnosisCall {
  model: DiagnosisModel
  use: AiUse
  purpose: 'teste' | 'juiz'
  system: string
  prompt: string
  sample?: Sample
  /** Turns the web search on. */
  search?: boolean
  maxTokens: number
  signal?: AbortSignal
}

export interface Cited {
  url: string
  text?: string
}

export interface DiagnosisReply {
  text: string
  usage: { inputTokens: number; outputTokens: number } | null
  /** The pages the search read. */
  cited?: Cited[]
}

export interface ResearchAsk {
  family: Family
  uses: AiUse[]
  candidates: { provider: AiProviderId; model: string; name: string }[]
  searcher: DiagnosisModel
  signal?: AbortSignal
}

export interface ResearchVerdict {
  provider: AiProviderId
  model: string
  keep: boolean
  reason?: string
}

export interface ResearchAnswer {
  /** A model it says nothing about stays in: no data is not bad data. */
  verdicts: ResearchVerdict[]
  /** US$; null when it cannot tell. */
  spent: number | null
}

export interface DiagnosisDeps {
  catalog(provider: AiProvider): Promise<CatalogModel[]>
  research(ask: ResearchAsk): Promise<ResearchAnswer>
  call(request: DiagnosisCall): Promise<DiagnosisReply>
  sample(file: string): Promise<{ data: string; mime: string } | null>
  screen(material: Extract<Material, { kind: 'tela' }>): Promise<{ data: string; mime: string } | null>
  now?: () => Date
}

/** The model does not take what the use needs: it is out, with the reason. Any other error is a failure of the moment. */
export class NoCapability extends Error {
  constructor(readonly capability: Capability) {
    super(capabilityText(capability))
  }
}

/* ---------- the plan: free, from the catalogs ---------- */

export interface UsePlan {
  use: AiUse
  family: Family
  /** New to this diagnosis, cheapest first: the research goes through all of them. */
  pool: DiagnosisModel[]
  /** How many of the pool get a test. */
  places: number
  sample?: Sample
  out: DiagnosisRecord[]
}

export interface DiagnosisEstimate {
  /** US$ of everything with a known price. */
  total: number
  research: number
  tests: number
  /** Tests whose cost is unknown: the provider gives no price ("?"). */
  unpriced: number
  byUse: { use: AiUse; tests: number; cost: number; unpriced: number }[]
}

export interface DiagnosisSkip {
  use: AiUse
  reason: string
}

export interface DiagnosisPlan {
  uses: UsePlan[]
  /** The cheap model that does the research, the same in every family; null: no research. */
  searcher: DiagnosisModel | null
  /** The cheap AI judge, the same in every test. */
  judge: DiagnosisModel | null
  estimate: DiagnosisEstimate
  skipped: DiagnosisSkip[]
  /** Providers whose catalog could not be read. */
  unread: { providerId: string; name: string; reason: string }[]
  /** Settings.aiDiagnosis before this run. */
  previous: DiagnosisRecord[]
}

export interface DiagnosisInput {
  /** Every provider the person added. */
  providers: AiProvider[]
  /** Default: all the uses. */
  uses?: AiUse[]
  /** Settings.aiDiagnosis: a result here is not repeated. */
  previous?: DiagnosisRecord[]
  /** "A pedido": repeats what is saved. */
  redo?: boolean
}

interface Listed {
  model: DiagnosisModel
  media: CatalogModel['media']
}

const keyOf = (record: { use: AiUse; provider: AiProviderId; model: string }) => JSON.stringify([record.use, record.provider, record.model])

function listedOf(provider: AiProvider, entry: CatalogModel): Listed {
  const read = priceFromCatalog(entry.price)
  const price = read?.per === 'token' && provider.type === 'openrouter' ? { ...read, search: SEARCH_FEE } : read
  return { media: entry.media, model: { providerId: provider.id, provider: provider.type, model: entry.id, name: entry.name, price, web: entry.web === true || provider.type === 'openrouter' } }
}

function capabilityText(capability: Capability): string {
  if (capability === 'web') return 'o modelo não pesquisa na web'
  if (capability === 'json') return 'o modelo não devolve JSON'
  return `o modelo não recebe ${MEDIA_LABEL[capability]}`
}

function whyOut({ model, media }: Listed, requirement: UseRequirement): string | null {
  if (model.model.endsWith(':batch')) return 'modelo :batch, que não funciona no chat do app'
  const lacking = requirement.needs.find(need => (need === 'json' ? false : need === 'web' ? !model.web : media?.[need] === false))
  if (!lacking) return null
  return lacking === 'web' ? 'o catálogo não diz que o modelo pesquisa na web' : `o catálogo diz que ${capabilityText(lacking)}`
}

const nowOf = (deps: DiagnosisDeps) => (deps.now?.() ?? new Date()).toISOString()

function recordOf(use: AiUse, model: DiagnosisModel, score: number | null, reason: string, at: string): DiagnosisRecord {
  return { use, provider: model.provider, model: model.model, score, costPerNote: costPerNote(model.price, USE_REQUIREMENTS[use].ruler), at, reason }
}

function isCurrent(known: DiagnosisRecord, model: DiagnosisModel, redo: boolean): boolean {
  if (redo) return false
  const now = costPerNote(model.price, USE_REQUIREMENTS[known.use].ruler)
  if (now === null) return true
  return known.costPerNote !== null && Math.abs(now - known.costPerNote) <= known.costPerNote * 0.001
}

const cheapestFirst = (requirement: UseRequirement) => (a: Listed, b: Listed) => {
  const [x, y] = [a, b].map(item => costPerNote(item.model.price, requirement.ruler) ?? Infinity)
  return x === y ? a.model.model.localeCompare(b.model.model) : x - y
}

interface Bill {
  in: number
  out: number
  seconds?: number
  searches: number
}

function billOf(price: Price | null, bill: Bill): number | null {
  if (!price) return null
  if (price.per === 'hour') return (price.hour * (bill.seconds ?? 0)) / 3600
  return (bill.in * price.input + bill.out * price.output) / 1e6 + bill.searches * (price.search ?? 0)
}

const tokensIn = (text: string) => Math.ceil(text.length / CHARS_PER_TOKEN)

function promptOf(test: MiniTest): string {
  return test.material.kind === 'texto' ? `${test.ask}\n\n${test.material.text}` : test.ask
}

const systemOf = (test: MiniTest) => (test.format.kind === 'json' || test.format.kind === 'tree' ? SYSTEM_JSON : SYSTEM_TEXT)

function sampleTokens(material: Material): number {
  if (material.kind === 'audio') return material.seconds * AUDIO_TOKENS_PER_SECOND
  if (material.kind === 'video') return material.seconds * VIDEO_TOKENS_PER_SECOND
  return material.kind === 'tela' ? SCREEN_TOKENS : 0
}

const secondsOf = (material: Material) => (material.kind === 'audio' || material.kind === 'video' ? material.seconds : undefined)

/** One run of the test, the judge included, with what repeats counted in. Null when the model has no price. */
export function testCost(use: AiUse, model: DiagnosisModel, judge: DiagnosisModel | null): number | null {
  const { test } = USE_REQUIREMENTS[use]
  const once = billOf(model.price, { in: tokensIn(systemOf(test) + promptOf(test)) + sampleTokens(test.material), out: ANSWER_TOKENS[use] * REASONING_FACTOR, seconds: secondsOf(test.material), searches: test.citedUrl ? 1 : 0 })
  if (once === null) return null
  const judged = test.judge && judge ? (billOf(judge.price, { in: ANSWER_TOKENS[use] + tokensIn(judgePrompt(test, '')), out: JUDGE_ANSWER_TOKENS * REASONING_FACTOR, searches: 0 }) ?? 0) : 0
  return (once + judged) * (1 + RETEST_ALLOWANCE)
}

/** Who gets a test: cheapest first, within the places and within the budget of the use. */
function chosen(models: DiagnosisModel[], use: AiUse, places: number, judge: DiagnosisModel | null, research: number): DiagnosisModel[] {
  const picked: DiagnosisModel[] = []
  let total = research
  for (const model of models) {
    if (picked.length === places) break
    const cost = testCost(use, model, judge) ?? 0
    if (total + cost >= USE_BUDGET) continue
    total += cost
    picked.push(model)
  }
  return picked
}

async function sampleOf(material: Material, deps: DiagnosisDeps): Promise<{ sample?: Sample; missing?: string }> {
  if (material.kind === 'tela') {
    const drawn = await deps.screen(material).catch(() => null)
    return drawn ? { sample: { kind: 'imagem', ...drawn } } : { missing: 'este aparelho não consegue desenhar a tela de teste' }
  }
  if (material.kind !== 'audio' && material.kind !== 'video') return {}
  const file = await deps.sample(material.file).catch(() => null)
  return file ? { sample: { kind: material.kind, ...file, seconds: material.seconds, file: material.file } } : { missing: `falta a amostra ${material.file} no app` }
}

function cheapestWhere(listed: Listed[], accepts: (item: Listed) => boolean): DiagnosisModel | null {
  const valueOf = (item: Listed) => (item.model.price?.per === 'token' ? item.model.price.input + item.model.price.output : Infinity)
  const usable = listed.filter(accepts).sort((a, b) => valueOf(a) - valueOf(b) || a.model.model.localeCompare(b.model.model))
  return usable[0]?.model ?? null
}

async function readCatalogs(providers: AiProvider[], deps: DiagnosisDeps) {
  const unread: DiagnosisPlan['unread'] = []
  const listed: Listed[] = []
  for (const provider of providers) {
    try {
      listed.push(...(await deps.catalog(provider)).map(entry => listedOf(provider, entry)))
    } catch (error) {
      unread.push({ providerId: provider.id, name: provider.name, reason: error instanceof Error ? error.message : 'não deu para ler' })
    }
  }
  return { listed, unread }
}

/** Reads the catalogs (no cost) and says what the run would cost. Nothing paid happens here. */
export async function planDiagnosis(input: DiagnosisInput, deps: DiagnosisDeps): Promise<DiagnosisPlan> {
  const previous = input.previous ?? []
  const { listed, unread } = await readCatalogs(input.providers, deps)
  const known = new Map(previous.map(record => [keyOf(record), record]))
  const judge = cheapestWhere(listed, item => item.media?.texto !== false && !item.model.model.endsWith(':batch'))
  const searcher = cheapestWhere(listed, item => item.model.web && item.model.price?.per === 'token' && item.media?.texto !== false && !item.model.model.endsWith(':batch'))
  const research = searcher ? RESEARCH_COST : 0
  const uses: UsePlan[] = []
  const skipped: DiagnosisSkip[] = []
  const at = nowOf(deps)

  for (const { id: use } of USES) {
    if (input.uses && !input.uses.includes(use)) continue
    const requirement = USE_REQUIREMENTS[use]
    const family = familyOf(requirement)
    const out: DiagnosisRecord[] = []
    const pool: DiagnosisModel[] = []
    let free = SLOTS[family]
    let places = 0
    let alreadyKnown = 0
    for (const item of [...listed].sort(cheapestFirst(requirement))) {
      const record = known.get(keyOf({ use, provider: item.model.provider, model: item.model.model }))
      if (record && isCurrent(record, item.model, Boolean(input.redo))) {
        alreadyKnown++
        if (free > 0 && record.score !== null) free--
        continue
      }
      const why = whyOut(item, requirement)
      if (why) {
        if (out.length < MAX_OUT) out.push(recordOf(use, item.model, null, `Ficou fora: ${why}.`, at))
        continue
      }
      if (free > 0) {
        free--
        places++
        pool.push(item.model)
      } else if (pool.length < places * RESEARCH_POOL) pool.push(item.model)
    }
    if (!pool.length) {
      if (!alreadyKnown) skipped.push({ use, reason: 'nenhum modelo dos provedores cadastrados faz este uso' })
      if (out.length) uses.push({ use, family, pool, places: 0, out })
      continue
    }
    const { sample, missing } = await sampleOf(requirement.test.material, deps)
    if (missing) {
      skipped.push({ use, reason: `Não testado: ${missing}.` })
      continue
    }
    if (!chosen(pool, use, places, judge, research).length) {
      skipped.push({ use, reason: `Não testado: até o teste mais barato custaria mais de US$ ${USE_BUDGET.toFixed(2).replace('.', ',')}.` })
      uses.push({ use, family, pool: [], places: 0, out })
      continue
    }
    uses.push({ use, family, pool, places, sample, out })
  }

  return { uses, searcher, judge, estimate: estimateOf(uses, judge, searcher), skipped, unread, previous }
}

function estimateOf(uses: UsePlan[], judge: DiagnosisModel | null, searcher: DiagnosisModel | null): DiagnosisEstimate {
  const research = searcher ? RESEARCH_COST : 0
  const active = uses.filter(plan => plan.pool.length)
  const byUse = active.map(({ use, pool, places }) => {
    const costs = chosen(pool, use, places, judge, research).map(model => testCost(use, model, judge))
    return { use, tests: costs.length, cost: costs.reduce<number>((sum, cost) => sum + (cost ?? 0), 0), unpriced: costs.filter(cost => cost === null).length }
  })
  const tests = byUse.reduce((sum, row) => sum + row.cost, 0)
  const families = new Set(active.map(plan => plan.family)).size
  const spentOnResearch = families * research
  return { total: spentOnResearch + tests, research: spentOnResearch, tests, unpriced: byUse.reduce((sum, row) => sum + row.unpriced, 0), byUse }
}

/* ---------- the grade: no AI ---------- */

export interface Grade {
  score: number
  found: number
  expected: number
  /** Items the answer key expected and the answer does not have. */
  missing: string[]
  inventions: string[]
  format: boolean
  ptBr: boolean
  wer?: number
  cer?: number
}

type Data = Record<string, unknown>

const isData = (value: unknown): value is Data => typeof value === 'object' && value !== null && !Array.isArray(value)

const plainWords = (text: string) => plain(text).replace(/[^\p{L}\p{N}]+/gu, ' ').trim().split(' ').filter(Boolean)

const round = (value: number) => Math.round(value * 100) / 100

function distance<T>(left: ArrayLike<T>, right: ArrayLike<T>): number {
  let row = Array.from({ length: right.length + 1 }, (_, at) => at)
  for (let at = 1; at <= left.length; at++) {
    const next = [at]
    for (let other = 1; other <= right.length; other++) next[other] = Math.min(row[other] + 1, next[other - 1] + 1, row[other - 1] + (left[at - 1] === right[other - 1] ? 0 : 1))
    row = next
  }
  return row[right.length]
}

function wordErrors(reference: string, heard: string): number {
  const words = plainWords(reference)
  return words.length ? distance(words, plainWords(heard)) / words.length : 0
}

function charErrors(reference: string, read: string): number {
  const squeeze = (text: string) => plainWords(text).join('')
  const expected = squeeze(reference)
  return expected.length ? distance([...expected], [...squeeze(read)]) / expected.length : 0
}

const has = (flat: string, forms: string[]) => forms.some(form => flat.includes(plain(form)))

/** Each row of the JSON, or each line of the text: where a task and its owner must be together. */
function blocksOf(answer: string, data: Data | null): string[] {
  if (!data) return answer.split('\n').map(plain)
  const rows: string[] = []
  const walk = (value: unknown) => {
    if (Array.isArray(value)) {
      for (const item of value) {
        if (isData(item)) rows.push(plain(JSON.stringify(item)))
        walk(item)
      }
    } else if (isData(value)) Object.values(value).forEach(walk)
  }
  walk(data)
  return rows.length ? rows : [plain(answer)]
}

function foundItem(item: Expected, flat: string, blocks: string[]): boolean {
  if (!item.together) return has(flat, item.accept)
  return blocks.some(block => has(block, item.accept) && item.together!.every(part => has(block, part)))
}

function numbersIn(text: string): string[] {
  return [...text.matchAll(/\d+(?:[.,]\d+)*/g)].map(match => match[0].replace(/,0+$/, '').replace(/[.,]/g, '').replace(/^0+(?=\d)/, ''))
}

/** What was never in the material: list numbers and step labels ("Passo 3") do not count. */
function inventedNumbers(test: MiniTest, answer: string): string[] {
  const known = new Set(
    numbersIn([materialText(test.material), test.ask, ...(test.numbers ?? []), ...test.expected.flatMap(item => [...item.accept, ...(item.together ?? []).flat()])].join(' ')),
  )
  const body = plain(answer)
    .replace(/^[ \t>*_#-]*\d+[.)][*_]*[ \t]+/gm, '')
    .replace(/\b(?:passo|etapa|parte|item|ponto|questao|pergunta|secao|capitulo|modulo)\s+\d+\b/g, ' ')
  return [...new Set(numbersIn(body))].filter(number => !known.has(number))
}

/** The `dono` of every row: only the people of the meeting. */
function inventedOwners(people: string[], data: Data | null): string[] {
  const owners: string[] = []
  const walk = (value: unknown) => {
    if (Array.isArray(value)) value.forEach(walk)
    else if (isData(value)) {
      for (const [field, inner] of Object.entries(value)) {
        if (field === 'dono' && typeof inner === 'string') owners.push(plain(inner).trim())
        else walk(inner)
      }
    }
  }
  walk(data)
  return owners.filter(owner => owner && !/^(sem\b|ninguem|nenhum|a definir|nao )/.test(owner) && !people.some(person => owner.includes(plain(person))))
}

const pageOf = (url: string) => url.trim().replace(/[?#].*$/, '').replace(/\/+$/, '').toLowerCase()

/** The share of the statement's words a page must contain to count as the source. */
const CITED_MATCH = 0.6

function inventedSource(data: Data | null, cited: Cited[]): string | null {
  if (typeof data?.url !== 'string') return null
  const page = cited.find(item => pageOf(item.url) === pageOf(data.url as string))
  if (!page) return 'a página citada, que a busca não leu'
  if (page.text === undefined || typeof data.enunciado !== 'string') return null
  const words = plainWords(data.enunciado)
  const inPage = new Set(plainWords(page.text))
  return words.filter(word => inPage.has(word)).length / Math.max(1, words.length) >= CITED_MATCH ? null : 'um enunciado que não está na página citada'
}

function inventionsOf(test: MiniTest, answer: string, data: Data | null, cited: Cited[]): string[] {
  const flat = plain(answer)
  return [
    ...test.forbidden.filter(word => flat.includes(plain(word))),
    ...(test.strictNumbers ? inventedNumbers(test, answer).map(number => `o número ${number}`) : []),
    ...(test.people ? inventedOwners(test.people, data).map(owner => `o dono ${owner}`) : []),
    ...(test.citedUrl ? [inventedSource(data, cited)].filter((item): item is string => item !== null) : []),
  ]
}

const wordCount = (text: string) => text.trim().split(/\s+/).filter(Boolean).length

function listOk(rows: unknown, list: { count: number; fields?: string[]; distinct?: string }): boolean {
  if (!Array.isArray(rows) || rows.length !== list.count) return false
  if (list.fields && !rows.every(row => isData(row) && list.fields!.every(field => field in row))) return false
  if (!list.distinct) return true
  const values = rows.map(row => (isData(row) ? row[list.distinct!] : undefined))
  if (values.every(isData)) return values.every(value => new Set(Object.values(value as Data).map(String)).size === Object.keys(value as Data).length)
  return new Set(values.map(value => plain(String(value)))).size === values.length
}

function treeOk(format: Extract<FormatCheck, { kind: 'tree' }>, data: Data | null): boolean {
  const childrenOf = (node: Data) => (Array.isArray(node[format.children]) ? (node[format.children] as unknown[]).filter(isData) : [])
  const short = (node: Data): boolean => typeof node[format.text] === 'string' && Boolean((node[format.text] as string).trim()) && wordCount(node[format.text] as string) <= format.maxWords && childrenOf(node).every(short)
  const root = data?.[format.root]
  if (!isData(root) || !short(root)) return false
  const branches = childrenOf(root)
  return branches.length >= format.branches && branches.every(branch => childrenOf(branch).length >= format.leaves)
}

function formatOk(format: FormatCheck, answer: string, data: Data | null): boolean {
  if (format.kind === 'text') return Boolean(answer.trim())
  if (format.kind === 'markdown') return (answer.match(/^#{1,6}\s+\S/gm) ?? []).length >= format.headings
  if (format.kind === 'tree') return treeOk(format, data)
  if (!data || !format.fields.every(field => field in data)) return false
  if (!Object.entries(format.lists ?? {}).every(([field, list]) => listOk(data[field], list))) return false
  if (!Object.entries(format.maxWords ?? {}).every(([field, max]) => typeof data[field] === 'string' && wordCount(data[field] as string) <= max)) return false
  return (format.exact ?? []).every(({ list, where, is }) => {
    const row = (Array.isArray(data[list]) ? (data[list] as unknown[]) : []).find(item => isData(item) && Object.entries(where).every(([field, value]) => item[field] === value))
    return isData(row) && Object.entries(is).every(([field, value]) => row[field] === value)
  })
}

const MARKS = PT_PT_MARKS.map(mark => new RegExp(`(^|[^\\p{L}])${plain(mark)}(e?s)?($|[^\\p{L}])`, 'u'))
const count = (text: string, words: RegExp) => (text.match(words) ?? []).length

function brazilian(answer: string): boolean {
  const flat = plain(answer)
  if (MARKS.some(mark => mark.test(flat))) return false
  return count(flat, /\b(the|and|of|is|are|with|this|that|for)\b/g) <= count(flat, /\b(o|a|os|as|de|do|da|e|que|em|para|com|nao|um|uma|no|na)\b/g)
}

/** The automatic part of the score (pesquisa.md: items 50%, nothing invented 30%, format 10%, Brazilian Portuguese 10%). */
export function gradeAnswer(test: MiniTest, answer: string, cited: Cited[] = []): Grade {
  const flat = plain(answer)
  const data = extractJson(answer) as Data | null
  const blocks = blocksOf(answer, data)
  const expected = test.need ?? test.expected.length
  const hit = test.expected.filter(item => foundItem(item, flat, blocks))
  const found = Math.min(hit.length, expected)
  const missing = found >= expected ? [] : test.expected.filter(item => !hit.includes(item)).map(item => item.item)
  const inventions = inventionsOf(test, answer, data, cited)
  const format = formatOk(test.format, answer, data)
  const ptBr = brazilian(answer)
  const speech = typeof data?.fala === 'string' ? data.fala : answer
  const wer = test.wer ? wordErrors(test.wer.reference, speech) : undefined
  const cer = test.cer ? charErrors(test.cer.reference, answer) : undefined
  if (test.measure === 'wer') return { score: werScore(wer ?? 1), found, expected, missing, inventions, format, ptBr, wer }
  const parts = scoreOf({ found, expected, inventions: inventions.length, format, ptBr })
  const offScript = (wer !== undefined && wer > test.wer!.max) || (cer !== undefined && cer > test.cer!.max)
  return { score: round(offScript ? Math.min(parts, INVENTION_CAP) : parts), found, expected, missing, inventions, format, ptBr, ...(wer === undefined ? {} : { wer }), ...(cer === undefined ? {} : { cer }) }
}

function judgePrompt(test: MiniTest, answer: string): string {
  const asked = (test.judge ?? []).map((question, at) => `${at + 1}. ${question}`).join('\n')
  return `Você avalia uma resposta de IA. Responda SOMENTE um JSON: {"respostas": ["sim" ou "não", uma para cada pergunta, na ordem]}.\n\nPerguntas:\n${asked}\n\nResposta avaliada:\n${answer}`
}

/** How many "não" the judge said; null when it did not answer. */
function judgeNoes(reply: string, questions: number): number | null {
  const answers = extractJson(reply)?.respostas
  if (!Array.isArray(answers) || answers.length !== questions) return null
  return answers.filter(answer => /^n/.test(plain(String(answer)).trim())).length
}

function reasonOf(grade: Grade, score: number, min: number, noes: number, repeated: boolean): string {
  const faults: string[] = []
  if (grade.inventions.length) faults.push(`inventou ${eLista(grade.inventions)}`)
  if (grade.found < grade.expected) faults.push(`faltaram ${grade.expected - grade.found} de ${grade.expected} itens`)
  if (!grade.format) faults.push('o formato veio errado')
  if (!grade.ptBr) faults.push('não escreveu em português do Brasil')
  if (grade.wer) faults.push(`errou ${Math.round(grade.wer * 100)}% das palavras`)
  if (grade.cer) faults.push(`errou ${Math.round(grade.cer * 100)}% das letras`)
  if (noes) faults.push('o juiz achou pouco claro')
  const verdict = score >= min ? 'Passou' : 'Ficou abaixo da nota mínima'
  const after = repeated ? ', na média de 2 testes' : ''
  return faults.length ? `${verdict}${after}: ${eLista(faults)}.` : `${verdict}${after}: tudo certo.`
}

/* ---------- the run ---------- */

export interface DiagnosisProgress {
  phase: 'pesquisa' | 'testes'
  done: number
  total: number
  /** US$ of everything with a known price. */
  spent: number
  use?: AiUse
  model?: string
  /** The whole updated list: what goes into Settings.aiDiagnosis. */
  records: DiagnosisRecord[]
}

export interface DiagnosisOptions {
  /** "Parar": what ran stays, and nothing else is spent. */
  signal?: AbortSignal
  onProgress?: (event: DiagnosisProgress) => void
}

export interface DiagnosisFailure {
  use: AiUse
  provider: AiProviderId
  model: string
  reason: string
}

export interface DiagnosisResult {
  /** Everything to save in Settings.aiDiagnosis: what was there, with this run's results. */
  records: DiagnosisRecord[]
  /** Only what this run produced. */
  fresh: DiagnosisRecord[]
  /** Per use: the cheapest pair at or above the minimum. */
  indicated: Partial<Record<AiUse, DiagnosisRecord>>
  /** Uses that were not tested, and why. */
  skipped: DiagnosisSkip[]
  /** Calls that failed for reasons of the moment: no result, they come back next time. */
  failed: DiagnosisFailure[]
  stopped: boolean
  spent: number
  /** Calls whose cost is unknown. */
  unpriced: number
}

/** The cheapest pair at or above the use's minimum, as recommendationOf: without a price it cannot be the cheapest. */
export function indicatedOf(records: DiagnosisRecord[], use: AiUse): DiagnosisRecord | null {
  const { minScore } = USE_REQUIREMENTS[use]
  const passing = records.filter(record => record.use === use && record.score !== null && record.score >= minScore && record.costPerNote !== null)
  return passing.sort((a, b) => a.costPerNote! - b.costPerNote! || b.score! - a.score!)[0] ?? null
}

const maxTokensOf = (use: AiUse) => Math.max(2000, ANSWER_TOKENS[use] * 6)

class Run {
  fresh: DiagnosisRecord[]
  failed: DiagnosisFailure[] = []
  spent = 0
  unpriced = 0
  done = 0
  total = 0
  readonly at: string

  constructor(
    readonly plan: DiagnosisPlan,
    readonly deps: DiagnosisDeps,
    readonly options: DiagnosisOptions,
  ) {
    this.at = nowOf(deps)
    this.fresh = plan.uses.flatMap(item => item.out)
  }

  get stopped() {
    return Boolean(this.options.signal?.aborted)
  }

  records(): DiagnosisRecord[] {
    const fresh = new Map(this.fresh.map(record => [keyOf(record), record]))
    const kept = this.plan.previous.map(record => fresh.get(keyOf(record)) ?? record)
    const known = new Set(this.plan.previous.map(keyOf))
    return [...kept, ...this.fresh.filter(record => !known.has(keyOf(record)))]
  }

  notify(phase: DiagnosisProgress['phase'], use?: AiUse, model?: string) {
    this.options.onProgress?.({ phase, done: this.done, total: this.total, spent: this.spent, ...(use ? { use } : {}), ...(model ? { model } : {}), records: this.records() })
  }

  charge(cost: number | null) {
    if (cost === null) this.unpriced++
    else this.spent += cost
  }
}

async function research(run: Run, active: UsePlan[]): Promise<Map<string, string>> {
  const dropped = new Map<string, string>()
  const { plan, deps, options } = run
  if (!plan.searcher) return dropped
  for (const family of [...new Set(active.map(item => item.family))]) {
    if (run.stopped) break
    const here = active.filter(item => item.family === family)
    const seen = new Set<string>()
    const candidates = here
      .flatMap(item => item.pool)
      .filter(model => {
        const key = `${model.provider}::${model.model}`
        return seen.has(key) ? false : Boolean(seen.add(key))
      })
      .map(({ provider, model, name }) => ({ provider, model, name }))
    try {
      const answer = await deps.research({ family, uses: here.map(item => item.use), candidates, searcher: plan.searcher, signal: options.signal })
      run.spent += answer.spent ?? RESEARCH_COST
      for (const verdict of answer.verdicts) {
        if (!verdict.keep) dropped.set(`${family}::${verdict.provider}::${verdict.model}`, verdict.reason ?? 'a pesquisa na web apontou qualidade ruim')
      }
    } catch {
      // Without the research the candidates simply stay.
      if (run.stopped) break
    }
    run.done++
    run.notify('pesquisa')
  }
  return dropped
}

interface Attempt {
  grade: Grade
  noes: number
  score: number
}

async function attempt(run: Run, item: UsePlan, model: DiagnosisModel): Promise<Attempt> {
  const { deps, options, plan } = run
  const { use } = item
  const { test } = USE_REQUIREMENTS[use]
  const reply = await deps.call({ model, use, purpose: 'teste', system: systemOf(test), prompt: promptOf(test), ...(item.sample ? { sample: item.sample } : {}), ...(test.citedUrl ? { search: true } : {}), maxTokens: maxTokensOf(use), signal: options.signal })
  const input = tokensIn(systemOf(test) + promptOf(test)) + sampleTokens(test.material)
  run.charge(billOf(model.price, { in: reply.usage?.inputTokens ?? input, out: reply.usage?.outputTokens ?? tokensIn(reply.text) * REASONING_FACTOR, seconds: secondsOf(test.material), searches: test.citedUrl ? 1 : 0 }))
  if (test.citedUrl && typeof extractJson(reply.text)?.url !== 'string') throw new NoCapability('web')
  const grade = gradeAnswer(test, reply.text, reply.cited ?? [])
  let noes = 0
  if (test.judge && plan.judge) {
    const prompt = judgePrompt(test, reply.text)
    const judged = await deps.call({ model: plan.judge, use, purpose: 'juiz', system: SYSTEM_JSON, prompt, maxTokens: 400, signal: options.signal })
    run.charge(billOf(plan.judge.price, { in: judged.usage?.inputTokens ?? tokensIn(prompt), out: judged.usage?.outputTokens ?? JUDGE_ANSWER_TOKENS * REASONING_FACTOR, searches: 0 }))
    noes = judgeNoes(judged.text, test.judge.length) ?? 0
  }
  return { grade, noes, score: round(Math.max(0, grade.score - noes * JUDGE_PENALTY)) }
}

async function testModel(run: Run, item: UsePlan, model: DiagnosisModel): Promise<void> {
  const { use } = item
  const { minScore } = USE_REQUIREMENTS[use]
  let first: Attempt
  try {
    first = await attempt(run, item, model)
  } catch (error) {
    if (run.stopped) return
    if (error instanceof NoCapability) run.fresh.push(recordOf(use, model, null, `Ficou fora: ${error.message}.`, run.at))
    else run.failed.push({ use, provider: model.provider, model: model.model, reason: error instanceof Error ? error.message : 'o modelo não respondeu' })
    return
  }
  let score = first.score
  let last = first
  let repeated = false
  if (Math.abs(first.score - minScore) <= RETEST_MARGIN && !run.stopped) {
    try {
      last = await attempt(run, item, model)
      score = round((first.score + last.score) / 2)
      repeated = true
    } catch {
      // The first result stands.
      last = first
    }
  }
  run.fresh.push(recordOf(use, model, score, reasonOf(last.grade, score, minScore, last.noes, repeated), run.at))
}

/** Researches and tests. It never throws: a stop returns what already ran, with `stopped`. */
export async function runDiagnosis(plan: DiagnosisPlan, deps: DiagnosisDeps, options: DiagnosisOptions = {}): Promise<DiagnosisResult> {
  const run = new Run(plan, deps, options)
  const active = plan.uses.filter(item => item.pool.length)
  const researchSteps = plan.searcher ? new Set(active.map(item => item.family)).size : 0
  const researchShare = plan.searcher ? RESEARCH_COST : 0
  run.total = researchSteps + active.reduce((sum, item) => sum + chosen(item.pool, item.use, item.places, plan.judge, researchShare).length, 0)
  if (!run.stopped && researchSteps) run.notify('pesquisa')
  const dropped = run.stopped ? new Map<string, string>() : await research(run, active)

  const queue = active.flatMap(item => {
    const droppedHere = (model: DiagnosisModel) => dropped.get(`${item.family}::${model.provider}::${model.model}`)
    const out = item.pool.filter(droppedHere).map(model => recordOf(item.use, model, null, droppedHere(model)!, run.at))
    run.fresh.push(...out)
    return chosen(item.pool.filter(model => !droppedHere(model)), item.use, item.places, plan.judge, researchShare).map(model => ({ item, model }))
  })
  run.total = researchSteps + queue.length

  for (const { item, model } of queue) {
    if (run.stopped) break
    await testModel(run, item, model)
    if (run.stopped && !run.fresh.some(record => record.use === item.use && record.model === model.model)) break
    run.done++
    run.notify('testes', item.use, model.model)
  }

  const records = run.records()
  const indicated: Partial<Record<AiUse, DiagnosisRecord>> = {}
  for (const { id } of USES) {
    const best = indicatedOf(records, id)
    if (best) indicated[id] = best
  }
  return { records, fresh: run.fresh, indicated, skipped: plan.skipped, failed: run.failed, stopped: run.stopped, spent: run.spent, unpriced: run.unpriced }
}

/* ---------- the real connections ---------- */

const REFUSED = /\((400|415|422)\)/

function base64(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

function mediaPart(sample: Sample, anthropic: boolean): Record<string, unknown> {
  if (sample.kind === 'imagem') return anthropic ? { type: 'image', source: { type: 'base64', media_type: sample.mime, data: sample.data } } : { type: 'image_url', image_url: { url: `data:${sample.mime};base64,${sample.data}` } }
  if (anthropic) throw new NoCapability(sample.kind)
  if (sample.kind === 'audio') return { type: 'input_audio', input_audio: { data: sample.data, format: sample.file.split('.').pop() ?? 'mp3' } }
  return { type: 'video_url', video_url: { url: `data:${sample.mime};base64,${sample.data}` } }
}

async function chatCall(target: AiSettings, request: DiagnosisCall): Promise<DiagnosisReply> {
  const anthropic = providerOf(target.provider).format === 'anthropic'
  const content: ChatContent = request.sample ? [mediaPart(request.sample, anthropic), { type: 'text', text: request.prompt }] : request.prompt
  try {
    const reply = await chatController(target, content, request.system, request.maxTokens, request.signal)
    return { text: reply.text, usage: reply.usage.estimated ? null : { inputTokens: reply.usage.inputTokens, outputTokens: reply.usage.outputTokens } }
  } catch (error) {
    if (request.sample && error instanceof Error && REFUSED.test(error.message)) throw new NoCapability(request.sample.kind)
    throw error
  }
}

const pluginOf = (target: AiSettings, results: number) => (target.provider === 'openrouter' ? { plugins: [{ id: 'web', max_results: results }] } : {})

async function searchCall(target: AiSettings, request: DiagnosisCall): Promise<DiagnosisReply> {
  const reply = await askOnceController(target, [{ type: 'text', text: `${request.system}\n\n${request.prompt}` }], request.maxTokens, pluginOf(target, 1))
  if (reply.status === 400 || reply.status === 415 || reply.status === 422) throw new NoCapability('web')
  if (reply.status < 200 || reply.status >= 300) throw new Error(`o provedor devolveu erro (${reply.status})`)
  return { text: reply.text, usage: null, cited: reply.cited.map(url => ({ url })) }
}

async function transcribeCall(target: AiSettings, request: DiagnosisCall): Promise<DiagnosisReply> {
  const sample = request.sample
  if (sample?.kind !== 'audio') throw new NoCapability('audio')
  const form = new FormData()
  const bytes = Uint8Array.from(atob(sample.data), char => char.charCodeAt(0))
  form.append('file', new Blob([bytes], { type: sample.mime }), sample.file.split('/').pop() ?? 'amostra.mp3')
  form.append('model', target.model)
  form.append('language', 'pt')
  form.append('response_format', 'json')
  const body = await postAudioController(`${baseUrlOf(target)}/audio/transcriptions`, target.apiKey, form, { the: 'O provedor', of: 'do provedor' }, request.signal)
  return { text: typeof body.text === 'string' ? body.text : '', usage: null }
}

async function researchCall(target: AiSettings, ask: ResearchAsk): Promise<ResearchAnswer> {
  const list = ask.candidates.map(item => `- ${item.model} (${item.name})`).join('\n')
  const prompt = `Pesquise agora nos placares públicos (Artificial Analysis, Arena) a qualidade destes modelos de IA para ${ask.family === 'texto' ? 'escrever em português do Brasil' : `tarefas de ${ask.family}`}.\n${list}\n\nResponda SOMENTE um JSON: {"modelos": [{"id": "<o id, igual ao da lista>", "fica": false, "motivo": "uma frase"}]}. Marque "fica": false só para o modelo com evidência de qualidade ruim. Sem dados sobre um modelo, deixe-o de fora da resposta.`
  const reply = await askOnceController(target, [{ type: 'text', text: prompt }], 4000, pluginOf(target, 5))
  if (reply.status < 200 || reply.status >= 300) throw new Error(`o provedor devolveu erro (${reply.status})`)
  const rows = extractJson(reply.text)?.modelos
  const verdicts = (Array.isArray(rows) ? rows.filter(isData) : []).flatMap(row =>
    ask.candidates
      .filter(item => item.model === row.id && typeof row.fica === 'boolean')
      .map(({ provider, model }) => ({ provider, model, keep: row.fica as boolean, ...(typeof row.motivo === 'string' ? { reason: row.motivo } : {}) })),
  )
  return { verdicts, spent: null }
}

async function loadSample(file: string): Promise<{ data: string; mime: string } | null> {
  const response = await fetch(`${import.meta.env.BASE_URL}${file}`).catch(() => null)
  // The host answers a missing file with the app's own page.
  if (!response?.ok || /text\/html/.test(response.headers.get('content-type') ?? '')) return null
  return { data: base64(new Uint8Array(await response.arrayBuffer())), mime: (response.headers.get('content-type') ?? '').split(';')[0] }
}

const PAD = 60
const CELL_WIDTH = 340
const ROW_HEIGHT = 60

/** The screen of the test, drawn from its fields: the same picture everywhere, no file. Null where there is no canvas. */
export async function drawScreen(material: Extract<Material, { kind: 'tela' }>): Promise<{ data: string; mime: string } | null> {
  const canvas = document.createElement('canvas')
  canvas.width = material.width
  canvas.height = material.height
  const paint = canvas.getContext('2d')
  if (!paint) return null
  paint.fillStyle = '#ffffff'
  paint.fillRect(0, 0, material.width, material.height)
  paint.fillStyle = '#111111'
  paint.strokeStyle = '#111111'
  paint.font = 'bold 44px sans-serif'
  paint.fillText(material.title, PAD, 90)
  paint.font = '30px sans-serif'
  material.topics.forEach((topic, at) => paint.fillText(topic, PAD, 170 + at * 50))
  paint.font = 'bold 32px sans-serif'
  paint.fillText(material.number, PAD, 350)
  paint.font = '28px sans-serif'
  material.table.forEach((row, line) =>
    row.forEach((cell, column) => {
      const [x, y] = [PAD + column * CELL_WIDTH, 420 + line * ROW_HEIGHT]
      paint.strokeRect(x, y, CELL_WIDTH, ROW_HEIGHT)
      paint.fillText(cell, x + 16, y + 40)
    }),
  )
  return { data: canvas.toDataURL('image/png').split(',')[1], mime: 'image/png' }
}

/** The connections with the real providers, for the tab. */
export function liveDiagnosisDeps(providers: AiProvider[]): DiagnosisDeps {
  const targetOf = (model: DiagnosisModel): AiSettings => {
    const provider = providers.find(item => item.id === model.providerId)
    return { provider: model.provider, baseUrl: model.provider === 'custom' ? (provider?.base ?? '') : '', apiKey: provider?.key ?? '', model: model.model }
  }
  return {
    catalog: provider => fetchModelList(provider),
    research: ask => researchCall(targetOf(ask.searcher), ask),
    call: request => {
      const target = targetOf(request.model)
      if (request.model.price?.per === 'hour') return transcribeCall(target, request)
      return request.search ? searchCall(target, request) : chatCall(target, request)
    },
    sample: loadSample,
    screen: drawScreen,
  }
}
