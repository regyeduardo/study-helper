/**
 * The languages mode kept in the person's place, Drive or Local (spec 004, FR-040; owner, 24/11: "para Drive fica no Drive, para
 * somente local fica no local"): the same answers as the server (api/internal/langs: base.go, languages.go, schedule.go), over the
 * JSON files of data-model.md › Drive e Local. Refusals are ApiErrors with the server's codes, so the screens treat both the same.
 */
import { ApiError } from '@/controllers/api.controller'
import type { AnswerBody, Area, Card, Counts, Item, LanguageDetail, LanguageSummary, LanguageText, TextRow, TextStatus } from '@/controllers/langs.controller'
import { type Content, FACETS, linesOf, sayList } from '@/lib/langs/content'
import type { LangFiles } from '@/lib/langs/files'
import type { Schedule } from '@/lib/langs/fsrs'
import { clean } from '@/lib/langs/grade'

const KNOWN: Record<string, [string, string]> = {
  en: ['Inglês', 'en-US'],
  es: ['Espanhol', 'es-ES'],
  fr: ['Francês', 'fr-FR'],
  de: ['Alemão', 'de-DE'],
  it: ['Italiano', 'it-IT'],
  ja: ['Japonês', 'ja-JP'],
  zh: ['Chinês', 'zh-CN'],
  ko: ['Coreano', 'ko-KR'],
  ru: ['Russo', 'ru-RU'],
  nl: ['Holandês', 'nl-NL'],
  sv: ['Sueco', 'sv-SE'],
}
const CODE = /^[a-z]{2,3}(-[a-z0-9]{2,8})*$/
const LOCALE = /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/
export const MAX_TEXT_CHARS = 100_000
const MAX_TITLE = 200
const FIXED_DAYS = 21
const STATES: Schedule['state'][] = ['new', 'learning', 'review', 'relearning']

type Part = 'test' | 'practice' | 'context'

interface LanguageFile {
  code: string
  name: string
  locale: string
  native: string
  createdAt: string
  equivalences: string[][]
  /** How many texts were made: their order on the language page. */
  texts: number
}

type StoredItem = Omit<Item, 'test'> & { needs: string[]; createdAt: string; updatedAt: string }

interface StoredCard {
  id: string
  itemId?: string
  type: Card['type']
  skill: Card['skill']
  reuseKey?: string
  data: Card
  covers: string[]
  needs: string[]
  createdAt: string
}

interface TextFile {
  id: string
  title: string
  body: string
  status: TextStatus
  error?: string
  model?: string
  createdAt: string
  readyAt?: string
  order: number
  items: string[]
  cards: { cardId: string; part: Part; position: number }[]
}

interface StoredAnswer {
  textId: string
  cardId: string
  stage: AnswerBody['stage']
  promptLang: AnswerBody['promptLang']
  answer: string | null
  ok: boolean | null
  retry: boolean
  rating: 1 | 2 | 3 | null
  createdAt: string
}

/** A reported card and what its remake needs. */
export interface Reported {
  part: Part
  card: Card
  model: string
  language: string
  name: string
  lines: string[]
  textItems: string[]
  item?: { id: string; label: string; kind: string; meaning: string; tests: Card[] }
}

export interface GenerationProgress {
  done: number
  total: number
  startedAt: string
  lastAt?: string
  endsAt?: string
}

export interface BrowserLangsOptions {
  now?: () => Date
  newId?: () => string
  /** The generation running now in this browser (constitution IV), for the language page. */
  generationOf?: (textId: string) => GenerationProgress | undefined
}

const refuse = (status: number, code: string, data: Record<string, unknown> = {}) => new ApiError(status, code, data)
const notFound = () => refuse(404, 'not_found')

function randomId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(12))
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
}

/** The skill of the base a card trains: ordering produces, listening listens, speaking speaks, the rest recognizes. */
function skillOf(card: Pick<StoredCard, 'type' | 'skill'>): string {
  if (card.skill === 'listen' || card.skill === 'speak') return card.skill
  return card.type === 'order' ? 'produce' : 'recognize'
}

