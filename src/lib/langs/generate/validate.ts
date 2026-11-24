/**
 * The generated format, in the browser (spec 004, FR-040; the same as api/internal/langs/validate.go and content.go): read the AI's
 * answer leniently, give every problem (one short line in English, sent back to the AI) and repair what is only form, dropping alone
 * what is still wrong (owner, 23/11: one bad card never takes the whole text).
 */
import type { Card, Item } from '@/controllers/langs.controller'
import { type Content, sayList } from '@/lib/langs/content'
import { canonical, clean, same } from '@/lib/langs/grade'

const ITEM_ID = /^[a-z0-9][a-z0-9_]*$/
const AREAS = new Set(['lexico', 'gramatica', 'semantica', 'fonologia', 'ortografia', 'registro', 'pragmatica'])
const KINDS = new Set(['word', 'fixed_expression', 'phrasal_verb', 'idiom', 'collocation', 'structure', 'contraction', 'spoken_form', 'sense', 'sound', 'stress', 'linking', 'spelling', 'register', 'function', 'discourse'])
const SKILLS: Record<string, string> = {
  mc: 'read',
  tf: 'read',
  gap: 'read',
  order: 'read',
  match: 'read',
  odd: 'read',
  listen_mc: 'listen',
  minimal_pair: 'listen',
  same_diff: 'listen',
  find_diff: 'listen',
  stress: 'listen',
  dictation: 'listen',
  dictation_gap: 'listen',
  speak: 'speak',
}
const CHOICE = new Set(['mc', 'gap', 'listen_mc', 'odd'])
const SPEAK_MODES = new Set(['repeat', 'read', 'shadow', 'answer', 'translate'])
export const DP_LEVELS = new Set(['literal', 'reorganizacao', 'inferencia', 'previsao', 'avaliacao'])
const BLANK = '___'
const OPTIONS = 5

export type Base = Record<string, string[] | undefined>

const isString = (value: unknown): value is string => typeof value === 'string'
const strings = (value: unknown): string[] | undefined => (Array.isArray(value) && value.every(isString) ? value : undefined)
const quote = (text: string) => JSON.stringify(text)
const count = (text: string, part: string) => (text ? text.split(part).length - 1 : 0)
const words = (text: string) => text.split(/\s+/).filter(Boolean)
const sayText = (card: Card) => (typeof card.say === 'string' ? card.say : '')
const sayPair = (card: Card) => (Array.isArray(card.say) ? card.say : [])
const index = (value: unknown): number | null => (typeof value === 'number' && Number.isInteger(value) ? value : null)

// ——— reading the AI's answer ———

const SPLIT: Record<string, RegExp> = { syllables: /[-·| ]+/, tokens: /[ |]+/, pair: /[/|,]+/, opts: /\|+/ }
const TEXT_FIELDS = ['id', 'type', 'skill', 'q', 'qEn', 'expl', 'dp', 'text', 'answer', 'word', 'mode', 'target']
const LIST_FIELDS = ['covers', 'needs', 'opts', 'optsEn', 'tokens', 'pair', 'syllables', 'accept']

/** A card even when the AI wrote a field in another shape; one that still cannot be read comes back as "unreadable" (dropped alone). */
export function readCard(raw: unknown): Card {
  const fields = raw && typeof raw === 'object' && !Array.isArray(raw) ? { ...(raw as Record<string, unknown>) } : null
  const unreadable = { id: isString(fields?.id) ? fields.id : '', type: 'unreadable', skill: 'read', q: '' } as unknown as Card
  if (!fields) return unreadable
  for (const [key, separators] of Object.entries(SPLIT)) {
    if (isString(fields[key])) fields[key] = (fields[key] as string).split(separators).filter(Boolean)
  }
  if (Array.isArray(fields.answers)) fields.answers = fields.answers.map(accepted => (isString(accepted) ? [accepted] : accepted))
  for (const key of TEXT_FIELDS) if (fields[key] !== undefined && fields[key] !== null && !isString(fields[key])) return unreadable
  for (const key of LIST_FIELDS) if (fields[key] !== undefined && fields[key] !== null && !strings(fields[key])) return unreadable
  if (fields.pairs !== undefined && fields.pairs !== null && !(Array.isArray(fields.pairs) && fields.pairs.every(pair => strings(pair)))) return unreadable
  if (fields.answers !== undefined && fields.answers !== null && !(Array.isArray(fields.answers) && fields.answers.every(list => strings(list)))) return unreadable
  if (fields.say !== undefined && fields.say !== null && !isString(fields.say) && !strings(fields.say)) return unreadable
  if (fields.a !== undefined && fields.a !== null && !['number', 'boolean', 'string'].includes(typeof fields.a)) return unreadable
  for (const key of Object.keys(fields)) if (fields[key] === null) delete fields[key]
  return fields as unknown as Card
}

