import type { Card, Item, LanguageText } from '@/controllers/langs.controller'
import { isDue, type Schedule } from '@/lib/langs/fsrs'
import { newSlot, type Slot } from '@/lib/langs/listen'

/**
 * The study of a text (spec 004), as in the prototype the owner validated (prototipo/web/app.js), with the order he chose on 24/11
 * ("A"): the text's sentences → test and teach → practice (read and listen) → context. Nobody says what they know: the app tests each
 * item of the text; a wrong answer goes down to what the item needs and was not proven, teaches it (the learn card) and tests again
 * another way, up to 3 times. What the base already proved, with no review due, is skipped; what is due comes as a review.
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

export interface StudyState {
  v: 2
  step: 'lines' | 'test' | 'practice' | 'context' | 'done'
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
  | { kind: 'lines' }
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

function testEntry(text: LanguageText, id: string, n: number, review = false): TestEntry {
  const cards = testCards(text, id)
  return { t: 'test', id, n, ...(review ? { review } : {}), slot: cards.length ? newSlot(cards[n % cards.length]) : {} }
}

/** FR-039: a card reused from another text that is already in review and not due waits for its day (it comes back as a review). */
const waiting = (schedule: Schedule | undefined, now: Date) => schedule?.state === 'review' && !isDue(schedule, now)

export function startStudy(text: LanguageText, knowledge: Knowledge, now = new Date()): StudyState {
  const pq = Object.keys(text.items)
    .filter(id => testCards(text, id).length && !fromBase(knowledge, id))
    .map(id => testEntry(text, id, 0, Boolean(knowledge[id]?.due)))
  const entry = (card: Card): CardEntry => ({ id: card.id, slot: newSlot(card) })
  return {
    v: 2,
    step: 'lines',
    pq,
    pp: 0,
    proven: {},
    queue: text.practice.filter(card => shown(card) && !waiting(text.schedules?.[card.id], now)).map(entry),
    pos: 0,
    ctx: text.context.filter(shown).map(entry),
    cpos: 0,
    results: [],
    enWrong: 0,
    ptMode: false,
    ptRight: 0,
  }
}

/** A progress kept before still is this study (the one of delivery 1, only listening, starts again). */
export function fitsStudy(state: unknown): state is StudyState {
  const s = state as StudyState
  return Boolean(s && s.v === 2 && Array.isArray(s.pq) && Array.isArray(s.queue) && Array.isArray(s.ctx) && typeof s.pp === 'number')
}

function settle(state: StudyState): StudyState {
  if (state.step === 'test' && state.pp >= state.pq.length) state.step = state.queue.length ? 'practice' : state.ctx.length ? 'context' : 'done'
  if (state.step === 'practice' && state.pos >= state.queue.length) state.step = state.ctx.length ? 'context' : 'done'
  if (state.step === 'context' && state.cpos >= state.ctx.length) state.step = 'done'
  if (state.step === 'done') state.done = true
  return state
}

/** After the sentences: the first part that has something. */
export function begin(state: StudyState): StudyState {
  return settle({ ...state, step: 'test' })
}

export function currentOf(state: StudyState, text: LanguageText): Current {
  if (state.step === 'lines') return { kind: 'lines' }
  if (state.step === 'test') {
    const entry = state.pq[state.pp]
    const item = entry && itemOf(text, entry.id)
    if (!entry || !item) return { kind: 'done' }
    const position = state.pp + 1
    if (entry.t === 'teach') return { kind: 'teach', id: entry.id, item, position, total: state.pq.length }
    const cards = testCards(text, entry.id)
    return { kind: 'card', stage: 'test', card: cards[entry.n % cards.length], entry, position, total: state.pq.length, review: entry.review, again: entry.n > 0 }
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
      state.pq.splice(state.pp + 1, 0, ...deps, { t: 'teach', id: entry.id, n: entry.n, slot: {} }, testEntry(text, entry.id, entry.n + 1))
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
