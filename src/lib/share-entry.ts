// O que vai no link de uma entrada (FR-066): a árvore da família com uma caixa por item, e as regras de marcar.
import type { ArtifactKind, FileMeta } from '@/types/domain'
import { descendantsOf } from '@/lib/family'

/** The media of the entrada; the transcription has no box: it always goes. */
export const MEDIA_KEY = 'midia'

export interface ShareTreeArtifact {
  key: string
  id: string
  kind: ArtifactKind
  name: string
}

export interface ShareTreeNote {
  key: string
  file: FileMeta
  artifacts: ShareTreeArtifact[]
  children: ShareTreeNote[]
}

/** What buildEntryShareContent sends: the media or not, the notes and, for each note, its chosen artifacts. */
export interface EntryShareChoice {
  media: boolean
  notes: string[]
  artifacts: Record<string, string[]>
}

const artifactKey = (noteId: string, artifactId: string) => `${noteId}/${artifactId}`

/** The family of the entrada as the window shows it: each note under its mother, oldest first, with its artifacts; nothing from the Lixeira. */
export function entryShareTree(files: FileMeta[], entryId: string): ShareTreeNote[] {
  const children = new Map<string, FileMeta[]>()
  for (const file of [...descendantsOf(files, entryId)].sort((a, b) => a.created.at.localeCompare(b.created.at))) children.set(file.parentFileId!, [...(children.get(file.parentFileId!) ?? []), file])
  const build = (file: FileMeta): ShareTreeNote => ({
    key: file.id,
    file,
    artifacts: (file.artifacts ?? []).map(artifact => ({ key: artifactKey(file.id, artifact.id), id: artifact.id, kind: artifact.kind, name: artifact.name })),
    children: (children.get(file.id) ?? []).map(build),
  })
  return (children.get(entryId) ?? []).map(build)
}

function walk(tree: ShareTreeNote[], visit: (note: ShareTreeNote, mothers: ShareTreeNote[]) => void, mothers: ShareTreeNote[] = []) {
  for (const note of tree) {
    visit(note, mothers)
    walk(note.children, visit, [...mothers, note])
  }
}

/** Everything goes, except cards and Tutor conversations; the media only when there is one to send. */
export function defaultChoice(tree: ShareTreeNote[], withMedia: boolean): Set<string> {
  const chosen = new Set<string>(withMedia ? [MEDIA_KEY] : [])
  walk(tree, note => {
    chosen.add(note.key)
    for (const artifact of note.artifacts) if (artifact.kind === 'mapa') chosen.add(artifact.key)
  })
  return chosen
}

/** Unchecking a note unchecks its children and their artifacts; checking a child note or an artifact checks its mothers back, up to the entrada. */
export function toggleChoice(tree: ShareTreeNote[], chosen: Set<string>, key: string): Set<string> {
  const next = new Set(chosen)
  if (key === MEDIA_KEY) {
    if (next.has(key)) next.delete(key)
    else next.add(key)
    return next
  }
  walk(tree, (note, mothers) => {
    const artifact = note.artifacts.find(item => item.key === key)
    if (note.key !== key && !artifact) return
    if (next.has(key)) {
      next.delete(key)
      if (!artifact) walk([note], inside => [inside.key, ...inside.artifacts.map(item => item.key)].forEach(item => next.delete(item)))
      return
    }
    next.add(key)
    for (const mother of artifact ? [...mothers, note] : mothers) next.add(mother.key)
  })
  return next
}

/** "N de M itens vão": the media, each note and each artifact; the transcription always goes and does not count. */
export function choiceCount(tree: ShareTreeNote[], chosen: Set<string>, withMedia: boolean): { chosen: number; total: number } {
  const keys = withMedia ? [MEDIA_KEY] : []
  walk(tree, note => keys.push(note.key, ...note.artifacts.map(item => item.key)))
  return { chosen: keys.filter(key => chosen.has(key)).length, total: keys.length }
}

export function choiceOf(tree: ShareTreeNote[], chosen: Set<string>): EntryShareChoice {
  const choice: EntryShareChoice = { media: chosen.has(MEDIA_KEY), notes: [], artifacts: {} }
  walk(tree, note => {
    if (!chosen.has(note.key)) return
    choice.notes.push(note.file.id)
    choice.artifacts[note.file.id] = note.artifacts.filter(item => chosen.has(item.key)).map(item => item.id)
  })
  return choice
}
