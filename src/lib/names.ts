import type { FileMeta, FolderMeta } from '@/types/domain'

/**
 * FR-021 (spec 005, 25/11: "no mesmo diretório não pode existir nem pasta de nome igual nem arquivo"): in one folder, the Biblioteca too,
 * no two folders and no two notes have the same name. Capitals and the spaces at the ends do not tell two names apart; what is in the
 * Lixeira does not count; a folder and a note may share a name.
 */

/**
 * What a write does when the name is taken there: the person's own act (create, rename, move, import) is refused saying which ('block');
 * the app's own writes never fail for a name: a folder it makes by name is the one already there ('reuse'), a note or a folder it names
 * gets " (2)" ('number').
 */
export type NameRule = 'block' | 'number' | 'reuse'

export const nameKey = (name: string): string => name.normalize('NFC').trim().toLocaleLowerCase('pt-BR')

export class NameTakenError extends Error {
  readonly code = 'name_taken'
}

export function noteNamed(files: FileMeta[], folderId: string | null, name: string, except?: string): FileMeta | undefined {
  const key = nameKey(name)
  return files.find(file => file.id !== except && !file.deletedAt && (file.folderId ?? null) === folderId && nameKey(file.name) === key)
}

export function folderNamed(folders: FolderMeta[], parentId: string | null, name: string, except?: string): FolderMeta | undefined {
  const key = nameKey(name)
  return folders.find(folder => folder.id !== except && !folder.deletedAt && (folder.parentId ?? null) === parentId && nameKey(folder.name) === key)
}

/** The name with " (2)", " (3)"… until it is free there; a name that already ends in " (n)" goes on from n. */
export function freeName(name: string, taken: (name: string) => boolean): string {
  if (!taken(name)) return name
  const clean = name.trim()
  const numbered = /^(.*\S) \((\d+)\)$/.exec(clean)
  const base = numbered ? numbered[1] : clean
  let next = numbered ? Number(numbered[2]) + 1 : 2
  while (taken(`${base} (${next})`)) next++
  return `${base} (${next})`
}

/** "em VP6" / "na Biblioteca": where, in the words of the warnings. */
export function placeOf(folders: FolderMeta[], folderId: string | null): string {
  const folder = folderId ? folders.find(item => item.id === folderId) : undefined
  return folder ? `em ${folder.name}` : 'na Biblioteca'
}

export const noteTaken = (name: string, where: string) => new NameTakenError(`Já existe uma nota chamada "${name}" ${where}.`)
export const folderTaken = (name: string, where: string) => new NameTakenError(`Já existe uma pasta chamada "${name}" ${where}.`)

/**
 * Before moving ("Bloquear e avisar", 25/11): the first item that would repeat a name in the target, said; null when all of them fit.
 * Nothing moves when one does not.
 */
export function moveConflict(files: FileMeta[], folders: FolderMeta[], fileIds: string[], folderIds: string[], target: string | null): NameTakenError | null {
  const where = placeOf(folders, target)
  const staying = files.filter(file => !fileIds.includes(file.id))
  const seenNotes = new Set<string>()
  for (const id of fileIds) {
    const file = files.find(item => item.id === id)
    if (!file) continue
    if (seenNotes.has(nameKey(file.name))) return new NameTakenError(`Duas das notas escolhidas se chamam "${file.name.trim()}" e não podem ficar juntas ${where}.`)
    seenNotes.add(nameKey(file.name))
    const there = noteNamed(staying, target, file.name)
    if (there) return noteTaken(there.name, where)
  }
  const stayingFolders = folders.filter(folder => !folderIds.includes(folder.id))
  const seenFolders = new Set<string>()
  for (const id of folderIds) {
    const folder = folders.find(item => item.id === id)
    if (!folder) continue
    if (seenFolders.has(nameKey(folder.name))) return new NameTakenError(`Duas das pastas escolhidas se chamam "${folder.name.trim()}" e não podem ficar juntas ${where}.`)
    seenFolders.add(nameKey(folder.name))
    const there = folderNamed(stayingFolders, target, folder.name)
    if (there) return folderTaken(there.name, where)
  }
  return null
}
