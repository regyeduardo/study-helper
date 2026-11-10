import { useEffect, useMemo } from 'react'

import type { FileMeta, FolderMeta } from '@/types/domain'
import { isNote } from '@/lib/family'
import { LOW_MASTERY_BELOW, REVIEW_BELOW } from '@/lib/file-types'
import { filterLibrary, type FilterSource, type PlaceContext } from '@/lib/library-filters'
import { indexSome, type SearchHit, searchLibrary, searchWords } from '@/lib/library-search'
import type { View } from '@/lib/paths'
import { fileBytes, folderBytes } from '@/lib/storage/file-sizes'
import { liveFiles, liveFolders, type OpenedFile, useLibraryStore } from '@/stores/library'
import { useUiStore } from '@/stores/ui'

export interface FolderTile {
  folder: FolderMeta
  files: number
  subfolders: number
  bytes: number
}

function descendants(folders: FolderMeta[], id: string): string[] {
  return [id, ...folders.filter(folder => folder.parentId === id).flatMap(folder => descendants(folders, folder.id))]
}

let live: { files: FileMeta[]; folders: FolderMeta[]; value: { files: FileMeta[]; folders: FolderMeta[] } } | null = null

/** What is not in the Lixeira; the same lists for every screen while the library is the same, so what is derived of them is computed once. */
export function useLiveLibrary() {
  const files = useLibraryStore(state => state.files)
  const folders = useLibraryStore(state => state.folders)
  return useMemo(() => {
    if (!live || live.files !== files || live.folders !== folders) live = { files, folders, value: { files: liveFiles(files, folders), folders: liveFolders(folders) } }
    return live.value
  }, [files, folders])
}

/** The files directly in the folders or anywhere below them. */
export function filesInside(files: FileMeta[], folders: FolderMeta[], folderIds: string[]): FileMeta[] {
  const ids = new Set(folderIds.flatMap(id => descendants(folders, id)))
  return files.filter(file => file.folderId && ids.has(file.folderId))
}

/** What `filterLibrary` needs of the library; `only` is up to each list. The same object while the library is the same. */
export function useFilterSource(): FilterSource & { library: PlaceContext['library']; localMedia: string[] } {
  const files = useLibraryStore(state => state.files)
  const folders = useLibraryStore(state => state.folders)
  const media = useLibraryStore(state => state.localMedia)
  const library = useLibraryStore(state => (state.repo?.kind === 'drive' ? 'drive' : 'navegador'))
  const timeZone = useLibraryStore(state => state.index.settings.timezone)
  return useMemo(() => ({ files, folders, localMedia: media.flatMap(item => item.fileIds), library, timeZone, now: Date.now() }), [files, folders, media, library, timeZone])
}

export function useFileBytes(file: FileMeta): number {
  const stored = useLibraryStore(state => state.sizes[file.id])
  const media = useLibraryStore(state => state.localMedia)
  return fileBytes(file, stored, media)
}

export function useFolderPath(folderId: string | null): FolderMeta[] {
  const { folders } = useLiveLibrary()
  return useMemo(() => {
    const byId = new Map(folders.map(folder => [folder.id, folder]))
    const path: FolderMeta[] = []
    let current = folderId ? byId.get(folderId) : undefined
    while (current && path.length < 64) {
      path.unshift(current)
      current = current.parentId ? byId.get(current.parentId) : undefined
    }
    return path
  }, [folders, folderId])
}

export function usePathName() {
  const { folders } = useLiveLibrary()
  return useMemo(() => {
    const byId = new Map(folders.map(folder => [folder.id, folder]))
    return (folderId: string | null) => {
      const names: string[] = []
      let current = folderId ? byId.get(folderId) : undefined
      while (current && names.length < 64) {
        names.unshift(current.name)
        current = current.parentId ? byId.get(current.parentId) : undefined
      }
      return names.length ? names.join(' › ') : 'Biblioteca'
    }
  }, [folders])
}

/** What the content search reads, as one text for a plain "contains": a note's text; of an entrada, only its transcription (FR-053). */
export function searchTextOf(file: FileMeta, opened: OpenedFile | undefined): string {
  if (isNote(file)) return opened?.content ?? ''
  return [opened?.sidecar.transcript ?? '', ...(opened?.sidecar.recording?.blocks ?? []).map(block => block.text)].join(' ')
}

const READ_AT_ONCE = 6
/** The texts read for the search reach the store in batches: one change per batch, not one per item. */
const BATCH_MS = 100
/** Each slice of the index, between keystrokes. */
const INDEX_SLICE_MS = 8
const reading = new Set<string>()
const unreadable = new Set<string>()
let indexing: ReturnType<typeof setTimeout> | null = null

/** Indexes what was read, a slice at a time, so the first search after reading only compares. */
function indexInSlices() {
  if (indexing) return
  const step = () => {
    const { files, opened } = useLibraryStore.getState()
    indexing = indexSome(files, opened, INDEX_SLICE_MS) ? null : setTimeout(step, 0)
  }
  indexing = setTimeout(step, 0)
}

/**
 * Reads what the search needs of every item not opened yet, a few at a time, and indexes it (FR-075). Called when the person goes to
 * the search box too: by the time a word is typed, the search only compares. Returns how to stop asking for more.
 */
