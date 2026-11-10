// Busca da biblioteca (FR-053, FR-074, FR-075): só o que tem todas as palavras, com o termo marcado no nome e num trecho, e onde foi achado.
// O texto de cada item é dobrado (sem acento, minúsculo) uma vez só, e guardado enquanto o item não muda: cada tecla só compara.
import type { FileMeta, FileSidecar } from '@/types/domain'
import { isNote } from '@/lib/family'

const SNIPPET_BEFORE = 60
const SNIPPET_LENGTH = 180

export interface SnippetPart {
  text: string
  hit: boolean
}

/** Where the words were found: the name, the text of the note, or what was said in the media. */
export type FoundIn = 'nome' | 'nota' | 'transcricao'

export interface SearchHit {
  fileId: string
  where: FoundIn
  /** The second of the speech found; null when it is not a speech with a time. */
  at: number | null
  /** The name, with the words marked. */
  name: SnippetPart[]
  /** The excerpt, with the words marked; empty when all the words are in the name. */
  parts: SnippetPart[]
}

/** What is searched of an item: the text of a note, or of an entrada only its transcription (FR-053). */
export interface SearchSource {
  content: string
  sidecar: Pick<FileSidecar, 'recording' | 'transcript'>
}

/* ---------- folding: the same length as the text, so a position in one is the position in the other ---------- */

function foldEach(text: string): string {
  let out = ''
  for (let index = 0; index < text.length; index++) {
    const plain = text[index].normalize('NFD').replace(/\p{M}/gu, '').toLowerCase()
    out += plain.length === 1 ? plain : text[index].toLowerCase().charAt(0) || text[index]
  }
  return out
}

/** Without accents, in lower case. The fast way when it keeps the length (almost always); else letter by letter. */
export function fold(text: string): string {
  const quick = text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase()
  return quick.length === text.length ? quick : foldEach(text)
}

export function searchWords(query: string): string[] {
  return fold(query.trim()).split(/\s+/).filter(Boolean)
}

/* ---------- the index: one per opened item, kept while the item is the same object ---------- */

interface Piece {
  text: string
  folded: string
  where: 'nota' | 'transcricao'
  at: number | null
}

interface Doc {
  pieces: Piece[]
  /** Every piece, for a quick "has it?". */
  folded: string
}

const docs = new WeakMap<SearchSource, Doc>()