function readItem(raw: unknown): Item {
  const v = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {}
  const text = (key: string) => (isString(v[key]) ? (v[key] as string) : '')
  const facets = v.facets && typeof v.facets === 'object' && !Array.isArray(v.facets) ? Object.fromEntries(Object.entries(v.facets).filter(([, value]) => isString(value))) : undefined
  const item: Item = { area: text('area') as Item['area'], kind: text('kind'), label: text('label'), meaning: text('meaning'), test: Array.isArray(v.test) ? v.test.map(readCard) : [] }
  for (const key of ['say', 'word', 'pattern', 'core', 'expl'] as const) if (text(key)) item[key] = text(key)
  if (strings(v.ex)) item.ex = strings(v.ex)
  if (strings(v.needs)) item.needs = strings(v.needs)
  if (facets) item.facets = facets as Record<string, string>
  return item
}

/** The AI's answer as content, or null when it is not one (then the AI is asked again). */
export function readContent(value: unknown): Content | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const v = value as Record<string, unknown>
  if (v.items !== undefined && (typeof v.items !== 'object' || Array.isArray(v.items) || v.items === null)) return null
  if ([v.practice, v.context, v.equivalences].some(list => list !== undefined && list !== null && !Array.isArray(list))) return null
  const items: Record<string, Item> = {}
  for (const [id, item] of Object.entries((v.items as Record<string, unknown>) ?? {})) items[id] = readItem(item)
  const equivalences = ((v.equivalences as unknown[]) ?? []).map(group => strings(group) ?? []).filter(group => group.length > 0)
  return {
    lines: strings(v.lines) ?? [],
    equivalences,
    ...(strings(v.reuse)?.length ? { reuse: strings(v.reuse) } : {}),
    items,
    practice: ((v.practice as unknown[]) ?? []).map(readCard),
    context: ((v.context as unknown[]) ?? []).map(readCard),
  }
}

// ——— what is wrong ———

