import type { Card, LanguageText } from '@/controllers/langs.controller'
import { diff, type DiffWord, exact, same } from '@/lib/langs/grade'

/**
 * Delivery 1 of the languages mode (spec 004, owner on 23/11: "somente ouvindo (as frases), sem falar"): first the text's sentences
 * with the model voice, then the listening cards of the text. Each card is graded here, by itself, without AI; the wrong ones come
 * back once at the end (T039).
 */

export const LISTEN_TYPES: Card['type'][] = ['listen_mc', 'minimal_pair', 'same_diff', 'find_diff', 'stress', 'dictation', 'dictation_gap']

export type Stage = 'test' | 'practice' | 'context'

export interface Entry {
  card: Card
  stage: Stage
}

/** What is kept of a card so it comes back the same: the order of its options, and which of the pair the voice says. */
export interface Slot {
  order?: number[]
  pick?: number
}

/** A choice's index; a dictation's text; the gaps' texts; the order of the tokens touched; for pairs, the right side of each left one (-1: none). */
export type Answer = number | string | string[] | number[] | null

export interface Result {
  ok: boolean
  given: string
  right: string
  diff?: DiffWord[]
}

/** The listening cards of a text, in its order: the items' tests, then the practice, then the context. */
export function listenCards(text: Pick<LanguageText, 'items' | 'practice' | 'context'>): Entry[] {
  const listen = (card: Card) => card.skill === 'listen' && LISTEN_TYPES.includes(card.type)
  const out: Entry[] = []
  for (const item of Object.values(text.items)) for (const card of item.test ?? []) if (listen(card)) out.push({ card, stage: 'test' })
  for (const card of text.practice) if (listen(card)) out.push({ card, stage: 'practice' })
  for (const card of text.context) if (listen(card)) out.push({ card, stage: 'context' })
  return out
}

function shuffled(n: number): number[] {
  const order = [...Array(n).keys()]
  for (let i = n - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[order[i], order[j]] = [order[j], order[i]]
  }
  return order
}

export function newSlot(card: Card): Slot {
  if (card.type === 'listen_mc' || card.type === 'mc' || card.type === 'gap' || card.type === 'odd') return { order: shuffled(card.opts?.length ?? 0) }
  if (card.type === 'order') return { order: shuffled(card.tokens?.length ?? 0) }
  if (card.type === 'match') return { order: shuffled(card.pairs?.length ?? 0) }
  if (card.type === 'minimal_pair') return { pick: Math.floor(Math.random() * 2) }
  return {}
}

/** What the voice says in the card, one after the other. */
export function spoken(card: Card, slot: Slot): string[] {
  if (card.type === 'minimal_pair') return card.pair ? [card.pair[slot.pick ?? 0]] : []
  if (card.type === 'stress') return card.word ? [card.word] : []
  return ([] as string[]).concat(card.say ?? []).filter(Boolean)
}

/** The options of a choice card in the language of the question (FR-024): the English ones when it came in English. */
function optionsOf(card: Card, lang: 'native' | 'target'): string[] {
  return lang === 'target' && card.type === 'mc' && card.optsEn?.length === card.opts?.length ? card.optsEn! : (card.opts ?? [])
}

const TRUE_FALSE = { native: ['Verdadeiro', 'Falso'], target: ['True', 'False'] }

/** The choices of a card that is answered by touching one of them, in the order shown, with the index each one answers. */
export function choices(card: Card, slot: Slot, lang: 'native' | 'target' = 'native'): { label: string; value: number }[] {
  switch (card.type) {
    case 'listen_mc':
    case 'mc':
    case 'gap':
    case 'odd': {
      const opts = optionsOf(card, lang)
      const order = slot.order?.length === opts.length ? slot.order : opts.map((_, i) => i)
      return order.map(i => ({ label: opts[i], value: i }))
    }
    case 'tf':
      return TRUE_FALSE[lang].map((label, value) => ({ label, value }))
    case 'minimal_pair':
      return (card.pair ?? []).map((label, value) => ({ label, value }))
    case 'same_diff':
      return [
        { label: 'Iguais', value: 0 },
        { label: 'Diferentes', value: 1 },
      ]
    case 'find_diff':
      return (card.text ?? '').split(' ').map((label, value) => ({ label, value }))
    case 'stress':
      return (card.syllables ?? []).map((label, value) => ({ label, value }))
    default:
      return []
  }
}

