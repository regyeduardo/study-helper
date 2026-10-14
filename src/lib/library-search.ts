import type { FileMeta, FileSidecar } from '@/types/domain'

const SNIPPET_BEFORE = 60
const SNIPPET_LENGTH = 180

export interface SnippetPart {
  text: string
  hit: boolean
}

export interface SearchHit {
  fileId: string
  at: number | null
  parts: SnippetPart[]
}

export interface SearchSource {
  content: string
  sidecar: Pick<FileSidecar, 'recording'>
}

function folded(text: string): string {
  let out = ''
  for (let index = 0; index < text.length; index++) {
    const plain = text[index].normalize('NFD').replace(/\p{M}/gu, '').toLowerCase()
    out += plain.length === 1 ? plain : text[index].toLowerCase().charAt(0) || text[index]
  }
  return out
}

export function searchWords(query: string): string[] {
  return folded(query.trim()).split(/\s+/).filter(Boolean)
}

function partsOf(text: string, words: string[]): SnippetPart[] | null {
  const low = folded(text)
  if (!words.every(word => low.includes(word))) return null
  const marked = new Array<boolean>(text.length).fill(false)
  for (const word of words) for (let at = low.indexOf(word); at >= 0; at = low.indexOf(word, at + word.length)) marked.fill(true, at, at + word.length)
  const first = marked.indexOf(true)
  const from = text.length > SNIPPET_LENGTH ? Math.max(0, first - SNIPPET_BEFORE) : 0
  const to = Math.min(text.length, from + SNIPPET_LENGTH)
  const parts: SnippetPart[] = []
  for (let index = from; index < to; index++) {
    const last = parts[parts.length - 1]
    if (last && last.hit === marked[index]) last.text += text[index]
    else parts.push({ text: text[index], hit: marked[index] })
  }
  if (from > 0) parts.unshift({ text: '…', hit: false })
  if (to < text.length) parts.push({ text: '…', hit: false })
  return parts
}

export function searchFile(meta: FileMeta, source: SearchSource | undefined, query: string): SearchHit | null {
  const words = searchWords(query)
  if (!words.length) return null
  for (const block of source?.sidecar.recording?.blocks ?? []) {
    const parts = partsOf(block.text, words)
    if (parts) return { fileId: meta.id, at: block.start, parts }
  }
  const paragraphs = (source?.content ?? '')
    .split(/\n+/)
    .map(line =>
      line
        .replace(/^\s*(#{1,6}|>|[-*+]|\d+\.)\s+/, '')
        .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
        .replace(/[*_`]/g, '')
        .trim(),
    )
    .filter(Boolean)
  for (const paragraph of paragraphs) {
    const parts = partsOf(paragraph, words)
    if (parts) return { fileId: meta.id, at: null, parts }
  }
  const everything = [meta.name, meta.description, meta.tags.join(' '), source?.content ?? '', ...(source?.sidecar.recording?.blocks ?? []).map(block => block.text)].join(' ')
  return partsOf(everything, words) ? { fileId: meta.id, at: null, parts: partsOf(meta.name, words) ?? [] } : null
}
