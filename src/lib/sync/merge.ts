import { diffArrays } from 'diff'

import type { FileSidecar } from '@/types/domain'
import type { FieldConflict } from '@/lib/storage/repository'

export interface TextHunk {
  kind: 'same' | 'conflict'
  base: string[]
  mine: string[]
  theirs: string[]
  resolved: string[]
}

function lines(text: string): string[] {
  return text.split('\n')
}

function matchesAgainstBase(base: string[], other: string[]): Map<number, number> {
  const matches = new Map<number, number>()
  let baseIndex = 0
  let otherIndex = 0
  for (const part of diffArrays(base, other)) {
    const count = part.count ?? part.value.length
    if (part.added) {
      otherIndex += count
    } else if (part.removed) {
      baseIndex += count
    } else {
      for (let step = 0; step < count; step++) matches.set(baseIndex + step, otherIndex + step)
      baseIndex += count
      otherIndex += count
    }
  }
  return matches
}

function sameLines(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((line, index) => line === right[index])
}

export function mergeText(baseText: string, mineText: string, theirsText: string): TextHunk[] {
  const base = lines(baseText)
  const mine = lines(mineText)
  const theirs = lines(theirsText)
  const toMine = matchesAgainstBase(base, mine)
  const toTheirs = matchesAgainstBase(base, theirs)

  const hunks: TextHunk[] = []
  let baseCursor = 0
  let mineCursor = 0
  let theirsCursor = 0

  const pushRegion = (baseEnd: number, mineEnd: number, theirsEnd: number) => {
    const baseSlice = base.slice(baseCursor, baseEnd)
    const mineSlice = mine.slice(mineCursor, mineEnd)
    const theirsSlice = theirs.slice(theirsCursor, theirsEnd)
    if (!baseSlice.length && !mineSlice.length && !theirsSlice.length) return
    if (sameLines(mineSlice, theirsSlice) || sameLines(theirsSlice, baseSlice)) {
      hunks.push({ kind: 'same', base: baseSlice, mine: mineSlice, theirs: theirsSlice, resolved: mineSlice })
    } else if (sameLines(mineSlice, baseSlice)) {
      hunks.push({ kind: 'same', base: baseSlice, mine: mineSlice, theirs: theirsSlice, resolved: theirsSlice })
    } else {
      hunks.push({ kind: 'conflict', base: baseSlice, mine: mineSlice, theirs: theirsSlice, resolved: mineSlice })
    }
  }

  for (let index = 0; index < base.length; index++) {
    const mineMatch = toMine.get(index)
    const theirsMatch = toTheirs.get(index)
    if (mineMatch === undefined || theirsMatch === undefined) continue
    if (mineMatch < mineCursor || theirsMatch < theirsCursor) continue
    pushRegion(index, mineMatch, theirsMatch)
    hunks.push({ kind: 'same', base: [base[index]], mine: [base[index]], theirs: [base[index]], resolved: [base[index]] })
    baseCursor = index + 1
    mineCursor = mineMatch + 1
    theirsCursor = theirsMatch + 1
  }
  pushRegion(base.length, mine.length, theirs.length)
  return compact(hunks)
}

function compact(hunks: TextHunk[]): TextHunk[] {
  const out: TextHunk[] = []
  for (const hunk of hunks) {
    const last = out[out.length - 1]
    if (last && last.kind === 'same' && hunk.kind === 'same') {
      last.base.push(...hunk.base)
      last.mine.push(...hunk.mine)
      last.theirs.push(...hunk.theirs)
      last.resolved.push(...hunk.resolved)
    } else {
      out.push({ ...hunk, base: [...hunk.base], mine: [...hunk.mine], theirs: [...hunk.theirs], resolved: [...hunk.resolved] })
    }
  }
  return out
}

export function hasTextConflict(hunks: TextHunk[]): boolean {
  return hunks.some(hunk => hunk.kind === 'conflict')
}

export function joinHunks(hunks: TextHunk[]): string {
  return hunks.flatMap(hunk => hunk.resolved).join('\n')
}