/** What is wrong in one card, by its type. */
export function checkCard(card: Card, groups: string[][]): string[] {
  const out: string[] = []
  const bad = (problem: string) => out.push(problem)
  const skill = SKILLS[card.type]
  if (!skill) {
    bad(`type ${card.type} is not one of mc, tf, gap, order, match, odd, listen_mc, minimal_pair, same_diff, find_diff, stress, dictation, dictation_gap, speak`)
    return out
  }
  if (card.skill !== skill) bad(`skill must be ${skill} for ${card.type}`)
  if (!(card.q ?? '').trim()) bad('q (the question in Portuguese) is empty')
  if (CHOICE.has(card.type)) {
    const opts = card.opts ?? []
    if (opts.length !== OPTIONS) bad(`${OPTIONS} options needed in ${card.type} (it has ${opts.length})`)
    if (card.optsEn?.length && card.optsEn.length !== opts.length) bad('optsEn must have one option per opts')
    const a = index(card.a)
    if (a === null || a < 0 || a >= opts.length) bad(`a must be the index of the right option (0 to ${opts.length - 1})`)
    for (let i = 0; i < opts.length; i++) {
      if (!opts[i].trim()) bad('empty option')
      for (let j = i + 1; j < opts.length; j++) {
        if (clean(opts[i]) === clean(opts[j])) bad(`options ${i} and ${j} are the same`)
        else if (!card.formIsTopic && same(opts[i], opts[j], groups)) bad(`equivalent options ${quote(opts[i])} and ${quote(opts[j])} (use formIsTopic only when the form is the subject)`)
      }
    }
  }
  switch (card.type) {
    case 'gap':
      if (count(card.text ?? '', BLANK) !== 1) bad(`text must have exactly one ${BLANK}`)
      break
    case 'listen_mc':
      if (!sayList(card).join('').trim()) bad('say (what the voice says) is empty')
      break
    case 'dictation':
      if (!sayText(card).trim()) bad('say (the sentence the voice says) is empty')
      break
    case 'tf':
      if (typeof card.a !== 'boolean') bad('a must be true or false')
      break
    case 'order': {
      const tokens = card.tokens ?? []
      const given = canonical(tokens.join(' '), []).sort()
      const want = canonical(card.answer ?? '', []).sort()
      if (tokens.length < 2 || given.join(' ') !== want.join(' ')) bad('tokens must be exactly the words of answer')
      break
    }
    case 'match': {
      const pairs = card.pairs ?? []
      if (pairs.length < 2) bad('match needs 2 pairs or more')
      const left = new Set<string>()
      const right = new Set<string>()
      for (const pair of pairs) {
        if (pair.length !== 2 || !pair[0].trim() || !pair[1].trim()) {
          bad('each pair is [left, right]')
          continue
        }
        if (left.has(clean(pair[0])) || right.has(clean(pair[1]))) bad('a side of the pairs repeats')
        left.add(clean(pair[0]))
        right.add(clean(pair[1]))
      }
      break
    }
    case 'minimal_pair': {
      const pair = card.pair ?? []
      if (pair.length !== 2 || !clean(pair[0]) || clean(pair[0]) === clean(pair[1])) bad('pair must be two different words')
      break
    }
    case 'same_diff': {
      const pair = sayPair(card)
      const a = typeof card.a === 'string' ? card.a : ''
      if (pair.length !== 2) bad('say must be the two words')
      else if (a !== 'same' && a !== 'diff') bad('a must be same or diff')
      else if ((clean(pair[0]) === clean(pair[1])) !== (a === 'same')) bad(`a says ${a} but the two words are [${pair.join(' ')}]`)
      break
    }
    case 'find_diff': {
      const shown = words(card.text ?? '')
      const said = words(sayText(card))
      const a = index(card.a)
      const changed: number[] = []
      if (shown.length === said.length) shown.forEach((word, n) => clean(word) !== clean(said[n]) && changed.push(n))
      if (!shown.length || shown.length !== said.length || changed.length !== 1 || a === null || changed[0] !== a) bad('text and say must have the same words but one, and a is the index of that word in text')
      break
    }
    case 'stress': {
      const syllables = card.syllables ?? []
      const a = index(card.a)
      if (syllables.length < 2 || a === null || a < 0 || a >= syllables.length) bad('syllables need 2 or more and a is the index of the strong one')
      if (clean(syllables.join('')) !== clean(card.word ?? '').replace(/-/g, '')) bad('syllables together must make word')
      break
    }
    case 'dictation_gap': {
      const answers = card.answers ?? []
      const blanks = count(card.text ?? '', BLANK)
      if (!blanks || blanks !== answers.length) {
        bad(`${blanks} blanks in text but ${answers.length} answers (one list of accepted answers per blank)`)
        break
      }
      let filled = card.text ?? ''
      for (const accepted of answers) {
        if (!accepted.length || !accepted[0].trim()) {
          bad('each blank needs an accepted answer')
          return out
        }
        filled = filled.replace(BLANK, accepted[0])
      }
      if (!same(filled, sayText(card), groups)) bad('the blanks filled with the answers must give say')
      break
    }
    case 'speak':
      if (!SPEAK_MODES.has(card.mode ?? '')) bad('mode must be repeat, read, shadow, answer or translate')
      if (!(card.target ?? '').trim()) bad('target (what the person must say) is empty')
      break
  }
  return out
}

/** One cycle of "needs" (through the text and the base), or "". */
function needsCycle(c: Content, base: Base): string {
  const edges: Record<string, string[]> = {}
  for (const [id, needs] of Object.entries(base)) edges[id] = needs ?? []
  for (const [id, item] of Object.entries(c.items)) edges[id] = item.needs ?? []
  const state = new Map<string, 'open' | 'done'>()
  const path: string[] = []
  let found = ''
  const visit = (id: string): boolean => {
    if (state.get(id) === 'open') {
      found = [...path.slice(path.lastIndexOf(id)), id].join(' → ')
      return true
    }
    if (state.get(id) === 'done') return false
    state.set(id, 'open')
    path.push(id)
    for (const need of edges[id] ?? []) if (visit(need)) return true
    path.pop()
    state.set(id, 'done')
    return false
  }
  for (const id of Object.keys(edges).sort()) if (visit(id)) return found
  return ''
}