export function readForSearch(): () => void {
  const state = useLibraryStore.getState()
  const repo = state.repo
  if (!repo || state.sharedView) return () => undefined
  const missing = liveFiles(state.files, state.folders)
    .map(file => file.id)
    .filter(id => !state.opened[id] && !reading.has(id) && !unreadable.has(id))
  if (!missing.length) {
    indexInSlices()
    return () => undefined
  }
  let wanted = true
  let next = 0
  let ready: Record<string, OpenedFile> = {}
  let failed = false
  const flush = () => {
    const batch = ready
    ready = {}
    if ((!Object.keys(batch).length && !failed) || useLibraryStore.getState().repo !== repo) return
    failed = false
    // what was opened meanwhile is fresher than what was read
    useLibraryStore.setState(current => ({ opened: { ...batch, ...current.opened } }))
    indexInSlices()
  }
  const timer = setInterval(flush, BATCH_MS)
  const read = async () => {
    while (wanted && next < missing.length) {
      const id = missing[next++]
      reading.add(id)
      try {
        const [content, sidecar] = await Promise.all([repo.readContent(id), repo.readSidecar(id)])
        ready[id] = { content, sidecar }
      } catch {
        unreadable.add(id)
        failed = true
      } finally {
        reading.delete(id)
      }
    }
  }
  void Promise.all(Array.from({ length: READ_AT_ONCE }, read)).then(() => {
    clearInterval(timer)
    flush()
  })
  return () => {
    wanted = false
  }
}

/** How many items the search has not read yet. */
export function useSearchPending(): number {
  const { files } = useLiveLibrary()
  const opened = useLibraryStore(state => state.opened)
  return useMemo(() => files.filter(file => !opened[file.id] && !unreadable.has(file.id)).length, [files, opened])
}

const NO_HITS = new Map<string, SearchHit>()

/** Every item of the library with all the words of the query (FR-074), reading the texts it does not have yet. */
export function useSearchHits(query: string): Map<string, SearchHit> {
  const { files } = useLiveLibrary()
  const opened = useLibraryStore(state => state.opened)
  const searching = searchWords(query).length > 0
  useEffect(() => (searching ? readForSearch() : undefined), [searching, files])
  return useMemo(() => (searching ? searchLibrary(files, opened, query) : NO_HITS), [searching, files, opened, query])
}

export function folderHitCounts(hits: Map<string, SearchHit>, files: FileMeta[], folders: FolderMeta[]): Map<string, number> {
  const parentOf = new Map(folders.map(folder => [folder.id, folder.parentId]))
  const counts = new Map<string, number>()
  for (const file of files) {
    if (!hits.has(file.id)) continue
    for (let id = file.folderId, steps = 0; id && steps < 64; id = parentOf.get(id) ?? null, steps++) counts.set(id, (counts.get(id) ?? 0) + 1)
  }
  return counts
}

export function useLibraryView(view: View, folderId: string | null) {
  const { files, folders } = useLiveLibrary()
  const contents = useLibraryStore(state => state.opened)
  const sizes = useLibraryStore(state => state.sizes)
  const media = useLibraryStore(state => state.localMedia)
  const { query, types, lowMastery, tag, sort, filters } = useUiStore()
  const source = useFilterSource()
  const trimmed = query.trim().toLowerCase()

  return useMemo(() => {
    const folder = folders.find(item => item.id === folderId) ?? null
    // the Pasta filter looks beyond the folder being browsed, as in the explorer
    const browsing = view === 'folder' && !trimmed && !filters.folders.length
    // the lists of the layouts are of notes, as the folder of the explorer (FR-073); a search also finds an entrada by what was said in it
    let list = trimmed ? files : files.filter(isNote)
    if (browsing) list = list.filter(file => file.folderId === folderId)
    if (view === 'review') list = list.filter(file => isNote(file) && file.mastery !== null && file.mastery < REVIEW_BELOW)
    if (view === 'favorites') list = list.filter(file => file.favorite)
    if (types.size) list = list.filter(file => types.has(file.type))
    if (tag) list = list.filter(file => file.tags.includes(tag))
    if (lowMastery) list = list.filter(file => file.mastery !== null && file.mastery < LOW_MASTERY_BELOW)
    if (trimmed) list = list.filter(file => `${file.name} ${file.description} ${file.tags.join(' ')} ${searchTextOf(file, contents[file.id])}`.toLowerCase().includes(trimmed))

    // the panel's filters, with the counts of what is left to filter
    const result = filterLibrary({ ...source, only: new Set(list.map(file => file.id)), foundEntries: Boolean(trimmed) }, { ...filters, scope: 'notas' })
    const kept = new Set(result.items.map(file => file.id))
    list = list.filter(file => kept.has(file.id))

    const sorted = [...list]
    if (sort === 'recent') sorted.sort((a, b) => b.updated.at.localeCompare(a.updated.at))
    else if (sort === 'title') sorted.sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'))
    else sorted.sort((a, b) => (a.mastery ?? 101) - (b.mastery ?? 101))

    const tiles: FolderTile[] = browsing
      ? folders
          .filter(item => item.parentId === folderId)
          .sort((a, b) => a.position - b.position || a.name.localeCompare(b.name, 'pt-BR'))
          .map(item => {
            const ids = new Set(descendants(folders, item.id))
            return {
              folder: item,
              files: files.filter(file => file.folderId && ids.has(file.folderId)).length,
              subfolders: folders.filter(other => other.parentId === item.id).length,
              bytes: folderBytes(item.id, folders, files, file => fileBytes(file, sizes[file.id], media)),
            }
          })
      : []

    const filtering = Boolean(types.size || lowMastery || tag || trimmed || result.active.length)
    const hideFiles = browsing && !sorted.length && tiles.length > 0 && !filtering
    return { folder, files: sorted, tiles, filtering, hideFiles, browsing, result }
  }, [files, folders, contents, sizes, media, view, folderId, trimmed, types, lowMastery, tag, sort, filters, source])
}
