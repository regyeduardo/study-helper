import type { Card, Item, LanguageText } from '@/controllers/langs.controller'
import { isDue, type Schedule } from '@/lib/langs/fsrs'
import { newSlot, type Slot } from '@/lib/langs/listen'

/**
 * The study of a text (spec 004), as in the prototype the owner validated (prototipo/web/app.js), in three parts (25/11, FR-041):
 * Vocabulário (test and teach) → Prática (read and listen) → Contexto. Nobody says what they know: the app tests each item of the
 * text; a wrong answer goes down to what the item needs and was not proven, teaches it (the learn card) and tests again another way,
 * up to 3 times. What the base already proved, with no review due, is skipped; what is due comes as a review. In each part, what the
 * person needs first comes first, as in Anki (due reviews, then learning, then new), drawn at random inside each group (FR-042); the
 * parts can be switched at any time and each one keeps where it stopped (FR-043).
 */

/** The base of the language as the server gives it (`GET …/knowledge`): each item's skills and whether a review is due. */
export type Knowledge = Record<string, Record<string, string | boolean>>
export type PromptLang = 'native' | 'target'
export const MAX_TRIES = 3

/** The cards this study shows; speaking comes with its own delivery. */
export const SHOWN: Card['type'][] = ['mc', 'tf', 'gap', 'order', 'match', 'odd', 'listen_mc', 'minimal_pair', 'same_diff', 'find_diff', 'stress', 'dictation', 'dictation_gap']
const shown = (card: Card) => SHOWN.includes(card.type)

interface Entry {
  slot: Slot
  /** The language the question came in, fixed once shown. */
  lang?: PromptLang
}
export interface TestEntry extends Entry {
  t: 'test' | 'teach'
  id: string
  /** Which try (0, 1, 2): each one uses another test card of the item. */
  n: number
  /** The item's card the first try uses (drawn, or the one due); the next tries take the next ones. */
  k?: number
  review?: boolean
}
export interface CardEntry extends Entry {
  id: string
  retry?: boolean
}
export interface Outcome {
  id: string
  ok: boolean | null
  stage: 'test' | 'practice' | 'context'
  retry?: boolean
  lang?: PromptLang
}

export type Part = 'test' | 'practice' | 'context'
export const PARTS: Part[] = ['test', 'practice', 'context']

export interface StudyState {
  v: 2
  step: Part | 'done'
  pq: TestEntry[]
  pp: number
  proven: Record<string, boolean>
  queue: CardEntry[]
  pos: number
  ctx: CardEntry[]
  cpos: number
  results: Outcome[]
  enWrong: number
  ptMode: boolean
  ptRight: number
  /** The server reads it to say "terminado" on the language page. */
  done?: boolean
}

export type Current =
  | { kind: 'done' }
  | { kind: 'teach'; id: string; item: Item; position: number; total: number }
  | { kind: 'card'; stage: 'test' | 'practice' | 'context'; card: Card; entry: TestEntry | CardEntry; position: number; total: number; review?: boolean; again?: boolean }

/** Proven in the base: a skill seen and no review due. */
export function fromBase(knowledge: Knowledge, id: string): boolean {
  const entry = knowledge[id]
  return Boolean(entry) && !entry.due && Object.keys(entry).some(skill => skill !== 'due')
}

/** An item of the text, or one it needs that came from another text. */
const itemOf = (text: LanguageText, id: string): Item | undefined => text.items[id] ?? text.needed?.[id]
const testCards = (text: LanguageText, id: string) => (itemOf(text, id)?.test ?? []).filter(shown)
const proven = (state: StudyState, knowledge: Knowledge, id: string) => Boolean(state.proven[id]) || fromBase(knowledge, id)

/** The card of a try: the item's cards in turn, from the one the first try drew. */
const cardOf = (cards: Card[], entry: TestEntry) => cards[((entry.k ?? 0) + entry.n) % cards.length]

function testEntry(text: LanguageText, id: string, n: number, review = false, k = 0): TestEntry {
  const cards = testCards(text, id)
  const entry: TestEntry = { t: 'test', id, n, ...(k ? { k } : {}), ...(review ? { review } : {}), slot: {} }
  if (cards.length) entry.slot = newSlot(cardOf(cards, entry))
  return entry
}

/** FR-039: a card reused from another text that is already in review and not due waits for its day (it comes back as a review). */
const waiting = (schedule: Schedule | undefined, now: Date) => schedule?.state === 'review' && !isDue(schedule, now)

/** FR-042, what the person needs first, as in Anki: 0 a due review, 1 learning (the short steps), 2 new (or not due). */
const NEW = 2
function need(schedule: Schedule | undefined, now: Date): number {
  if (schedule?.state === 'review') return isDue(schedule, now) ? 0 : NEW
  return schedule?.state === 'learning' || schedule?.state === 'relearning' ? 1 : NEW
}

