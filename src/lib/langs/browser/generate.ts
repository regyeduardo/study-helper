/**
 * The generation in the browser (spec 004, FR-040), for who keeps the languages in the Google Drive or in this browser: the same as
 * api/internal/langs/generate.go and prompt.go. The text goes whole; inside, the AI is called in pieces (one at a time, the problems
 * sent back up to 2 times, the next model when one does not answer) and the pieces become one text. While it runs it says how far it
 * is (constitution IV). The AI is the person's own, or the app's through the server (`aiFetch` decides).
 */
import { ApiError } from '@/controllers/api.controller'
import type { Card } from '@/controllers/langs.controller'
import type { BrowserLangs, GenerationProgress, Reported } from '@/lib/langs/browser/base'
import type { Content } from '@/lib/langs/content'
import { linesOf } from '@/lib/langs/content'
import { clean } from '@/lib/langs/grade'
import { type Base, checkCard, fixBlanks, readCard, readContent, repair, validate } from '@/lib/langs/generate/validate'

/** One model the generation can call: the prompt → the raw answer. */
export interface GenModel {
  id: string
  chat(prompt: string, signal?: AbortSignal): Promise<string>
}

/** No AI chosen for the use (the person has to choose one). */
export class AiNotConfigured extends Error {}

class InvalidContent extends Error {}

const FIX_TRIES = 2

/** The problems one can report (the same as the server's). */
export const REASONS: Record<string, string> = {
  two_right: 'Duas opções estão certas',
  wrong_answer: 'A resposta certa está errada',
  bad_audio: 'O áudio está ruim',
  confusing: 'O enunciado confunde',
  other: 'Outro problema',
}

const complaint = (reason: string, note: string) => REASONS[reason] + (note.trim() ? ` ("${note.trim()}")` : '')

/** The cards that pass, as the item's test cards: its ids (item__n), covering only it. */
function validTests(item: string, raw: unknown[]): Card[] {
  const out: Card[] = []
  for (const value of raw) {
    const card = readCard(value)
    fixBlanks(card)
    if (checkCard(card, []).length) continue
    card.covers = [item]
    delete card.needs
    out.push(card)
  }
  return out.map((card, n) => ({ ...card, id: `${item}__${n + 1}` }))
}

export interface KnownItem {
  id: string
  label: string
  kind: string
  needs?: string[]
}

/** What the AI gets for one piece of a text (prototipo/SCHEMA.md, v2): the piece, the items the language already has and the rules. */
export function prompt(languageName: string, code: string, piece: string[], known: KnownItem[], n: number, of: number): string {
  let out = `You write study material for a Brazilian who is learning a language (${languageName}, code "${code}") from a text they chose (a song, an article, a dialogue...).
This is piece ${n} of ${of} of the text. Teach EVERYTHING a learner needs to fully understand and use the language of this piece, from every area of the CEFR, not only words.
All explanations, meanings and questions ("q", "meaning", "expl", "facets", options in Portuguese) are in Brazilian Portuguese. "qEn" is the same question in ${languageName}.

THE PIECE:
${piece.join('\n')}

`
  if (known.length) {
    out += 'ITEMS THIS PERSON ALREADY HAS (id | label | kind). When this piece uses one, use THE SAME id (never a new id for the same thing) and put it in "items" with its test cards:\n'
    for (const item of known) out += `${item.id} | ${item.label} | ${item.kind}\n`
    out += '\n'
  }
  return out + RULES
}

