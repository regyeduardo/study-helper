// What the local OCR read, as terms (names, acronyms, codes, numbers). Only sure readings are exact; the same
// term on several screens is voted; the speech is paired with a screen term only when both agree closely.
import type { OcrText } from '@/lib/generation/ata-types'
import type { RecordingData } from '@/types/domain'

/** Readings at least this sure are exact text; the others are only a hint for the vision model, never a correction. */
export const SURE = 0.9
const MAX_TERMS = 150

export interface ScreenTerms {
  /** The winning spelling of each term read with certainty. */
  exact: string[]
  /** Terms never read with certainty (7 px text, blurred lines): hints only. */
  doubtful: string[]
}

/** Something the transcription heard that agrees closely with a term written on the screen. */
export interface Pair {
  heard: string
  term: string
}

const flat = (text: string) =>
  text
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '')
const CONNECTORS = new Set(['de', 'da', 'do', 'dos', 'das', 'e', 'a'])
const hasDigit = (text: string) => /\p{N}/u.test(text)
const isNumber = (token: string) => /^[\d.,%]+$/.test(token) && hasDigit(token) && (/[.,%]/.test(token) ? token.replace(/\D/g, '').length >= 2 : token.length >= 4)
const isCode = (token: string) => token.length >= 3 && /\p{L}/u.test(token) && hasDigit(token)
const isAcronym = (token: string) => token.length >= 3 && /^[\p{Lu}\d][\p{Lu}\d\-_.&/]*$/u.test(token) && (token.match(/\p{Lu}/gu)?.length ?? 0) >= 2
const isCapital = (token: string) => /^\p{Lu}\p{Ll}{2,}/u.test(token)
const isAddress = (token: string) => /^[\p{L}\d-]+(\.[\p{L}\d-]+)+$/u.test(token) && /\p{L}/u.test(token)

/** Names (capitalized words, with "de/da/do" inside), acronyms, codes, numbers and addresses in one OCR reading. */
export function termsIn(text: string): string[] {
  const tokens = text
    .split(/[\s()[\]{};:"'<>=$|*+!?]+/)
    .map(token => token.replace(/^[.,\-/]+|[.,\-/]+$/g, ''))
    .filter(Boolean)
  const out: string[] = []
  let phrase: string[] = []
  const flush = () => {
    while (phrase.length && CONNECTORS.has(phrase[phrase.length - 1])) phrase.pop()
    if (phrase.length > 1 || (phrase.length === 1 && (phrase[0].length >= 4 || isAcronym(phrase[0])))) out.push(phrase.join(' '))
    phrase = []
  }
  for (const token of tokens) {
    if (!hasDigit(token) && (isCapital(token) || isAcronym(token))) phrase.push(token)
    else if (phrase.length && CONNECTORS.has(token)) phrase.push(token)
    else {
      flush()
      if (isNumber(token) || isCode(token) || isAddress(token)) out.push(token)
    }
  }
  flush()
  return out
}

function distance(a: string, b: string): number {
  let row = Array.from({ length: b.length + 1 }, (_, index) => index)
  for (let i = 1; i <= a.length; i++) {
    const next = [i]
    for (let j = 1; j <= b.length; j++) next[j] = Math.min(row[j] + 1, next[j - 1] + 1, row[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1))
    row = next
  }
  return row[b.length]
}

/** Two OCR readings of the same term: same letters, or (long words without digits) one letter off per 8. */
const sameTerm = (a: string, b: string) => a === b || (!hasDigit(a) && !hasDigit(b) && Math.min(a.length, b.length) >= 6 && distance(a, b) <= Math.max(1, Math.floor(Math.max(a.length, b.length) / 8)))

/** A term among OCR readings: the same letters, or one letter off (the image settles an unsure "FGT5" as "FGTS"). */
export function seenIn(term: string, readings: string[]): boolean {
  const key = flat(term)
  return key.length >= 2 && readings.some(reading => {
    const other = flat(reading)
    return other === key || (Math.min(key.length, other.length) >= 3 && distance(key, other) <= 1)
  })
}

/** One vote per screen; the sure readings decide; a term never read with certainty stays a hint. */
export function voteTerms(screens: OcrText[][]): ScreenTerms {
  const groups: { key: string; first: number; votes: Map<string, { sure: number; weight: number; seen: number; best: number }> }[] = []
  let order = 0
  for (const texts of screens) {
    const best = new Map<string, number>()
    for (const item of texts) for (const term of termsIn(item.text)) best.set(term, Math.max(best.get(term) ?? 0, item.confidence))
    for (const [term, confidence] of best) {
      const key = flat(term)
      if (!key) continue
      let group = groups.find(item => sameTerm(item.key, key))
      if (!group) groups.push((group = { key, first: order++, votes: new Map() }))
      const vote = group.votes.get(term) ?? { sure: 0, weight: 0, seen: 0, best: 0 }
      if (confidence >= SURE) {
        vote.sure++
        vote.weight += confidence
      }
      vote.seen++
      vote.best = Math.max(vote.best, confidence)
      group.votes.set(term, vote)
    }
  }
  const winners = groups.map(group => ({ group, ranked: [...group.votes].sort(([, a], [, b]) => b.sure - a.sure || b.weight - a.weight || b.seen - a.seen || b.best - a.best) }))
  // most seen first, names and codes before bare numbers: a spreadsheet gives hundreds of exact cells
  const exact = winners
    .filter(item => item.ranked[0][1].sure)
    .sort((a, b) => Number(isNumber(a.ranked[0][0])) - Number(isNumber(b.ranked[0][0])) || b.ranked[0][1].sure - a.ranked[0][1].sure || a.group.first - b.group.first)
    .map(item => item.ranked[0][0])
  const doubtful = winners.filter(item => !item.ranked[0][1].sure).map(item => item.ranked[0][0])
  return { exact, doubtful }
}

// Letters a spelled acronym confuses by sound: "bê, cê, dê, gê, pê, tê, vê, zê" and "éfe, éle, éme, éne, érre, ésse".
const SOUNDS = ['bcdegptvz', 'flmnrs']
const soundAlike = (a: string, b: string) => {
  let differ = 0
  for (let index = 0; index < a.length; index++) {
    if (a[index] === b[index]) continue
    if (!SOUNDS.some(letters => letters.includes(a[index]) && letters.includes(b[index]))) return false
    differ++
  }
  return differ === 1
}

/** Where the speech and an exact screen term agree closely: the same letters (accent, case, hyphen) or a spelled acronym with one letter that sounds alike. */
export function closePairs(speech: string, exact: string[]): Pair[] {
  const words: { word: string; key: string; named: boolean; opens: boolean }[] = []
  for (const sentence of speech.split(/(?<=[.!?…])\s+|\n+/)) {
    sentence
      .split(/\s+/)
      .map(word => word.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}%]+$/gu, ''))
      .filter(Boolean)
      // only what the transcription wrote as a name or an acronym counts; a common word ("campo", "fluxo") stays
      .forEach((word, index) => words.push({ word, key: flat(word), named: /^[\p{Lu}\d]/u.test(word), opens: index === 0 }))
  }
  // a fuzzy name ("Natálla" on a tile) is never a correction: OCR misreads look just like that
  const terms = exact.map(term => ({ term, key: flat(term), size: term.split(/\s+/).length, acronym: isAcronym(term) && !hasDigit(term) }))
  const byKey = new Map<string, typeof terms>()
  for (const item of terms) byKey.set(item.key, [...(byKey.get(item.key) ?? []), item])
  const acronyms = terms.filter(item => item.acronym)
  const pairs = new Map<string, Pair>()
  for (let index = 0; index < words.length; index++) {
    // the first word of a sentence is capitalized anyway: it only counts written as an acronym
    if (!words[index].named || (words[index].opens && !/^[\p{Lu}\d]+$/u.test(words[index].word))) continue
    let key = ''
    for (let n = 1; n <= 5 && index + n <= words.length && words[index + n - 1].named; n++) {
      key += words[index + n - 1].key
      const heard = words.slice(index, index + n).map(item => item.word).join(' ')
      if (key.length < 2 || pairs.has(heard) || byKey.get(key)?.some(item => item.term === heard)) continue
      const same = byKey.get(key)?.find(item => item.term !== heard && Math.abs(item.size - n) <= 1)
      const sounds = n === 1 && /^\p{Lu}+$/u.test(heard) ? acronyms.find(item => item.key.length === key.length && soundAlike(key, item.key)) : undefined
      const found = same ?? sounds
      if (found) pairs.set(heard, { heard, term: found.term })
    }
  }
  return [...pairs.values()]
}