/** Shuffled with the given draw; a draw of 0 keeps the order (the tests use it). */
function shuffled<T>(list: T[], random: () => number): T[] {
  const out = [...list]
  for (let i = 0; i < out.length - 1; i++) {
    const j = i + Math.floor(random() * (out.length - i))
    ;[out[i], out[j]] = [out[j], out[i]]
  }
  return out
}

/** By need, each group drawn at random: the card type never decides the sequence (owner, 25/11). */
function byNeed<T>(list: T[], needOf: (value: T) => number, random: () => number): T[] {
  const groups: T[][] = [[], [], []]
  for (const value of list) groups[needOf(value)].push(value)
  return groups.flatMap(group => shuffled(group, random))
}

export function startStudy(text: LanguageText, knowledge: Knowledge, now = new Date(), random: () => number = Math.random): StudyState {
  const items = Object.keys(text.items).filter(id => testCards(text, id).length && !fromBase(knowledge, id))
  // an item's need is its neediest card's; seen in the base with a review due by a card of another text, it is a review
  const needs = Object.fromEntries(
    items.map(id => {
      const own = testCards(text, id).map(card => need(text.schedules?.[card.id], now))
      const best = Math.min(...own)
      return [id, { need: best === NEW && knowledge[id]?.due ? 0 : best, own, best }]
    }),
  )
  const pq = byNeed(items, id => needs[id].need, random).map(id => {
    // the first try takes the card that is due (or learning); a new item, any of its cards
    const { own, best } = needs[id]
    return testEntry(text, id, 0, Boolean(knowledge[id]?.due), best < NEW ? own.indexOf(best) : Math.floor(random() * own.length))
  })
  const entry = (card: Card): CardEntry => ({ id: card.id, slot: newSlot(card) })
  const practice = text.practice.filter(card => shown(card) && !waiting(text.schedules?.[card.id], now))
  return settle({
    v: 2,
    step: 'test',
    pq,
    pp: 0,
    proven: {},
    queue: byNeed(practice, card => need(text.schedules?.[card.id], now), random).map(entry),
    pos: 0,
    // the comprehension questions keep their order (literal first)
    ctx: text.context.filter(shown).map(entry),
    cpos: 0,
    results: [],
    enWrong: 0,
    ptMode: false,
    ptRight: 0,
  })
}

/** A progress kept before still is this study (the one of delivery 1, only listening, starts again). */
export function fitsStudy(state: unknown): state is StudyState {
  const s = state as StudyState
  return Boolean(s && s.v === 2 && Array.isArray(s.pq) && Array.isArray(s.queue) && Array.isArray(s.ctx) && typeof s.pp === 'number')
}

/** How many cards are left in a part. */
export function partLeft(state: StudyState, part: Part): number {
  if (part === 'test') return Math.max(0, state.pq.length - state.pp)
  if (part === 'practice') return Math.max(0, state.queue.length - state.pos)
  return Math.max(0, state.ctx.length - state.cpos)
}

/** A finished part hands over to the next one with something left (going round); the study ends when all are finished. */
function settle(state: StudyState): StudyState {
  // kept before 25/11, in the part of the sentences: it goes on in the Vocabulário
  if ((state.step as string) === 'lines') state.step = 'test'
  if (state.step !== 'done' && !partLeft(state, state.step)) {
    const at = PARTS.indexOf(state.step)
    state.step = [...PARTS.slice(at + 1), ...PARTS.slice(0, at)].find(part => partLeft(state, part) > 0) ?? 'done'
  }
  if (state.step === 'done') state.done = true
  return state
}

/** FR-043: the person switches part at any time; each one goes on where it stopped. A finished part does not open again. */
export function goTo(state: StudyState, part: Part): StudyState {
  return partLeft(state, part) > 0 ? { ...state, step: part } : state
}

export function currentOf(state: StudyState, text: LanguageText): Current {
  if (state.step === 'test') {
    const entry = state.pq[state.pp]
    const item = entry && itemOf(text, entry.id)
    if (!entry || !item) return { kind: 'done' }
    const position = state.pp + 1
    if (entry.t === 'teach') return { kind: 'teach', id: entry.id, item, position, total: state.pq.length }
    const cards = testCards(text, entry.id)
    return { kind: 'card', stage: 'test', card: cardOf(cards, entry), entry, position, total: state.pq.length, review: entry.review, again: entry.n > 0 }
  }
  if (state.step === 'practice') {
    const entry = state.queue[state.pos]
    const card = entry && text.practice.find(item => item.id === entry.id)
    if (!card) return { kind: 'done' }
    return { kind: 'card', stage: 'practice', card, entry, position: state.pos + 1, total: state.queue.length, again: entry.retry }
  }
  if (state.step === 'context') {
    const entry = state.ctx[state.cpos]
    const card = entry && text.context.find(item => item.id === entry.id)
    if (!card) return { kind: 'done' }
    return { kind: 'card', stage: 'context', card, entry, position: state.cpos + 1, total: state.ctx.length }
  }
  return { kind: 'done' }
}