/** Every problem of a generated text. `base` is the language's items (id → needs), which the text may need without bringing them. */
export function validate(c: Content, base: Base = {}): string[] {
  const problems: string[] = []
  const add = (problem: string) => problems.push(problem)
  const known = (id: string) => id in c.items || id in base
  ;(c.equivalences ?? []).forEach((group, n) => {
    if (group.length < 2) add(`equivalences[${n}]: a group needs 2 forms or more`)
    for (const form of group) if (!clean(form)) add(`equivalences[${n}]: empty form`)
  })
  const ids = Object.keys(c.items)
  if (!ids.length) add('no items')
  for (const id of ids) {
    const it = c.items[id]
    if (!ITEM_ID.test(id)) add(`item id ${quote(id)}: use lower case letters, digits and _`)
    if (!AREAS.has(it.area)) add(`${id}: area ${quote(it.area)} is not one of lexico, gramatica, semantica, fonologia, ortografia, registro, pragmatica`)
    if (!KINDS.has(it.kind)) add(`${id}: kind ${quote(it.kind)} is not in the list`)
    if (!it.label.trim() || !it.meaning.trim()) add(`${id}: label and meaning are required`)
    if (it.kind === 'sense' && (!it.word || !it.pattern || !it.core)) add(`${id}: a sense needs word, pattern and core`)
    for (const need of it.needs ?? []) {
      if (need === id) add(`${id}: needs itself`)
      else if (!known(need)) add(`${id}: needs ${need}, which is not an item of the text nor of the base`)
    }
    if (!it.test?.length) add(`${id}: no test card (2 or 3 closed cards that prove the item)`)
  }
  const cycle = needsCycle(c, base)
  if (cycle) add(`needs make a cycle: ${cycle}`)
  const cardIds = new Set<string>()
  const covered = new Set<string>()
  const check = (card: Card, part: string, owner: string) => {
    if (!card.id) {
      add(`a card without id in ${part}`)
      return
    }
    if (cardIds.has(card.id)) add(`card id ${card.id} repeated`)
    cardIds.add(card.id)
    for (const problem of checkCard(card, c.equivalences ?? [])) add(`${card.id}: ${problem}`)
    for (const id of card.covers ?? []) {
      if (!known(id)) add(`${card.id}: covers ${id}, which is not an item`)
      covered.add(id)
    }
    for (const id of card.needs ?? []) if (!known(id)) add(`${card.id}: needs ${id}, which is not an item`)
    if (owner) covered.add(owner)
    if (part === 'context' && !DP_LEVELS.has(card.dp ?? '')) add(`${card.id}: dp must be literal, reorganizacao, inferencia, previsao or avaliacao`)
  }
  for (const id of ids) for (const card of c.items[id].test ?? []) check(card, 'test', id)
  for (const card of c.practice ?? []) check(card, 'practice', '')
  for (const card of c.context ?? []) check(card, 'context', '')
  for (const id of ids) if (!covered.has(id)) add(`${id}: no card covers it`)
  return problems
}

// ——— repairing what is only form ———

/** The fixed question of each type, for a card the AI left without one. */
function question(card: Card): string {
  switch (card.type) {
    case 'listen_mc':
      return 'Ouça e escolha:'
    case 'dictation':
      return 'Ouça e escreva a frase:'
    case 'dictation_gap':
      return 'Ouça e complete:'
    case 'find_diff':
      return 'Ouça e toque a palavra que mudou:'
    case 'minimal_pair':
      return card.pair?.length === 2 ? `Ouça: ${quote(card.pair[0])} ou ${quote(card.pair[1])}?` : ''
    case 'same_diff':
      return 'Ouça as duas: são iguais?'
    case 'stress':
      return `Ouça e toque a sílaba forte de ${quote(card.word ?? '')}:`
    case 'order':
      return 'Monte a frase:'
    case 'match':
      return 'Ligue os pares:'
    case 'odd':
      return 'Ache o intruso:'
    case 'gap':
      return 'Complete:'
    case 'speak':
      return 'Ouça e repita:'
  }
  return ''
}

const QUOTED_BLANK = /['"“‘]([^'"”’]*___[^'"”’]*)['"”’]/

/** Every blank as "___", the sentence with the blank from the question to the text, and a question for a card left without one. */
export function fixBlanks(card: Card): void {
  card.q = (card.q ?? '').replace(/_{3,}/g, BLANK)
  if (card.text !== undefined) card.text = card.text.replace(/_{3,}/g, BLANK)
  if ((card.type === 'gap' || card.type === 'dictation_gap') && !(card.text ?? '').includes(BLANK) && card.q.includes(BLANK)) {
    const found = QUOTED_BLANK.exec(card.q)
    const colon = card.q.lastIndexOf(':')
    if (found) {
      card.text = found[1].trim()
      card.q = (card.q.slice(0, found.index) + card.q.slice(found.index + found[0].length)).trim()
    } else if (colon >= 0 && card.q.slice(colon).includes(BLANK)) {
      card.text = card.q.slice(colon + 1).trim()
      card.q = card.q.slice(0, colon + 1).trim()
    } else {
      card.text = card.q
      card.q = 'Complete:'
    }
  }
  if (!card.q.trim()) card.q = question(card)
}

/** An id as the format wants it: lower case, the apostrophe out ("don't" → "dont"), anything else as "_". */
export const slug = (id: string) =>
  id
    .trim()
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '')