/** "Escrito na tela" for the review of the transcription: what the vision model read, the exact OCR terms and the pairs. */
export function screenWriting(recording: RecordingData): string {
  const read = (recording.frames ?? []).map(frame => frame.text)
  const terms = (recording.screenTerms ?? []).slice(0, MAX_TERMS)
  if (!read.length && !terms.length) return ''
  const pairs = closePairs(recording.blocks.map(block => block.text).join('\n'), recording.screenTerms ?? [])
  return (
    `Escrito na tela durante a reunião: ${[...read, ...(terms.length ? [`lido com certeza: ${terms.join(', ')}`] : [])].join(' | ')}\n` +
    (pairs.length ? `Ouvido parecido com o escrito na tela (pela tela, só estes podem ser corrigidos): ${pairs.map(pair => `${pair.heard} → ${pair.term}`).join('; ')}\n` : '') +
    '\n'
  )
}

/** For the glossary of the Ata: the exact terms, and the only corrections of the speech the screen allows. */
export function termsForGlossary(exact: string[], speech: string): string {
  if (!exact.length) return ''
  const pairs = closePairs(speech, exact)
  return [
    `TERMOS EXATOS DA TELA (lidos no computador com certeza; esta é a grafia certa): ${exact.slice(0, MAX_TERMS).join(', ')}`,
    `CORREÇÕES DA FALA PELA TELA, só estas (som ou grafia quase iguais); fora delas, mantenha o que foi dito: ${pairs.length ? pairs.map(pair => `${pair.heard} → ${pair.term}`).join('; ') : 'nenhuma'}`,
  ].join('\n')
}

/** Exact terms that look like a person's name ("Natália Lenza"): they fix the accents in the Ata. */
export function personNames(exact: string[]): string[] {
  return exact.filter(term => {
    const words = term.split(' ')
    return words.length >= 2 && words.length <= 4 && words.every(word => /^\p{Lu}\p{Ll}+$/u.test(word) || CONNECTORS.has(word))
  })
}