const RULES = `ANSWER with ONE JSON object only (no text around it), with these keys:
{
  "equivalences": [["won't", "will not"], ["gonna", "going to"]],   // forms that say the same thing, lower case: only the ones this piece uses or that confuse
  "reuse": ["give_up"],              // ids of READY ITEMS this piece uses (not written again)
  "items": {
    "<id>": {                        // id: lower case letters, digits and _ ("give_up", "mind_v"); the same thing in another text has the same id
      "area": "lexico",              // lexico | gramatica | semantica | fonologia | ortografia | registro | pragmatica
      "kind": "phrasal_verb",        // word | fixed_expression | phrasal_verb | idiom | collocation | structure | contraction | spoken_form | sense | sound | stress | linking | spelling | register | function | discourse
      "label": "give up",            // how it shows in the card
      "say": "give up",              // optional: what the voice says, when different from label
      "meaning": "desistir",         // in Portuguese
      "word": "give", "pattern": "give up + -ing", "core": "...",   // REQUIRED when kind is "sense": the mother word, the pattern that identifies the sense, the central sense that links the others
      "expl": "...",                 // explanation in Portuguese
      "ex": ["Don't give up! = Não desista!"],
      "needs": ["give", "up"],       // ids it needs to be known before (no cycles)
      "facets": {"spoken": "...", "written": "...", "parts": "...", "meaning": "...", "senses": "...", "associations": "...", "grammar": "...", "collocations": "...", "use": "..."},  // only the ones that matter
      "test": [ 2 or 3 closed cards that prove the item, of different types; AT LEAST ONE is a listening card (listen_mc, dictation or dictation_gap). They are shared with other people: use your own example sentences, NEVER a sentence of the piece ]
    }
  },
  "practice": [ closed cards made from THE SENTENCES OF THE PIECE; each one is solved by itself, without remembering the text. MOST ARE LISTENING CARDS (see LISTENING below) ],
  "context":  [ closed comprehension cards about the piece (Day & Park), each with "dp": literal | reorganizacao | inferencia | previsao | avaliacao ]
}

CARD: common fields "id" (unique in the whole answer), "type", "skill" (read | listen | speak), "q" (the question in Portuguese), "qEn" (optional), "covers" (item ids the card trains), "needs" (item ids needed to understand the question in the studied language), "expl" (shown after answering).
type          fields                                                      skill
mc            opts (exactly 5), a (index of the right one), optsEn?       read
tf            a (true/false); q is the statement                          read
gap           text with exactly one ___, opts (exactly 5), a              read
order         tokens (the pieces, shuffled), answer (the sentence)        read
match         pairs [[left, right], ...] (2 or more)                      read
odd           opts (exactly 5), a (index of the odd one)                  read
listen_mc     say (the sentence the voice says), opts (exactly 5), a     listen
minimal_pair  pair [x, y] (two different words; the app says one)        listen
same_diff     say [x, y], a ("same" or "diff")                            listen
find_diff     text (shown), say (the audio, with ONE word changed), a (index of that word in text, counting words split by spaces)   listen
stress        word, syllables (they make the word together), a (index of the strong syllable)   listen
dictation     say (the sentence to write)                                 listen
dictation_gap say, text (say with ___ for each blank), answers (one list of accepted answers per blank; the blanks filled must give say)   listen
speak         mode (repeat | read | shadow | answer | translate), say?, target, accept []   speak

LISTENING (the person studies by listening): "practice" MUST have, for this piece:
- one "dictation" for EVERY sentence of the piece (say = the sentence exactly as written);
- at least 2 "dictation_gap" (the key words of the piece as blanks);
- at least 1 "find_diff" and 1 "listen_mc" (the meaning of a sentence);
- 1 "minimal_pair" or "same_diff" for each sound of the piece that confuses Brazilians (ship/sheep, walk/work, think/sink);
- 1 "stress" for each word of 3 or more syllables.
Reading cards may come after these.

RULES:
- In "gap" and "dictation_gap" the sentence with the blank goes in "text" with exactly "___" for each blank; "q" only asks ("Complete:").
- Every choice card (mc, gap, listen_mc, odd) has exactly 5 options, with HARD distractors: same class and same field of meaning, near synonyms that do not fit that context, false cognates, look-alike forms (want/won't, used to/get used to, quit/quite/quiet), typical mistakes of Brazilians and, in translations, almost-right translations that change the meaning. Never an absurd option. The right one in a varied position.
- Options never bring two equivalent forms ("won't" and "will not"), unless the form itself is the subject: then the question says which form it wants and the card has "formIsTopic": true.
- Teach the language, never analyse the text as a work: never ask about rhyme, verse, chorus, stanza, meter, the author's intention, literary figures or the structure of the song or poem.
- In "practice", never a question that needs remembering the text.
- Every item has 2 or 3 test cards, and every item is covered by some card.
- Listening cards say real sentences of the language (most from the piece), never Portuguese.
- No card asks a free answer judged by someone: everything is closed or compared with the expected sentence.
`