/** FR-039 ("mesmo contexto"): the same kind of card, on the same items, about the same sentence. */
export function reuseKey(card: Card): string {
  const context = [sayList(card).join(' / '), card.text, card.answer, card.target, card.word, card.q].map(value => clean(value ?? '')).find(Boolean) ?? ''
  return `${card.type}|${[...(card.covers ?? [])].sort().join(',')}|${context}`
}

interface SkillState {
  cards: number
  fixed: number
  due: boolean
}
type States = Map<string, Map<string, SkillState>>

const fixedItem = (skills: Map<string, SkillState>) => skills.size > 0 && [...skills.values()].every(s => s.fixed >= s.cards)
const dueItem = (skills: Map<string, SkillState>) => [...skills.values()].some(s => s.due)

function validSchedule(s: Schedule | undefined): Schedule | null {
  if (!s || !STATES.includes(s.state)) return null
  const numbers = [s.step, s.stability, s.difficulty, s.scheduledDays, s.reps, s.lapses]
  if (numbers.some(n => typeof n !== 'number' || !Number.isFinite(n) || n < 0)) return null
  const stamp = (value: string | null) => {
    if (value === null || value === undefined || value === '') return null
    const time = new Date(value).getTime()
    return Number.isNaN(time) ? undefined : new Date(time).toISOString()
  }
  const dueAt = stamp(s.dueAt)
  const lastReviewAt = stamp(s.lastReviewAt)
  if (dueAt === undefined || lastReviewAt === undefined) return null
  return { state: s.state, step: s.step, stability: s.stability, difficulty: s.difficulty, dueAt, lastReviewAt, scheduledDays: s.scheduledDays, reps: s.reps, lapses: s.lapses }
}

export class BrowserLangs {
  private chain: Promise<unknown> = Promise.resolve()

  constructor(
    private readonly files: LangFiles,
    private readonly options: BrowserLangsOptions = {},
  ) {}

  private now(): Date {
    return this.options.now?.() ?? new Date()
  }

  /** One operation at a time: every change reads and writes whole files. */
  private one<T>(work: () => Promise<T>): Promise<T> {
    const run = this.chain.then(work, work)
    this.chain = run.catch(() => undefined)
    return run
  }

  private async language(code: string): Promise<LanguageFile> {
    const found = await this.files.read<LanguageFile>(`${code.toLowerCase()}/language.json`)
    if (!found) throw notFound()
    return found
  }

  private async items(code: string): Promise<Record<string, StoredItem>> {
    return (await this.files.read<Record<string, StoredItem>>(`${code}/items.json`)) ?? {}
  }

  private async cards(code: string): Promise<Record<string, StoredCard>> {
    return (await this.files.read<Record<string, StoredCard>>(`${code}/cards.json`)) ?? {}
  }

  private async schedules(code: string): Promise<Record<string, Schedule>> {
    return (await this.files.read<Record<string, Schedule>>(`${code}/schedule.json`)) ?? {}
  }

  private async text(code: string, id: string): Promise<TextFile> {
    const found = await this.files.read<TextFile>(`${code.toLowerCase()}/texts/${id}.json`)
    if (!found) throw notFound()
    return found
  }

