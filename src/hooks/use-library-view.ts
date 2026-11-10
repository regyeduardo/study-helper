import { useEffect, useMemo } from 'react'

import type { FileMeta, FolderMeta } from '@/types/domain'
import { isNote } from '@/lib/family'
import { LOW_MASTERY_BELOW, REVIEW_BELOW } from '@/lib/file-types'
import { filterLibrary, type FilterSource, type PlaceContext } from '@/lib/library-filters'
import { type SearchHit, type SearchSource, searchFile, searchWords } from '@/lib/library-search'
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

export function useLiveLibrary() {
  const files = useLibraryStore(state => state.files)
  const folders = useLibraryStore(state => state.folders)
  return useMemo(() => ({ files: liveFiles(files, folders), folders: liveFolders(folders) }), [files, folders])
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

/** What the content search reads: a note's text; of an entrada, only its transcription (FR-053), never its own text. */
export function searchSourceOf(file: FileMeta, opened: OpenedFile | undefined): SearchSource | undefined {
  return opened && !isNote(file) ? { content: opened.sidecar.transcript ?? '', sidecar: opened.sidecar } : opened
}

/** The same, as one text for a plain "contains". */
export function searchTextOf(file: FileMeta, opened: OpenedFile | undefined): string {
  if (isNote(file)) return opened?.content ?? ''
  return [opened?.sidecar.transcript ?? '', ...(opened?.sidecar.recording?.blocks ?? []).map(block => block.text)].join(' ')
}

const LOAD_AT_ONCE = 4
const loading = new Set<string>()

export function useSearchHits(query: string): Map<string, SearchHit> {
  const { files } = useLiveLibrary()
  const opened = useLibraryStore(state => state.opened)
  const openFile = useLibraryStore(state => state.openFile)
  const searching = searchWords(query).length > 0
  useEffect(() => {
    if (!searching) return
    // the entradas too: what was said in them is searched
    const missing = files.filter(file => !useLibraryStore.getState().opened[file.id] && !loading.has(file.id))
    let next = 0
    let alive = true
    const load = async () => {
      while (alive && next < missing.length) {
        const id = missing[next++].id
        loading.add(id)
        await openFile(id)
          .catch(() => undefined)
          .finally(() => loading.delete(id))
      }
    }
    void Promise.all(Array.from({ length: LOAD_AT_ONCE }, load))
    return () => {
      alive = false
    }
  }, [searching, files, openFile])
  return useMemo(() => {
    const hits = new Map<string, SearchHit>()
    if (!searching) return hits
    for (const file of files) {
      const hit = searchFile(file, searchSourceOf(file, opened[file.id]), query)
      if (hit) hits.set(file.id, hit)
    }
    return hits
  }, [searching, files, opened, query])
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
    let list = files
    if (browsing) list = list.filter(file => file.folderId === folderId)
    if (view === 'review') list = list.filter(file => isNote(file) && file.mastery !== null && file.mastery < REVIEW_BELOW)
    if (view === 'favorites') list = list.filter(file => file.favorite)
    if (types.size) list = list.filter(file => types.has(file.type))
    if (tag) list = list.filter(file => file.tags.includes(tag))
    if (lowMastery) list = list.filter(file => file.mastery !== null && file.mastery < LOW_MASTERY_BELOW)
    if (trimmed) list = list.filter(file => `${file.name} ${file.description} ${file.tags.join(' ')} ${searchTextOf(file, contents[file.id])}`.toLowerCase().includes(trimmed))

    // the panel's filters, with the counts of what is left to filter
    const result = filterLibrary({ ...source, only: new Set(list.map(file => file.id)) }, filters)
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

    const filtering = Boolean(types.size || lowMastery || tag || trimmed || result.active.length || filters.scope !== 'tudo')
    const hideFiles = browsing && !sorted.length && tiles.length > 0 && !filtering
    return { folder, files: sorted, tiles, filtering, hideFiles, browsing, result }
  }, [files, folders, contents, sizes, media, view, folderId, trimmed, types, lowMastery, tag, sort, filters, source])
}
