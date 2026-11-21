// A link, a text or a topic stays in the note it made (`source`): no entrada, unless the person turns it into one ("Virar entrada").
import type { FileMeta, NoteSource, SourceMeta } from '@/types/domain'
import { youtubeId } from '@/controllers/sources.controller'
import type { ContentInput, ResolvedInput } from '@/lib/generation/inputs'
import { isSourceNote } from '@/lib/file-types'

/** A link (not YouTube), a text and a topic stay in the note; a YouTube link, a file, a media and a recording become an entrada. */
export function keptInNote(input: ContentInput): boolean {
  return input.kind === 'text' || input.kind === 'topic' || (input.kind === 'link' && !youtubeId(input.url))
}

/** What the note keeps of what it was made of. */
export function noteSourceOf(input: ContentInput, resolved: Pick<ResolvedInput, 'title'>, at: string): NoteSource | undefined {
  if (input.kind === 'link') return { kind: 'link', url: input.url.trim(), ...(resolved.title ? { title: resolved.title } : {}), at }
  if (input.kind === 'text') return { kind: 'text', text: input.text.trim(), ...(resolved.title ? { title: resolved.title } : {}), at }
  if (input.kind === 'topic') return { kind: 'topic', text: input.topic.trim(), at }
  return undefined
}

/** The origin the entrada gets when the source turns into one: the one the note keeps, else the one Novo conteúdo gave before. */
export function entryOriginOf(note: Pick<FileMeta, 'origin' | 'source'>): SourceMeta | null {
  const source = note.source
  if (!source) return null
  const input = source.kind === 'link' ? 'url' : source.kind
  if (note.origin?.input === input) return { ...note.origin }
  if (source.kind === 'link') return { input: 'url', name: source.title || source.url || 'Link', url: source.url, storage: 'none' }
  if (source.kind === 'topic') return { input: 'topic', name: source.text ?? '', storage: 'none' }
  return { input: 'text', name: 'texto colado', sizeBytes: new Blob([source.text ?? '']).size, mime: 'text/plain', storage: 'none' }
}

/** The note the source of this note already turned into: its mother, while it keeps that source and is out of the Lixeira. */
export function entryOfSource(files: FileMeta[], note: Pick<FileMeta, 'parentFileId' | 'source'>): FileMeta | null {
  if (!note.source || !note.parentFileId) return null
  return files.find(file => file.id === note.parentFileId && isSourceNote(file) && !file.deletedAt) ?? null
}

const URL_ONLY = /^\S*?(https?:\/\/[^\s<>"]+?)[.,;:!?)\]'"»]*$/i

/** The link that was selected: only an address, with no words around it (punctuation and brackets are left out). */
export function linkIn(selected: string): string | null {
  const text = selected.trim()
  const found = URL_ONLY.exec(text)
  if (!found) return null
  const before = text.slice(0, text.indexOf(found[1]))
  return /^[([«'"]*$/.test(before) ? found[1] : null
}

/** A text too long to show whole in a line of "Detalhes". */
export function shortText(text: string, max = 160): string {
  const condensed = text.split(/\s+/).filter(Boolean).join(' ')
  return condensed.length <= max ? condensed : `${condensed.slice(0, max - 1).trimEnd()}…`
}