/** Whether there is an answer to check. */
export function ready(card: Card, answer: Answer): boolean {
  if (card.type === 'dictation') return typeof answer === 'string' && answer.trim() !== ''
  if (card.type === 'dictation_gap') return Array.isArray(answer) && answer.length === (card.answers?.length ?? 0) && answer.every(value => typeof value === 'string' && value.trim() !== '')
  if (card.type === 'order') return Array.isArray(answer) && answer.length === (card.tokens?.length ?? 0)
  if (card.type === 'match') return Array.isArray(answer) && answer.length === (card.pairs?.length ?? 0) && answer.every(value => typeof value === 'number' && value >= 0)
  return typeof answer === 'number'
}

export function grade(card: Card, answer: Answer, slot: Slot, groups: string[][], lang: 'native' | 'target' = 'native'): Result {
  const pick = (labels: string[], right: number) => {
    const given = typeof answer === 'number' ? (labels[answer] ?? '') : ''
    return { ok: answer === right, given, right: labels[right] ?? '' }
  }
  switch (card.type) {
    case 'listen_mc':
    case 'mc':
    case 'gap':
    case 'odd':
      return pick(optionsOf(card, lang), Number(card.a))
    case 'tf':
      return pick(TRUE_FALSE[lang], card.a === true ? 0 : 1)
    case 'order': {
      const tokens = card.tokens ?? []
      const given = Array.isArray(answer) ? answer.map(i => tokens[Number(i)] ?? '').join(' ') : ''
      const right = card.answer ?? ''
      return { ok: given !== '' && same(given, right, groups), given, right }
    }
    case 'match': {
      const pairs = card.pairs ?? []
      const links = Array.isArray(answer) ? answer.map(Number) : []
      return {
        ok: pairs.length > 0 && pairs.every((_, i) => links[i] === i),
        given: pairs.map(([left], i) => `${left} → ${pairs[links[i]]?.[1] ?? '?'}`).join('; '),
        right: pairs.map(([left, right]) => `${left} → ${right}`).join('; '),
      }
    }
    case 'minimal_pair':
      return pick(card.pair ?? [], slot.pick ?? 0)
    case 'same_diff':
      return pick(['Iguais', 'Diferentes'], card.a === 'same' ? 0 : 1)
    case 'find_diff':
      return pick((card.text ?? '').split(' '), Number(card.a))
    case 'stress':
      return pick(card.syllables ?? [], Number(card.a))
    case 'dictation': {
      const given = typeof answer === 'string' ? answer.trim() : ''
      const say = spoken(card, slot)[0] ?? ''
      return { ok: same(given, say, groups), given, right: say, diff: diff(say, given, groups) }
    }
    case 'dictation_gap': {
      const values = Array.isArray(answer) ? answer.map(value => String(value).trim()) : []
      const accepted = card.answers ?? []
      return { ok: accepted.length > 0 && accepted.every((list, i) => exact(values[i] ?? '', list)), given: values.join(' · '), right: accepted.map(list => list[0]).join(' · ') }
    }
    default:
      return { ok: false, given: '', right: '' }
  }
}

/** Where the person is in a text (kept on the server as the progress). */
export interface StudyState {
  step: 'lines' | 'cards' | 'done'
  /** Position in `order`. */
  at: number
  /** The card ids of this round. */
  order: string[]
  /** Wrong in the first round: they come back once at the end. */
  wrong: string[]
  /** The second round, with the wrong ones; empty in the first. */
  again: string[]
  slots: Record<string, Slot>
  /** Right on the first try, and answered in the first round. */
  right: number
  answered: number
  done?: boolean
}

export function startState(entries: Entry[]): StudyState {
  const slots: Record<string, Slot> = {}
  for (const { card } of entries) slots[card.id] = newSlot(card)
  return { step: 'lines', at: 0, order: entries.map(entry => entry.card.id), wrong: [], again: [], slots, right: 0, answered: 0 }
}

/** The state after answering the card at the current position. */
export function nextAfter(state: StudyState, cardId: string, ok: boolean): StudyState {
  const next: StudyState = { ...state, wrong: [...state.wrong], again: [...state.again], at: state.at + 1 }
  if (!state.again.length) {
    next.answered += 1
    if (ok) next.right += 1
    else next.wrong.push(cardId)
  }
  if (next.at < next.order.length) return next
  if (!state.again.length && next.wrong.length) return { ...next, order: next.wrong, again: next.wrong, wrong: [], at: 0 }
  return { ...next, step: 'done', done: true }
}