/** Every item id in the right shape; the cards and needs that point to it follow. */
function fixIds(c: Content): void {
  const renamed = new Map<string, string>()
  const items: Record<string, Item> = {}
  for (const [id, item] of Object.entries(c.items)) {
    const fixed = slug(id) || id
    renamed.set(id, fixed)
    if (!(fixed in items)) items[fixed] = item
  }
  const follow = (ids?: string[]) => ids?.map(id => renamed.get(id) ?? id)
  for (const item of Object.values(items)) {
    if (item.needs) item.needs = follow(item.needs)
    for (const card of item.test ?? []) {
      if (card.covers) card.covers = follow(card.covers)
      if (card.needs) card.needs = follow(card.needs)
    }
  }
  for (const card of [...(c.practice ?? []), ...(c.context ?? [])]) {
    if (card.covers) card.covers = follow(card.covers)
    if (card.needs) card.needs = follow(card.needs)
  }
  if (c.reuse) c.reuse = follow(c.reuse)
  c.items = items
}

/**
 * Repairs what is only form (blanks, item ids, test card ids by item) and takes away, one by one, what is still wrong: a bad card, an
 * item left without a valid test card, a card that only covered what went away. Gives what was taken away.
 */
export function repair(c: Content, base: Base = {}): string[] {
  const dropped: string[] = []
  c.equivalences = (c.equivalences ?? []).filter(group => group.length >= 2)
  c.practice ??= []
  c.context ??= []
  fixIds(c)
  for (const [id, item] of Object.entries(c.items)) {
    item.test = item.test ?? []
    item.test.forEach((card, n) => {
      fixBlanks(card)
      card.id = `${id}__${n + 1}`
    })
  }
  for (const card of [...c.practice, ...c.context]) fixBlanks(card)
  for (let changed = true; changed; ) {
    changed = false
    const known = (id: string) => id in c.items || id in base
    // a card is kept when its type is right and it still covers something that exists
    const keep = (card: Card, part: string) => {
      const problems = checkCard(card, c.equivalences)
      if (problems.length) {
        dropped.push(`${card.id}: ${problems[0]}`)
        return false
      }
      if (part === 'context' && !DP_LEVELS.has(card.dp ?? '')) {
        dropped.push(`${card.id}: dp`)
        return false
      }
      const had = card.covers?.length ?? 0
      card.covers = (card.covers ?? []).filter(known)
      if (card.needs) card.needs = card.needs.filter(known)
      if (had > 0 && !card.covers.length) {
        dropped.push(`${card.id}: covered only what went away`)
        return false
      }
      return true
    }
    const items: Record<string, Item> = {}
    for (const [id, it] of Object.entries(c.items)) {
      const fine = ITEM_ID.test(id) && AREAS.has(it.area) && KINDS.has(it.kind) && it.label.trim() !== '' && it.meaning.trim() !== '' && (it.kind !== 'sense' || Boolean(it.word && it.pattern && it.core))
      const tests: Card[] = []
      for (const card of it.test) {
        // a test card always covers its own item
        if (!card.covers?.includes(id)) card.covers = [id, ...(card.covers ?? [])]
        if (fine && keep(card, 'test')) tests.push(card)
      }
      if (!fine || !tests.length) {
        dropped.push(`${id}: item without a valid test card`)
        changed = true
        continue
      }
      if (tests.length !== it.test.length) changed = true
      it.test = tests
      items[id] = it
    }
    c.items = items
    const stillKnown = (id: string) => id in c.items || id in base
    for (const [id, it] of Object.entries(c.items)) {
      const needs = (it.needs ?? []).filter(need => need !== id && stillKnown(need))
      if (needs.length !== (it.needs ?? []).length) changed = true
      it.needs = needs
    }
    const cycle = needsCycle(c, base)
    if (cycle) {
      const first = cycle.split(' → ')[0]
      if (c.items[first]) {
        c.items[first].needs = []
        dropped.push(`${first}: needs in a cycle`)
        changed = true
      }
    }
    for (const part of ['practice', 'context'] as const) {
      const kept = c[part].filter(card => keep(card, part))
      if (kept.length !== c[part].length) changed = true
      c[part] = kept
    }
  }
  // a card id twice: the second gets a number
  const seen = new Set<string>()
  const rename = (card: Card) => {
    const base = card.id || 'card'
    let id = base
    for (let n = 2; seen.has(id); n++) id = `${base}_${n}`
    card.id = id
    seen.add(id)
  }
  for (const item of Object.values(c.items)) item.test.forEach(rename)
  c.practice.forEach(rename)
  c.context.forEach(rename)
  return dropped
}