/** FR-024: in the studied language when everything the question uses was proven; back to Portuguese after 2 wrong, until 2 right. */
export function langOf(card: Card, state: StudyState, knowledge: Knowledge): PromptLang {
  if (!card.qEn || state.ptMode) return 'native'
  return (card.needs ?? []).every(id => proven(state, knowledge, id)) ? 'target' : 'native'
}

const copy = (state: StudyState): StudyState => ({
  ...state,
  pq: state.pq.map(entry => ({ ...entry })),
  proven: { ...state.proven },
  queue: state.queue.map(entry => ({ ...entry })),
  ctx: state.ctx.map(entry => ({ ...entry })),
  results: [...state.results],
})

/** The state after answering the card shown now. `ok: null` (skipped) only moves on. */
export function answer(before: StudyState, text: LanguageText, knowledge: Knowledge, ok: boolean | null, lang: PromptLang): StudyState {
  const state = copy(before)
  const now = currentOf(before, text)
  if (now.kind !== 'card') return before
  if (ok !== null) {
    if (lang === 'target') {
      if (ok) state.enWrong = 0
      else if (++state.enWrong >= 2) {
        state.ptMode = true
        state.ptRight = 0
      }
    } else if (state.ptMode) {
      if (ok) {
        if (++state.ptRight >= 2) {
          state.ptMode = false
          state.enWrong = 0
        }
      } else state.ptRight = 0
    }
  }
  if (ok && lang === 'target') for (const id of now.card.needs ?? []) state.proven[id] = true

  if (now.stage === 'test') {
    const entry = state.pq[state.pp]
    entry.lang = lang
    state.results.push({ id: now.card.id, ok, stage: 'test', retry: entry.n > 0, lang })
    if (ok) state.proven[entry.id] = true
    else if (ok === false && entry.n + 1 < MAX_TRIES) {
      // what the item needs and was not proven is tested first (moved up if it was coming later), then it is taught and tested again
      const needs = (itemOf(text, entry.id)?.needs ?? []).filter(id => testCards(text, id).length && !proven(state, knowledge, id))
      const deps: TestEntry[] = []
      for (const id of needs) {
        const later = state.pq.findIndex((item, at) => at > state.pp && item.t === 'test' && item.id === id && item.n === 0)
        if (later >= 0) deps.push(...state.pq.splice(later, 1))
        else if (!state.pq.slice(0, state.pp).some(item => item.t === 'test' && item.id === id)) deps.push(testEntry(text, id, 0))
      }
      state.pq.splice(state.pp + 1, 0, ...deps, { t: 'teach', id: entry.id, n: entry.n, slot: {} }, testEntry(text, entry.id, entry.n + 1, false, entry.k))
    }
    state.pp++
  } else if (now.stage === 'practice') {
    const entry = state.queue[state.pos]
    entry.lang = lang
    state.results.push({ id: now.card.id, ok, stage: 'practice', retry: Boolean(entry.retry), lang })
    if (ok === false && !entry.retry) state.queue.push({ id: entry.id, retry: true, slot: newSlot(now.card) })
    state.pos++
  } else {
    state.ctx[state.cpos].lang = lang
    state.results.push({ id: now.card.id, ok, stage: 'context', lang })
    state.cpos++
  }
  return settle(state)
}

/** "Testar" on the learn card. */
export function taught(before: StudyState): StudyState {
  return settle({ ...copy(before), pp: before.pp + 1 })
}

/** FR-032: the text's content changed with the study under way; what does not exist any more leaves, the position stays. */
export function prune(before: StudyState, text: LanguageText): StudyState {
  const state = copy(before)
  const keepTest = (entry: TestEntry) => testCards(text, entry.id).length > 0
  state.pp -= state.pq.slice(0, state.pp).filter(entry => !keepTest(entry)).length
  state.pq = state.pq.filter(keepTest)
  const keepCard = (cards: Card[]) => (entry: CardEntry) => cards.some(card => card.id === entry.id && shown(card))
  state.pos -= state.queue.slice(0, state.pos).filter(entry => !keepCard(text.practice)(entry)).length
  state.queue = state.queue.filter(keepCard(text.practice))
  state.cpos -= state.ctx.slice(0, state.cpos).filter(entry => !keepCard(text.context)(entry)).length
  state.ctx = state.ctx.filter(keepCard(text.context))
  return settle(state)
}

export interface Summary {
  tested: number
  taught: string[]
  practice: { right: number; total: number }
  context: { right: number; total: number }
  target: number
}

export function summaryOf(state: StudyState, text: LanguageText): Summary {
  const first = state.results.filter(result => result.stage === 'practice' && !result.retry && result.ok !== null)
  const taughtIds = [...new Set(state.pq.filter(entry => entry.t === 'teach').map(entry => entry.id))]
  return {
    tested: state.pq.filter(entry => entry.t === 'test').length,
    taught: taughtIds.map(id => itemOf(text, id)?.label ?? id),
    practice: { right: first.filter(result => result.ok).length, total: first.length },
    context: { right: state.results.filter(result => result.stage === 'context' && result.ok).length, total: state.ctx.length },
    target: state.results.filter(result => result.lang === 'target').length,
  }
}
