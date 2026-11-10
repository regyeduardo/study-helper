// Família de um item: a entrada (vídeo, PDF, link…) e as notas que nasceram dela.
import type { FileMeta } from '@/types/domain'

/** Review, content search, the home panel and the exam only consider notes, never an entrada. */
export function isNote(file: Pick<FileMeta, 'role'>): boolean {
  return file.role !== 'entrada'
}

interface FamilyIndex {
  byId: Map<string, FileMeta>
  children: Map<string, FileMeta[]>
  descendants: Map<string, FileMeta[]>
}

// The list is replaced on every change, so the list itself is the version: same list, same answers.
const indexes = new WeakMap<FileMeta[], FamilyIndex>()

function indexOf(files: FileMeta[]): FamilyIndex {
  let index = indexes.get(files)
  if (!index) {
    const children = new Map<string, FileMeta[]>()
    for (const file of files) if (file.parentFileId) children.set(file.parentFileId, [...(children.get(file.parentFileId) ?? []), file])
    index = { byId: new Map(files.map(file => [file.id, file])), children, descendants: new Map() }
    indexes.set(files, index)
  }
  return index
}

/** Everything born of the item, in any folder, by `parentFileId`; without what is in the Lixeira unless `trashed`. A cycle in the data stops where it closes. */
export function descendantsOf(files: FileMeta[], id: string, options: { trashed?: boolean } = {}): FileMeta[] {
  const index = indexOf(files)
  const key = `${options.trashed ? 'all' : 'live'}:${id}`
  const known = index.descendants.get(key)
  if (known) return known
  const seen = new Set([id])
  const found: FileMeta[] = []
  const walk = (parentId: string) => {
    for (const child of index.children.get(parentId) ?? []) {
      if (seen.has(child.id) || (child.deletedAt && !options.trashed)) continue
      seen.add(child.id)
      found.push(child)
      walk(child.id)
    }
  }
  walk(id)
  index.descendants.set(key, found)
  return found
}

/** What was born of the item: its notes and the artifacts of those notes (the transcription is part of the entrada, never a note). */
export function familyCount(files: FileMeta[], id: string): { notes: number; artifacts: number } {
  const family = descendantsOf(files, id)
  return { notes: family.filter(isNote).length, artifacts: family.reduce((sum, file) => sum + (file.artifacts?.length ?? 0), 0) }
}

/** The entrada or the note the item was born of; null when it has none or it was deleted forever. */
export function motherOf(files: FileMeta[], file: Pick<FileMeta, 'parentFileId'>): FileMeta | null {
  return (file.parentFileId && indexOf(files).byId.get(file.parentFileId)) || null
}

/** The "de: <mãe>" badge: when the mother lives in another folder, or is in the Lixeira; deleted forever, "mãe apagada" without her. */
export function badgeOf(files: FileMeta[], file: Pick<FileMeta, 'parentFileId' | 'folderId'>): { mother: FileMeta | null; trashed: boolean } | null {
  if (!file.parentFileId) return null
  const mother = motherOf(files, file)
  if (!mother) return { mother: null, trashed: true }
  const trashed = Boolean(mother.deletedAt)
  return trashed || mother.folderId !== file.folderId ? { mother, trashed } : null
}