  private async texts(code: string): Promise<TextFile[]> {
    const names = await this.files.list(`${code}/texts`)
    const all = await Promise.all(names.filter(name => name.endsWith('.json')).map(name => this.files.read<TextFile>(`${code}/texts/${name}`)))
    return all.filter((text): text is TextFile => text !== null).sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.order - b.order)
  }

  private async answers(code: string): Promise<StoredAnswer[]> {
    const months = (await this.files.list(`${code}/answers`)).filter(name => name.endsWith('.json')).sort()
    const all = await Promise.all(months.map(name => this.files.read<StoredAnswer[]>(`${code}/answers/${name}`)))
    return all.flatMap(list => list ?? [])
  }

  /** Each item answered, each skill: cards answered, cards fixed, whether one is due (or still in the short steps). */
  private async states(code: string, now: Date): Promise<States> {
    const [cards, schedules] = await Promise.all([this.cards(code), this.schedules(code)])
    const out: States = new Map()
    for (const [cardId, s] of Object.entries(schedules)) {
      const card = cards[cardId]
      if (!card || s.state === 'new') continue
      const skill = skillOf(card)
      for (const item of card.covers) {
        const skills = out.get(item) ?? new Map<string, SkillState>()
        out.set(item, skills)
        const state = skills.get(skill) ?? { cards: 0, fixed: 0, due: false }
        skills.set(skill, state)
        state.cards++
        if (s.state === 'review' && s.scheduledDays >= FIXED_DAYS) state.fixed++
        if (s.state !== 'review' || (s.dueAt !== null && new Date(s.dueAt).getTime() <= now.getTime())) state.due = true
      }
    }
    return out
  }

  private async counts(code: string, now: Date, states?: States): Promise<Counts> {
    const items = Object.keys(await this.items(code)).length
    const all = states ?? (await this.states(code, now))
    let fixed = 0
    let due = 0
    for (const skills of all.values()) {
      if (fixedItem(skills)) fixed++
      if (dueItem(skills)) due++
    }
    return { items, seen: all.size, fixed, due }
  }

  listLanguages(): Promise<LanguageSummary[]> {
    return this.one(async () => {
      const now = this.now()
      const codes = await this.files.list('')
      const languages = (await Promise.all(codes.map(code => this.files.read<LanguageFile>(`${code}/language.json`)))).filter((l): l is LanguageFile => l !== null)
      languages.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.code.localeCompare(b.code))
      return Promise.all(
        languages.map(async l => ({
          code: l.code,
          name: l.name,
          locale: l.locale,
          texts: (await this.files.list(`${l.code}/texts`)).length,
          ...(await this.counts(l.code, now)),
        })),
      )
    })
  }

  addLanguage(body: { code: string; name?: string; locale?: string }): Promise<{ code: string; name: string; locale: string }> {
    return this.one(async () => {
      const code = body.code.trim().toLowerCase()
      const name = (body.name ?? '').trim()
      const locale = (body.locale ?? '').trim()
      if (code.length > 12 || !CODE.test(code) || [...name].length > 40 || (locale && (locale.length > 20 || !LOCALE.test(locale)))) throw refuse(422, 'invalid_language')
      const known = KNOWN[code]
      if (!known && !name) throw refuse(422, 'invalid_language')
      const language = { code, name: name || known[0], locale: locale || (known ? known[1] : code) }
      if (await this.files.read(`${code}/language.json`)) throw refuse(409, 'language_exists')
      const file: LanguageFile = { ...language, native: 'pt', createdAt: this.now().toISOString(), equivalences: [], texts: 0 }
      await this.files.write(`${code}/language.json`, file)
      return language
    })
  }

  getLanguage(code: string): Promise<LanguageDetail> {
    return this.one(async () => {
      const l = await this.language(code)
      const now = this.now()
      const states = await this.states(l.code, now)
      const items = await this.items(l.code)
      const areas: LanguageDetail['areas'] = {}
      for (const [id, item] of Object.entries(items)) {
        const area = (areas[item.area as Area] ??= { total: 0, seen: 0, fixed: 0 })
        area.total++
        const skills = states.get(id)
        if (skills) {
          area.seen++
          if (fixedItem(skills)) area.fixed++
        }
      }
      const texts: TextRow[] = []
      for (const t of await this.texts(l.code)) {
        const progress = await this.files.read<{ state: { done?: boolean } }>(`${l.code}/progress/${t.id}.json`)
        const known = t.items.length ? Math.floor((t.items.filter(id => states.has(id) && !dueItem(states.get(id)!)).length * 100) / t.items.length) : 0
        const generation = t.status === 'generating' ? this.options.generationOf?.(t.id) : undefined
        texts.push({
          id: t.id,
          title: t.title,
          status: t.status,
          ...(t.error ? { error: t.error } : {}),
          progress: !progress ? 'start' : progress.state?.done ? 'done' : 'continue',
          known,
          createdAt: t.createdAt,
          ...(generation ? { generation } : {}),
        })
      }
      return { code: l.code, name: l.name, locale: l.locale, ...(await this.counts(l.code, now, states)), areas, texts }
    })
  }

  addText(code: string, body: { title: string; text: string }): Promise<{ id: string; status: TextStatus }> {
    return this.one(async () => {
      let title = body.title.trim()
      if (!title) throw refuse(422, 'title_required')
      if ([...title].length > MAX_TITLE) title = [...title].slice(0, MAX_TITLE).join('')
      if (!body.text.trim()) throw refuse(422, 'text_required')
      if ([...body.text].length > MAX_TEXT_CHARS) throw refuse(413, 'text_too_large', { maxLength: MAX_TEXT_CHARS })
      const l = await this.language(code)
      const id = this.options.newId?.() ?? randomId()
      l.texts = (l.texts ?? 0) + 1
      const text: TextFile = { id, title, body: body.text, status: 'generating', createdAt: this.now().toISOString(), order: l.texts, items: [], cards: [] }
      await this.files.write(`${l.code}/texts/${id}.json`, text)
      await this.files.write(`${l.code}/language.json`, l)
      return { id, status: 'generating' as const }
    })
  }

  getText(code: string, id: string): Promise<LanguageText> {
    return this.one(async () => {
      const l = await this.language(code)
      const t = await this.text(l.code, id)
      if (t.status !== 'ready') throw refuse(409, 'not_ready', { status: t.status, ...(t.error ? { error: t.error } : {}) })
      const [stored, cards, schedules] = await Promise.all([this.items(l.code), this.cards(l.code), this.schedules(l.code)])
      const itemOf = (itemId: string): Item | null => {
        const s = stored[itemId]
        if (!s) return null
        const { needs, createdAt: _c, updatedAt: _u, ...rest } = s
        return { ...rest, ...(needs.length ? { needs } : {}), test: [] }
      }
      const items: Record<string, Item> = {}
      for (const itemId of t.items) {
        const item = itemOf(itemId)
        if (item) items[itemId] = item
      }
      const practice: Card[] = []
      const context: Card[] = []
      for (const link of [...t.cards].sort((a, b) => a.position - b.position)) {
        const card = cards[link.cardId]
        if (!card) continue
        if (link.part === 'test') {
          if (card.itemId && items[card.itemId]) items[card.itemId].test.push(card.data)
        } else (link.part === 'practice' ? practice : context).push(card.data)
      }
      // US3/AC1: what the text's items need, to the end, and the text does not have: items of the base, each with its test cards
      const needed: Record<string, Item> = {}
      const queue = Object.values(items).flatMap(item => item.needs ?? [])
      const seen = new Set<string>()
      while (queue.length) {
        const itemId = queue.shift()!
        if (items[itemId] || seen.has(itemId)) continue
        seen.add(itemId)
        const item = itemOf(itemId)
        if (!item) continue
        item.test = Object.values(cards)
          .filter(card => card.itemId === itemId)
          .sort((a, b) => a.id.localeCompare(b.id))
          .map(card => card.data)
        needed[itemId] = item
        queue.push(...(item.needs ?? []))
      }
      const shown: Record<string, Schedule> = {}
      for (const card of [...Object.values(items), ...Object.values(needed)].flatMap(item => item.test).concat(practice, context)) {
        if (schedules[card.id]) shown[card.id] = schedules[card.id]
      }
      return {
        id,
        language: l.code,
        locale: l.locale,
        title: t.title,
        status: 'ready' as const,
        lines: linesOf(t.body),
        equivalences: l.equivalences,
        items,
        practice,
        context,
        facets: FACETS,
        needed,
        schedules: shown,
      }
    })
  }

  retryText(code: string, id: string): Promise<{ status: TextStatus }> {
    return this.one(async () => {
      const l = await this.language(code)
      const t = await this.text(l.code, id)
      if (t.status !== 'failed') throw refuse(409, 'not_failed')
      delete t.error
      t.status = 'generating'
      await this.files.write(`${l.code}/texts/${id}.json`, t)
      return { status: 'generating' as const }
    })
  }

  /** Marks a text that could not be generated, with the reason (a code, not a sentence). */
  failText(code: string, id: string, reason: string): Promise<void> {
    return this.one(async () => {
      const t = await this.text(code, id)
      t.status = 'failed'
      t.error = reason
      await this.files.write(`${code}/texts/${id}.json`, t)
    })
  }

  /** Takes the text away; its items, cards, schedules and answers stay in the base (FR-040). */
  deleteText(code: string, id: string): Promise<void> {
    return this.one(async () => {
      const l = await this.language(code)
      await this.text(l.code, id)
      await this.files.remove(`${l.code}/texts/${id}.json`)
      await this.files.remove(`${l.code}/progress/${id}.json`)
    })
  }

  /** The texts left generating (the tab closed in the middle): they go back to the queue. */
  pendingTexts(): Promise<{ code: string; id: string }[]> {
    return this.one(async () => {
      const out: { code: string; id: string; at: string; order: number }[] = []
      for (const code of await this.files.list('')) {
        for (const t of await this.texts(code)) if (t.status === 'generating') out.push({ code, id: t.id, at: t.createdAt, order: t.order })
      }
      return out.sort((a, b) => a.at.localeCompare(b.at) || a.order - b.order).map(({ code, id }) => ({ code, id }))
    })
  }

  /** The text and its language's name, for the generation. */
  source(code: string, id: string): Promise<{ name: string; body: string }> {
    return this.one(async () => {
      const l = await this.language(code)
      return { name: l.name, body: (await this.text(l.code, id)).body }
    })
  }

  /** Every item of the language (id → what it needs) and a short list of them, for the generation to reuse their ids. */
  base(code: string): Promise<{ graph: Record<string, string[]>; list: { id: string; area: string; kind: string; label: string; needs: string[] }[]; equivalences: string[][] }> {
    return this.one(async () => {
      const l = await this.language(code)
      const items = await this.items(l.code)
      const list = Object.entries(items)
        .sort(([a, x], [b, y]) => x.createdAt.localeCompare(y.createdAt) || a.localeCompare(b))
        .map(([id, item]) => ({ id, area: item.area, kind: item.kind, label: item.label, needs: item.needs }))
      return { graph: Object.fromEntries(list.map(item => [item.id, item.needs])), list, equivalences: l.equivalences }
    })
  }

  /** Keeps what was generated for a text, and the text is ready (SaveContent of base.go). */
  saveContent(code: string, textId: string, content: Content, model: string): Promise<void> {
    return this.one(async () => {
      const l = await this.language(code)
      const t = await this.text(l.code, textId)
      const at = this.now().toISOString()
      const [items, cards, texts] = await Promise.all([this.items(l.code), this.cards(l.code), this.texts(l.code)])
      const ids = Object.keys(content.items)
      for (const id of ids) {
        const { test: _test, needs, ...item } = content.items[id]
        items[id] = { ...item, needs: needs ?? [], createdAt: items[id]?.createdAt ?? at, updatedAt: at }
      }
      l.equivalences = merged(l.equivalences, content.equivalences ?? [])
      // the practice cards of texts before 24/11 have no key: they get one now (the first with a key keeps it)
      const byKey = new Map<string, string>()
      for (const card of Object.values(cards)) if (card.reuseKey) byKey.set(card.reuseKey, card.id)
      const practiceIds = new Set(texts.flatMap(other => other.cards.filter(link => link.part === 'practice').map(link => link.cardId)))
      for (const card of Object.values(cards).sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))) {
        if (card.reuseKey || !practiceIds.has(card.id)) continue
        const key = reuseKey(card.data)
        if (!byKey.has(key)) {
          card.reuseKey = key
          byKey.set(key, card.id)
        }
      }
      t.items = ids
      t.cards = []
      const put = (part: Part, item: string, original: Card) => {
        const card: Card = { ...original }
        if (part === 'test' && !card.covers?.length) card.covers = [item]
        let key = ''
        if (part === 'practice') {
          key = reuseKey(card)
          const existing = byKey.get(key)
          if (existing) {
            card.id = existing
            key = ''
          } else card.id = `${textId}.${card.id}`
        } else if (part === 'context') card.id = `${textId}.${card.id}`
        if (key || part !== 'practice') {
          const before = cards[card.id]
          const union = (a: string[] = [], b: string[] = []) => [...new Set([...a, ...b])]
          cards[card.id] = {
            id: card.id,
            ...(item ? { itemId: item } : {}),
            type: card.type,
            skill: card.skill,
            ...(before?.reuseKey || key ? { reuseKey: before?.reuseKey || key } : {}),
            data: card,
            covers: union(before?.covers, card.covers),
            needs: union(before?.needs, card.needs),
            createdAt: before?.createdAt ?? at,
          }
          if (key) byKey.set(key, card.id)
        }
        if (!t.cards.some(link => link.cardId === card.id)) t.cards.push({ cardId: card.id, part, position: t.cards.length })
      }
      for (const id of ids) for (const card of content.items[id].test ?? []) put('test', id, card)
      for (const card of content.practice ?? []) put('practice', '', card)
      for (const card of content.context ?? []) put('context', '', card)
      t.status = 'ready'
      delete t.error
      t.model = model
      t.readyAt = at
      await this.files.write(`${l.code}/items.json`, items)
      await this.files.write(`${l.code}/cards.json`, cards)
      await this.files.write(`${l.code}/language.json`, l)
      await this.files.write(`${l.code}/texts/${textId}.json`, t)
    })
  }

  /** The reported card, with what its remake needs (report.go `reported`): its item when it is a test card, the text's lines. */
  reported(code: string, textId: string, cardId: string): Promise<Reported> {
    return this.one(async () => {
      const l = await this.language(code)
      const t = await this.text(l.code, textId)
      const link = t.cards.find(found => found.cardId === cardId)
      const cards = await this.cards(l.code)
      if (!link || !cards[cardId]) throw notFound()
      const card = cards[cardId]
      const out: Reported = { part: link.part, card: card.data, model: t.model ?? '', language: l.code, name: l.name, lines: linesOf(t.body), textItems: t.items }
      const stored = link.part === 'test' && card.itemId ? (await this.items(l.code))[card.itemId] : undefined
      if (card.itemId && stored) {
        const tests = Object.values(cards)
          .filter(other => other.itemId === card.itemId)
          .sort((a, b) => a.id.localeCompare(b.id))
          .map(other => other.data)
        out.item = { id: card.itemId, label: stored.label, kind: stored.kind, meaning: stored.meaning, tests }
      }
      return out
    })
  }

  /**
   * The item's new test cards (report.go `replaceItemTests`, here only for this person): a card that keeps its id (item__n) keeps its
   * schedule; one left over goes away; every text with the item uses the new ones, where the old ones were.
   */
  replaceItemTests(code: string, item: string, tests: Card[]): Promise<void> {
    return this.one(async () => {
      const l = await this.language(code)
      const [cards, schedules, texts] = await Promise.all([this.cards(l.code), this.schedules(l.code), this.texts(l.code)])
      const old = new Set(Object.values(cards).filter(card => card.itemId === item).map(card => card.id))
      const keep = new Set(tests.map(card => card.id))
      const at = this.now().toISOString()
      for (const id of old) {
        if (keep.has(id)) continue
        delete cards[id]
        delete schedules[id]
      }
      for (const card of tests) {
        cards[card.id] = { id: card.id, itemId: item, type: card.type, skill: card.skill, data: card, covers: [item], needs: [], createdAt: cards[card.id]?.createdAt ?? at }
      }
      for (const t of texts) {
        if (!t.items.includes(item)) continue
        const where = t.cards.filter(link => old.has(link.cardId)).map(link => link.position)
        const position = where.length ? Math.min(...where) : t.cards.length
        t.cards = t.cards.filter(link => !old.has(link.cardId) || keep.has(link.cardId))
        for (const card of tests) if (!t.cards.some(link => link.cardId === card.id)) t.cards.push({ cardId: card.id, part: 'test', position })
        await this.files.write(`${l.code}/texts/${t.id}.json`, t)
      }
      await this.files.write(`${l.code}/cards.json`, cards)
      await this.files.write(`${l.code}/schedule.json`, schedules)
    })
  }

  /** A card of the text's own sentences made again: the same id, in the same place, with its new content. */
  replaceCard(code: string, card: Card): Promise<void> {
    return this.one(async () => {
      const l = await this.language(code)
      const cards = await this.cards(l.code)
      const before = cards[card.id]
      if (!before) throw notFound()
      cards[card.id] = { ...before, type: card.type, skill: card.skill, data: card, covers: card.covers ?? [], needs: card.needs ?? [] }
      await this.files.write(`${l.code}/cards.json`, cards)
    })
  }

  /** Keeps the answer, with its FSRS rating, and the card's schedule the app computed (FR-025, FR-029). */
  recordAnswer(code: string, body: AnswerBody): Promise<void> {
    return this.one(async () => {
      if (!['test', 'practice', 'context'].includes(body.stage) || !['native', 'target'].includes(body.promptLang)) throw refuse(422, 'invalid_answer')
      const l = await this.language(code)
      await this.text(l.code, body.textId)
      const cards = await this.cards(l.code)
      if (!cards[body.cardId]) throw notFound()
      const schedule = body.ok !== null && body.schedule ? validSchedule(body.schedule) : null
      if (body.ok !== null && body.schedule && !schedule) throw refuse(422, 'invalid_answer')
      const now = this.now()
      const at = now.toISOString()
      const path = `${l.code}/answers/${at.slice(0, 7)}.json`
      const month = (await this.files.read<StoredAnswer[]>(path)) ?? []
      month.push({
        textId: body.textId,
        cardId: body.cardId,
        stage: body.stage,
        promptLang: body.promptLang,
        answer: body.answer || null,
        ok: body.ok,
        retry: Boolean(body.retry),
        rating: body.ok === null ? null : !body.ok ? 1 : body.retry ? 2 : 3,
        createdAt: at,
      })
      await this.files.write(path, month)
      if (schedule) {
        const schedules = await this.schedules(l.code)
        schedules[body.cardId] = schedule
        await this.files.write(`${l.code}/schedule.json`, schedules)
      }
    })
  }

  /** The base by item: each skill seen ("learning", or "fixed" when all its cards are), whether a review is due, "hearsAndSpeaks". */
  getKnowledge(code: string): Promise<Record<string, Record<string, string | boolean>>> {
    return this.one(async () => {
      const l = await this.language(code)
      const states = await this.states(l.code, this.now())
      const out: Record<string, Record<string, string | boolean>> = {}
      for (const [item, skills] of states) {
        const entry: Record<string, string | boolean> = { due: dueItem(skills) }
        for (const [skill, s] of skills) entry[skill] = s.fixed === s.cards ? 'fixed' : 'learning'
        out[item] = entry
      }
      // FR-031: 2 different listening cards and 2 speaking ones, each skill on at least 2 different days (each card is a situation)
      const cards = await this.cards(l.code)
      const passed = new Map<string, { cards: Set<string>; days: Set<string> }>()
      for (const a of await this.answers(l.code)) {
        const card = cards[a.cardId]
        if (a.ok !== true || !card || (card.skill !== 'listen' && card.skill !== 'speak')) continue
        for (const item of card.covers) {
          const key = `${item}\u0000${card.skill}`
          const entry = passed.get(key) ?? { cards: new Set<string>(), days: new Set<string>() }
          passed.set(key, entry)
          entry.cards.add(a.cardId)
          entry.days.add(a.createdAt.slice(0, 10))
        }
      }
      const both = (item: string, skill: string) => {
        const entry = passed.get(`${item}\u0000${skill}`)
        return Boolean(entry && entry.cards.size >= 2 && entry.days.size >= 2)
      }
      for (const item of Object.keys(out)) if (both(item, 'listen') && both(item, 'speak')) out[item].hearsAndSpeaks = true
      return out
    })
  }

  getProgress(code: string, id: string): Promise<{ state: Record<string, unknown>; updatedAt: string }> {
    return this.one(async () => {
      const l = await this.language(code)
      await this.text(l.code, id)
      const found = await this.files.read<{ state: Record<string, unknown>; updatedAt: string }>(`${l.code}/progress/${id}.json`)
      if (!found) throw notFound()
      return found
    })
  }

  saveProgress(code: string, id: string, state: Record<string, unknown>): Promise<void> {
    return this.one(async () => {
      if (!state || typeof state !== 'object' || Array.isArray(state) || JSON.stringify(state).length > 256 << 10) throw refuse(422, 'invalid_answer')
      const l = await this.language(code)
      await this.text(l.code, id)
      await this.files.write(`${l.code}/progress/${id}.json`, { state, updatedAt: this.now().toISOString() })
    })
  }
}

/** The language's equivalences gain the new groups: a form already known joins its group (a form is in one group only). */
function merged(before: string[][], groups: string[][]): string[][] {
  const out = before.map(group => [...group])
  for (const group of groups) {
    const forms = group.map(form => form.trim().toLowerCase()).filter(Boolean)
    if (forms.length < 2) continue
    let target = out.find(existing => forms.some(form => existing.includes(form)))
    if (!target) {
      target = []
      out.push(target)
    }
    for (const form of forms) if (!out.some(existing => existing.includes(form))) target.push(form)
  }
  return out
}