const plainLine = (line: string) =>
  line
    .replace(/^\s*(#{1,6}|>|[-*+]|\d+\.)\s+/, '')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[*_`]/g, '')
    .trim()

const piece = (text: string, where: Piece['where'], at: number | null): Piece => ({ text, folded: fold(text), where, at })

function build(note: boolean, source: SearchSource): Doc {
  const pieces: Piece[] = []
  const blocks = source.sidecar.recording?.blocks ?? []
  if (note) for (const line of source.content.split(/\n+/).map(plainLine)) if (line) pieces.push(piece(line, 'nota', null))
  for (const block of blocks) if (block.text.trim()) pieces.push(piece(block.text, 'transcricao', block.start))
  // a sent video keeps only the plain text of its transcription
  if (!note && !blocks.length) for (const line of (source.sidecar.transcript ?? '').split(/\n+/)) if (line.trim()) pieces.push(piece(line.trim(), 'transcricao', null))
  return { pieces, folded: pieces.map(item => item.folded).join('\n') }
}

function docOf(file: Pick<FileMeta, 'role'>, source: SearchSource): Doc {
  let doc = docs.get(source)
  if (!doc) {
    doc = build(isNote(file), source)
    docs.set(source, doc)
  }
  return doc
}

/** Indexes what is not indexed yet, for at most `budgetMs`; true when everything given is indexed. Lets the index be built between keystrokes. */
export function indexSome(files: FileMeta[], sources: Record<string, SearchSource | undefined>, budgetMs: number): boolean {
  const until = performance.now() + budgetMs
  for (const file of files) {
    const source = sources[file.id]
    if (!source || docs.has(source)) continue
    if (performance.now() > until) return false
    docOf(file, source)
  }
  return true
}

/* ---------- marking ---------- */

function markedOf(folded: string, words: string[]): boolean[] {
  const marked = new Array<boolean>(folded.length).fill(false)
  for (const word of words) for (let at = folded.indexOf(word); at >= 0; at = folded.indexOf(word, at + word.length)) marked.fill(true, at, at + word.length)
  return marked
}

function partsBetween(text: string, marked: boolean[], from: number, to: number): SnippetPart[] {
  const parts: SnippetPart[] = []
  for (let index = from; index < to; index++) {
    const last = parts[parts.length - 1]
    if (last && last.hit === marked[index]) last.text += text[index]
    else parts.push({ text: text[index], hit: marked[index] })
  }
  return parts
}

/** The whole text, with the words marked. */
export function markWords(text: string, words: string[], folded = fold(text)): SnippetPart[] {
  return partsBetween(text, markedOf(folded, words), 0, text.length)
}

/** A window of the text around the first word found, with the words marked. */
function snippetOf({ text, folded }: Pick<Piece, 'text' | 'folded'>, words: string[]): SnippetPart[] {
  const marked = markedOf(folded, words)
  const first = Math.max(0, marked.indexOf(true))
  const from = text.length > SNIPPET_LENGTH ? Math.max(0, first - SNIPPET_BEFORE) : 0
  const to = Math.min(text.length, from + SNIPPET_LENGTH)
  const parts = partsBetween(text, marked, from, to)
  if (from > 0) parts.unshift({ text: '…', hit: false })
  if (to < text.length) parts.push({ text: '…', hit: false })
  return parts
}

/** The first piece with every word; else the first with every word the name lacks; else the one with the most of those. */
function bestPiece(doc: Doc, words: string[], missing: string[]): Piece | null {
  let best: Piece | null = null
  let most = 0
  for (const item of doc.pieces) {
    if (words.every(word => item.folded.includes(word))) return item
    const count = missing.filter(word => item.folded.includes(word)).length
    if (count > most) [best, most] = [item, count]
  }
  return best
}

/* ---------- the search ---------- */

/** The item, when every word is in its name or in what is searched of it. */
export function searchFile(meta: FileMeta, source: SearchSource | undefined, query: string): SearchHit | null {
  const words = searchWords(query)
  return words.length ? hitOf(meta, source, words) : null
}

function hitOf(meta: FileMeta, source: SearchSource | undefined, words: string[]): SearchHit | null {
  const foldedName = fold(meta.name)
  const missing = words.filter(word => !foldedName.includes(word))
  const name = () => markWords(meta.name, words, foldedName)
  if (!missing.length) return { fileId: meta.id, where: 'nome', at: null, name: name(), parts: [] }
  const doc = source && docOf(meta, source)
  if (!doc || !missing.every(word => doc.folded.includes(word))) return null
  const found = bestPiece(doc, words, missing)!
  return { fileId: meta.id, where: found.where, at: found.at, name: name(), parts: snippetOf(found, words) }
}

let last: { files: FileMeta[]; sources: Record<string, SearchSource | undefined>; query: string; hits: Map<string, SearchHit> } | null = null

/** Every item with all the words, in the order of `files`. The same answer while the files, their texts and the query are the same. */
export function searchLibrary(files: FileMeta[], sources: Record<string, SearchSource | undefined>, query: string): Map<string, SearchHit> {
  if (last && last.files === files && last.sources === sources && last.query === query) return last.hits
  const hits = new Map<string, SearchHit>()
  const words = searchWords(query)
  if (words.length) {
    for (const file of files) {
      const hit = hitOf(file, sources[file.id], words)
      if (hit) hits.set(file.id, hit)
    }
  }
  last = { files, sources, query, hits }
  return hits
}
