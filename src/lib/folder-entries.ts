// "Entradas:" na pasta da biblioteca: as notas agrupadas pela entrada de onde nasceram, ou a entrada como uma linha normal. Só na navegação da pasta.
import type { FileMeta, Settings } from '@/types/domain'
import { isNote, motherOf } from '@/lib/family'

export type FolderEntriesMode = NonNullable<Settings['folderEntries']>

export const FOLDER_ENTRIES_MODES: { id: FolderEntriesMode; label: string }[] = [
  { id: 'hide', label: 'Não mostrar' },
  { id: 'group', label: 'Agrupar as notas' },
  { id: 'item', label: 'Como item' },
]

/** What the library settings say; anything not known (an old index, a value from the future) is "Não mostrar", as before this option. */
export function folderEntriesOf(settings: Pick<Settings, 'folderEntries'>): FolderEntriesMode {
  return FOLDER_ENTRIES_MODES.some(mode => mode.id === settings.folderEntries) ? settings.folderEntries! : 'hide'
}

const MAX_STEPS = 64

/**
 * The entrada at the top of the note's family: its mother, or the mother of its mother, and so on. Null when it was born of no entrada
 * (written directly, or of a note whose family has none), when the entrada is in the Lixeira or was deleted forever, or when the data closes a cycle.
 * `files` is the whole library, the Lixeira included: the chain may pass through a note that is there.
 */
export function entryOfNote(files: FileMeta[], note: FileMeta): FileMeta | null {
  let current = note
  for (let steps = 0; steps < MAX_STEPS; steps++) {
    const mother = motherOf(files, current)
    if (!mother || mother.id === note.id) return null
    if (!isNote(mother)) return mother.deletedAt ? null : mother
    current = mother
  }
  return null
}

export interface EntryGroup {
  /** Null: the notes born of no entrada ("Sem entrada"). */
  entry: FileMeta | null
  notes: FileMeta[]
}

/**
 * The notes, in the order received, in one group per entrada; the groups in the order `order` gives the entradas, and "Sem entrada" after all of them.
 * A group exists only while it has a note.
 */
export function groupNotesByEntry(files: FileMeta[], notes: FileMeta[], order: (entries: FileMeta[]) => FileMeta[]): EntryGroup[] {
  const byEntry = new Map<string, FileMeta[]>()
  const entries: FileMeta[] = []
  const loose: FileMeta[] = []
  for (const note of notes) {
    const entry = entryOfNote(files, note)
    if (!entry) {
      loose.push(note)
      continue
    }
    if (!byEntry.has(entry.id)) {
      byEntry.set(entry.id, [])
      entries.push(entry)
    }
    byEntry.get(entry.id)!.push(note)
  }
  const groups: EntryGroup[] = order(entries).map(entry => ({ entry, notes: byEntry.get(entry.id)! }))
  return loose.length ? [...groups, { entry: null, notes: loose }] : groups
}