const META_LABELS: Record<string, string> = {
  name: 'Nome',
  description: 'Descrição',
  type: 'Tipo',
  favorite: 'Favorito',
  tags: 'Etiquetas',
  status: 'Situação',
  position: 'Ordem',
  folderId: 'Pasta',
}

const IGNORED_META = new Set(['updated', 'words', 'readingMinutes', 'mastery', 'lastReviewedAt', 'questionCount'])

function equal(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

function pick<T>(base: T, mine: T, theirs: T, path: string, label: string, conflicts: FieldConflict[]): T {
  if (equal(mine, theirs) || equal(theirs, base)) return mine
  if (equal(mine, base)) return theirs
  conflicts.push({ path, label, mine, theirs })
  return mine
}

function mergeById<T>(
  base: T[],
  mine: T[],
  theirs: T[],
  idOf: (item: T) => string,
  path: string,
  label: (item: T) => string,
  conflicts: FieldConflict[],
): T[] {
  const baseById = new Map(base.map(item => [idOf(item), item]))
  const mineById = new Map(mine.map(item => [idOf(item), item]))
  const theirsById = new Map(theirs.map(item => [idOf(item), item]))
  const order = [...new Set([...mine.map(idOf), ...theirs.map(idOf)])]
  const merged: T[] = []
  for (const id of order) {
    const was = baseById.get(id)
    const mineItem = mineById.get(id)
    const theirsItem = theirsById.get(id)
    if (mineItem && theirsItem) {
      merged.push(pick(was ?? mineItem, mineItem, theirsItem, `${path}.${id}`, label(mineItem), conflicts))
    } else if (mineItem) {
      if (!was || !equal(was, mineItem)) merged.push(mineItem)
    } else if (theirsItem) {
      if (!was || !equal(was, theirsItem)) merged.push(theirsItem)
    }
  }
  return merged
}

export interface SidecarMerge {
  merged: FileSidecar
  conflicts: FieldConflict[]
}

export function mergeSidecar(base: FileSidecar, mine: FileSidecar, theirs: FileSidecar): SidecarMerge {
  const conflicts: FieldConflict[] = []
  const meta = { ...mine.meta }
  const record = meta as unknown as Record<string, unknown>
  for (const key of Object.keys(mine.meta) as (keyof typeof mine.meta)[]) {
    if (IGNORED_META.has(key)) continue
    record[key] = pick(base.meta[key], mine.meta[key], theirs.meta[key], `meta.${key}`, META_LABELS[key] ?? key, conflicts)
  }
  if (theirs.meta.updated.at > mine.meta.updated.at && conflicts.length === 0) meta.updated = theirs.meta.updated

  return {
    merged: {
      meta,
      questions: mergeById(base.questions, mine.questions, theirs.questions, item => item.storedId, 'questions', item => `Questão: ${item.enunciado.slice(0, 60)}`, conflicts),
      attempts: mergeById(base.attempts, mine.attempts, theirs.attempts, item => item.id, 'attempts', item => `Prova de ${item.createdAt}`, conflicts),
      highlights: mergeById(base.highlights, mine.highlights, theirs.highlights, item => item.id, 'highlights', item => `Destaque: ${item.quote.slice(0, 60)}`, conflicts),
    },
    conflicts,
  }
}

export function applyFieldChoices(merged: FileSidecar, conflicts: FieldConflict[], choices: Record<string, 'mine' | 'theirs'>): FileSidecar {
  const result: FileSidecar = structuredClone(merged)
  for (const conflict of conflicts) {
    const value = choices[conflict.path] === 'theirs' ? conflict.theirs : conflict.mine
    const [section, key] = conflict.path.split('.', 2)
    if (section === 'meta') {
      ;(result.meta as unknown as Record<string, unknown>)[key] = value
      continue
    }
    const list = result[section as 'questions' | 'attempts' | 'highlights'] as unknown as { storedId?: string; id?: string }[]
    const position = list.findIndex(item => (item.storedId ?? item.id) === key)
    if (position >= 0) list[position] = value as { storedId?: string; id?: string }
  }
  return result
}
