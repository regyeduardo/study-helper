import type { FileMeta, FolderMeta, Place } from '@/types/domain'

/** The place of the library itself: Google Drive for who signed in with Google, else Local (spec 003, FR-052, R16). */
export function rootPlace(signedIn: boolean): Place {
  return signedIn ? 'drive' : 'local'
}

/** A folder's own choice, else the one of the folder above, up to the root. A loop in the data stops where it closes. */
export function folderPlaceOf(folderId: string | null, folders: FolderMeta[], root: Place): Place {
  const byId = new Map(folders.map(folder => [folder.id, folder]))
  const seen = new Set<string>()
  let current = folderId ? byId.get(folderId) : undefined
  while (current && !seen.has(current.id)) {
    if (current.place) return current.place
    seen.add(current.id)
    current = current.parentId ? byId.get(current.parentId) : undefined
  }
  return root
}

/** A note's own choice, else its folder's. Its artifacts, Prova, marks and transcript live in its sidecar, so always with it (FR-053). */
export function filePlaceOf(file: Pick<FileMeta, 'place' | 'folderId'>, folders: FolderMeta[], root: Place): Place {
  return file.place ?? folderPlaceOf(file.folderId, folders, root)
}

/** Folders holding items in more than one place, and every folder above them (FR-053: the window marks them). The Lixeira does not count. */
export function mixedFolderIds(folders: FolderMeta[], files: FileMeta[], root: Place): Set<string> {
  const live = folders.filter(folder => !folder.deletedAt)
  const places = new Map<string, Set<Place>>(live.map(folder => [folder.id, new Set([folderPlaceOf(folder.id, live, root)])]))
  const byId = new Map(live.map(folder => [folder.id, folder]))
  const climb = (folderId: string | null, place: Place) => {
    const seen = new Set<string>()
    let current = folderId ? byId.get(folderId) : undefined
    while (current && !seen.has(current.id)) {
      seen.add(current.id)
      places.get(current.id)!.add(place)
      current = current.parentId ? byId.get(current.parentId) : undefined
    }
  }
  for (const folder of live) climb(folder.parentId, folderPlaceOf(folder.id, live, root))
  for (const file of files) if (!file.deletedAt) climb(file.folderId, filePlaceOf(file, live, root))
  return new Set([...places].filter(([, found]) => found.size > 1).map(([id]) => id))
}

export type PlaceAnswer = 'ok' | 'entrar' | 'liberar'

/** Local is always there; Google Drive asks to sign in first; App only for an account the code freed (FR-052). */
export function placeChoice(place: Place, account: { signedIn: boolean; appAllowed: boolean }): PlaceAnswer {
  if (place === 'app') return account.appAllowed ? 'ok' : 'liberar'
  if (place === 'drive') return account.signedIn ? 'ok' : 'entrar'
  return 'ok'
}