/** The text's lines in groups for the AI. */
export function pieces(lines: string[], maxLines = 10, maxChars = 1500): string[][] {
  const out: string[][] = []
  let piece: string[] = []
  let size = 0
  for (const line of lines) {
    const length = [...line].length
    if (piece.length && (piece.length >= maxLines || size + length > maxChars)) {
      out.push(piece)
      piece = []
      size = 0
    }
    piece.push(line)
    size += length
  }
  if (piece.length) out.push(piece)
  return out
}

/** The items whose words are all in the piece (so the AI only sees what may come back). */
function inPiece<T extends { id: string; label: string }>(items: T[], piece: string[]): T[] {
  const words = new Set(clean(piece.join(' ')).split(' ').filter(Boolean))
  const all = (text: string) => {
    const list = clean(text.replace(/_/g, ' ')).split(' ').filter(Boolean)
    return list.length > 0 && list.every(word => words.has(word))
  }
  return items.filter(item => all(item.label) || all(item.id))
}

function stripFence(answer: string): string {
  let text = answer.trim()
  if (text.startsWith('```')) {
    text = text.replace(/^```json/, '').replace(/^```/, '')
    text = text.trim().replace(/```$/, '')
  }
  return text.trim()
}

function fixRequest(answer: string, problems: string[]): string {
  const shown = problems.length > 40 ? [...problems.slice(0, 40), `… and ${problems.length - 40} more`] : problems
  return `\n\nYOUR PREVIOUS ANSWER (below) HAS PROBLEMS. Answer again with the whole JSON object fixed.\nProblems:\n- ${shown.join('\n- ')}\n\nPrevious answer:\n${answer}`
}

/** Adds a piece to the text: an item already there stays as it came first; a card id already used gets the piece's number. */
function merge(into: Content, piece: Content, n: number): void {
  const ids = new Set<string>([...into.practice, ...into.context, ...Object.values(into.items).flatMap(item => item.test)].map(card => card.id))
  const fresh = <T extends { id: string }>(card: T): T => {
    let id = card.id
    for (let k = n + 1; ids.has(id); k++) id = `${card.id}_${k}`
    ids.add(id)
    return { ...card, id }
  }
  for (const [key, item] of Object.entries(piece.items)) {
    if (into.items[key]) continue
    into.items[key] = { ...item, test: item.test.map(fresh) }
  }
  into.practice.push(...piece.practice.map(fresh))
  into.context.push(...piece.context.map(fresh))
  const seen = new Set(into.equivalences.map(group => group.join('|')))
  for (const group of piece.equivalences) {
    if (seen.has(group.join('|'))) continue
    into.equivalences.push(group)
    seen.add(group.join('|'))
  }
}

export interface GeneratorOptions {
  now?: () => Date
  chunkLines?: number
  chunkChars?: number
}

export class BrowserGenerator {
  private readonly queue: { code: string; id: string }[] = []
  private running: Promise<void> | null = null
  private readonly progress = new Map<string, GenerationProgress>()
  private readonly listeners = new Set<() => void>()
  private readonly reports = new Set<Promise<void>>()

  constructor(
    private readonly langs: BrowserLangs,
    private readonly models: () => GenModel[] | Promise<GenModel[]>,
    private readonly options: GeneratorOptions = {},
  ) {}

  private now(): Date {
    return this.options.now?.() ?? new Date()
  }

  /** The generation of the text running now; undefined when it did not start (waiting) or ended. */
  progressOf(textId: string): GenerationProgress | undefined {
    const found = this.progress.get(textId)
    return found ? { ...found } : undefined
  }

  /** Called whenever a generation moves (a piece done, a text ready or failed). */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private changed(): void {
    for (const listener of this.listeners) listener()
  }

  private mark(textId: string, done: number, total: number): void {
    const now = this.now()
    const before = this.progress.get(textId)
    const p: GenerationProgress = before && done > 0 ? { ...before } : { done: 0, total, startedAt: now.toISOString() }
    p.done = done
    p.total = total
    if (done > 0) {
      p.lastAt = now.toISOString()
      const each = (now.getTime() - new Date(p.startedAt).getTime()) / done
      if (done < total) p.endsAt = new Date(now.getTime() + each * (total - done)).toISOString()
      else delete p.endsAt
    }
    this.progress.set(textId, p)
    this.changed()
  }

  /** Puts a text in the queue; texts are generated one at a time, in order. */
  enqueue(code: string, id: string): void {
    if (this.queue.some(item => item.id === id)) return
    this.queue.push({ code, id })
    this.running ??= this.drain()
  }

  /** The texts left generating when the tab closed go back to the queue. */
  async resume(): Promise<void> {
    for (const { code, id } of await this.langs.pendingTexts()) this.enqueue(code, id)
  }

  /** Every queued text and every report done (tests, and the page waiting for nothing). */
  async idle(): Promise<void> {
    while (this.running || this.reports.size) await Promise.all([this.running, ...this.reports])
  }

  /**
   * "Reportar" (wireframe C): checks the card and makes it again in the background, another way and with the reason; the person goes
   * on studying and the new card comes next time. A test card makes the item's test cards again; a card of the text, only that card.
   */
  async report(code: string, textId: string, cardId: string, reason: string, note: string): Promise<{ status: 'remaking' }> {
    if (!(reason in REASONS)) throw new ApiError(422, 'invalid_reason')
    const reported = await this.langs.reported(code, textId, cardId)
    const job: Promise<void> = (reported.item ? this.remakeItem(reported, reason, note) : this.remakeCard(reported, reason, note))
      .catch(() => undefined)
      .finally(() => this.reports.delete(job))
    this.reports.add(job)
    return { status: 'remaking' }
  }

  /** The models in order, the one that made the card last at the end (another way), until one answer is taken. */
  private async askJSON(used: string, text: string, accept: (answer: string) => boolean): Promise<void> {
    const all = await this.models()
    const models = [...all.filter(model => model.id !== used), ...all.filter(model => model.id === used)]
    for (const model of models) {
      for (let attempt = 0; attempt < 2; attempt++) {
        let answer: string
        try {
          answer = await model.chat(text)
        } catch {
          break
        }
        if (accept(stripFence(answer))) return
      }
    }
    throw new InvalidContent('no card made again')
  }

  private async remakeItem(r: Reported, reason: string, note: string): Promise<void> {
    const item = r.item!
    const text = `You write study cards for a Brazilian learning ${r.name} (code "${r.language}").
A person reported this card of the item "${item.label}" (${item.kind}, meaning "${item.meaning}"): ${complaint(reason, note)}.
Reported card: ${JSON.stringify(r.card)}
All the current test cards of the item: ${JSON.stringify(item.tests.length ? item.tests : [r.card])}

Write the item's test cards again, in a DIFFERENT way: other example sentences, other distractors, avoiding the reported problem.
2 or 3 closed cards, AT LEAST ONE listening card (listen_mc, dictation or dictation_gap); your own example sentences, never someone's text.
Same card format as before ("q" in Brazilian Portuguese; choice cards with exactly 5 options, hard distractors, never two equivalent options;
in "gap" and "dictation_gap" the sentence with "___" goes in "text").
Answer with ONE JSON object only: {"test": [cards]}`
    let tests: Card[] = []
    await this.askJSON(r.model, text, answer => {
      try {
        const got = JSON.parse(answer) as { test?: unknown }
        tests = Array.isArray(got.test) ? validTests(item.id, got.test) : []
      } catch {
        tests = []
      }
      return tests.length > 0
    })
    await this.langs.replaceItemTests(r.language, item.id, tests)
  }

  private async remakeCard(r: Reported, reason: string, note: string): Promise<void> {
    const text = `You write study cards for a Brazilian learning ${r.name} (code "${r.language}") from this text:
${r.lines.join('\n')}

A person reported this card: ${complaint(reason, note)}.
Reported card: ${JSON.stringify(r.card)}

Write this card again in a DIFFERENT way, avoiding the reported problem: the same skill ("${r.card.skill}"), from the sentences of the text, covering the
same items [${(r.card.covers ?? []).join(' ')}]. Same card format ("q" in Brazilian Portuguese; choice cards with exactly 5 options, hard distractors, never two equivalent
options; in "gap" and "dictation_gap" the sentence with "___" goes in "text").
Answer with ONE JSON object only: {"card": {...}}`
    let card: Card | null = null
    await this.askJSON(r.model, text, answer => {
      try {
        const made = readCard((JSON.parse(answer) as { card?: unknown }).card)
        fixBlanks(made)
        if (!made.dp && r.card.dp) made.dp = r.card.dp
        made.covers = (made.covers ?? []).filter(id => r.textItems.includes(id))
        if (!made.covers.length) made.covers = r.card.covers
        made.id = r.card.id
        card = checkCard(made, []).length ? null : made
      } catch {
        card = null
      }
      return card !== null
    })
    await this.langs.replaceCard(r.language, card!)
  }

  private async drain(): Promise<void> {
    while (this.queue.length) {
      const { code, id } = this.queue[0]
      await this.run(code, id).catch(() => undefined)
      this.queue.shift()
    }
    this.running = null
  }

  /** Generates one text now and keeps the result (ready, or failed with the reason). */
  async run(code: string, id: string): Promise<void> {
    const { name, body } = await this.langs.source(code, id)
    try {
      const { content, model } = await this.generate(code, id, name, linesOf(body))
      await this.langs.saveContent(code, id, content, model)
    } catch (error) {
      const reason = error instanceof InvalidContent ? 'invalid_content' : error instanceof AiNotConfigured ? 'ai_not_configured' : 'provider_down'
      await this.langs.failText(code, id, reason)
      throw error
    } finally {
      this.progress.delete(id)
      this.changed()
    }
  }

  private async generate(code: string, textId: string, name: string, lines: string[]): Promise<{ content: Content; model: string }> {
    const base = await this.langs.base(code)
    const merged: Content = { lines, equivalences: base.equivalences.map(group => [...group]), items: {}, practice: [], context: [] }
    const parts = pieces(lines, this.options.chunkLines, this.options.chunkChars)
    let used = ''
    this.mark(textId, 0, parts.length)
    for (const [n, piece] of parts.entries()) {
      // the person's own items of this piece, and what the pieces before brought
      const known: KnownItem[] = inPiece(base.list, piece).map(item => ({ id: item.id, label: item.label, kind: item.kind, needs: base.graph[item.id] }))
      for (const [id, item] of Object.entries(merged.items)) if (!(id in base.graph)) known.push({ id, label: item.label, kind: item.kind, needs: item.needs })
      const graph: Base = { ...base.graph }
      for (const item of known) graph[item.id] = item.needs
      const got = await this.ask(prompt(name, code, piece, known, n + 1, parts.length), graph, merged.equivalences)
      used = got.model
      merge(merged, got.piece, n)
      this.mark(textId, n + 1, parts.length)
    }
    repair(merged, base.graph)
    const problems = validate(merged, base.graph)
    if (problems.length || !Object.keys(merged.items).length) throw new InvalidContent(problems.slice(0, 5).join('; '))
    return { content: merged, model: used }
  }

  /** One valid piece: the first model that answers, its answer fixed up to 2 times. */
  private async ask(text: string, known: Base, groups: string[][]): Promise<{ piece: Content; model: string }> {
    let last: Error = new Error('provider_down')
    for (const model of await this.models()) {
      let question = text
      for (let attempt = 0; attempt <= FIX_TRIES; attempt++) {
        let answer: string
        try {
          answer = await model.chat(question)
        } catch (error) {
          last = error instanceof Error ? error : new Error(String(error))
          break // this model does not answer: the next one
        }
        let problems: string[]
        let piece: Content | null = null
        try {
          piece = readContent(JSON.parse(stripFence(answer)))
        } catch (error) {
          problems = [`the answer is not the JSON object asked: ${error instanceof Error ? error.message : String(error)}`]
        }
        if (piece) {
          piece.lines = ['-']
          piece.equivalences = [...groups.map(group => [...group]), ...piece.equivalences]
          repair(piece, known)
          problems = validate(piece, known)
          if (!Object.keys(piece.items).length) problems.push('no valid item: every item needs label, meaning and 2 or 3 valid test cards')
          if (!problems.length) return { piece, model: model.id }
        } else problems ??= ['the answer is not the JSON object asked']
        last = new InvalidContent(problems.slice(0, 5).join('; '))
        question = text + fixRequest(answer, problems)
      }
      if (last instanceof InvalidContent) throw last
    }
    throw last
  }
}
