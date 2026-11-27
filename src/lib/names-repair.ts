import type { FileMeta, FolderMeta } from '@/types/domain'
import { freeName, nameKey } from '@/lib/names'

/**
 * Spec 005, FR-022 (T052; dono, 25/11: "Juntar"): the repeated names from before the rule, undone once. Folders of the same name in the
 * same folder become one: what is inside goes to the oldest, the folders inside of the same name join too, and the emptied one goes to
 * the Lixeira. Notes of the same name stay: the oldest keeps the name and the newer get " (2)", " (3)"… What is in the Lixeira is left
 * alone. The same as cmd/juntar-nomes on the server (api/internal/server/names_repair.go); here, for what lives only in this browser.
 */

export interface NameRepair {
  /** Each folder changed: where it goes and whether it went to the Lixeira. */
  folders: { id: string; parentId: string | null; trash: boolean }[]
  /** Each note changed: its folder and its name. */
  files: { id: string; folderId: string | null; name: string }[]
}

interface Item {
  id: string
  name: string
  folderId: string | null
  created: string
  trashed: boolean
  changed: boolean
}

const oldestFirst = (a: Item, b: Item) => a.created.localeCompare(b.created) || a.id.localeCompare(b.id)

/** Live items by folder and name, oldest first, in a fixed order. */
function groupsOf(items: Item[]): Item[][] {
  const byKey = new Map<string, Item[]>()
  for (const item of items.filter(entry => !entry.trashed)) {
    const key = `${item.folderId ?? ''}\u0000${nameKey(item.name)}`
    byKey.set(key, [...(byKey.get(key) ?? []), item])
  }
  return [...byKey.keys()].sort().map(key => byKey.get(key)!.sort(oldestFirst))
}

export function planNameRepair(folders: FolderMeta[], files: FileMeta[]): NameRepair {
  const live = <T extends { deletedAt: string | null }>(list: T[]) => list.filter(item => !item.deletedAt)
  const folderItems: Item[] = live(folders).map(folder => ({ id: folder.id, name: folder.name, folderId: folder.parentId ?? null, created: folder.created.at, trashed: false, changed: false }))
  const fileItems: Item[] = live(files).map(file => ({ id: file.id, name: file.name, folderId: file.folderId ?? null, created: file.created.at, trashed: false, changed: false }))

  // folders first, until no two of the same name share a folder: joining two can bring two of the same name together inside
  for (let joined = true; joined; ) {
    joined = false
    for (const [keep, ...others] of groupsOf(folderItems)) {
      for (const other of others) {
        for (const child of [...folderItems, ...fileItems]) {
          if (!child.trashed && child.folderId === other.id) Object.assign(child, { folderId: keep.id, changed: true })
        }
        Object.assign(other, { trashed: true, changed: true })
        joined = true
      }
    }
  }

  // notes: the oldest keeps the name, the newer get the first free number in that folder
  const taken = new Map<string | null, Set<string>>()
  for (const file of fileItems) taken.set(file.folderId, (taken.get(file.folderId) ?? new Set()).add(nameKey(file.name)))
  for (const [, ...newer] of groupsOf(fileItems)) {
    for (const note of newer) {
      const names = taken.get(note.folderId)!
      const name = freeName(note.name, candidate => names.has(nameKey(candidate)))
      names.add(nameKey(name))
      Object.assign(note, { name, changed: true })
    }
  }

  return {
    folders: folderItems.filter(item => item.changed).map(item => ({ id: item.id, parentId: item.folderId, trash: item.trashed })),
    files: fileItems.filter(item => item.changed).map(item => ({ id: item.id, folderId: item.folderId, name: item.name })),
  }
}
