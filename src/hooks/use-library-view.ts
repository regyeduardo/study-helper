import { useMemo } from 'react'

import type { FileMeta, FolderMeta } from '@/types/domain'
import { LOW_MASTERY_BELOW, REVIEW_BELOW } from '@/lib/file-types'
import type { View } from '@/lib/paths'
import { fileBytes, folderBytes } from '@/lib/storage/file-sizes'
import { liveFiles, liveFolders, useLibraryStore } from '@/stores/library'
import { useUiStore } from '@/stores/ui'

export interface FolderTile {
  folder: FolderMeta
  files: number
  subfolders: number
  bytes: number
}

export interface CourseGroup {
  module: FolderMeta | null
  files: FileMeta[]
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

export function useLibraryView(view: View, folderId: string | null) {
  const { files, folders } = useLiveLibrary()
  const contents = useLibraryStore(state => state.opened)
  const sizes = useLibraryStore(state => state.sizes)
  const media = useLibraryStore(state => state.localMedia)
  const { query, types, lowMastery, tag, sort } = useUiStore()
  const trimmed = query.trim().toLowerCase()

  return useMemo(() => {
    const folder = folders.find(item => item.id === folderId) ?? null
    const browsing = view === 'folder' && !trimmed
    let list = files
    if (browsing) list = list.filter(file => file.folderId === folderId)
    if (view === 'review') list = list.filter(file => file.mastery !== null && file.mastery < REVIEW_BELOW)
    if (view === 'favorites') list = list.filter(file => file.favorite)
    if (types.size) list = list.filter(file => types.has(file.type))
    if (tag) list = list.filter(file => file.tags.includes(tag))
    if (lowMastery) list = list.filter(file => file.mastery !== null && file.mastery < LOW_MASTERY_BELOW)
    if (trimmed) list = list.filter(file => `${file.name} ${file.description} ${file.tags.join(' ')} ${contents[file.id]?.content ?? ''}`.toLowerCase().includes(trimmed))

    const isCourse = browsing && Boolean(folder?.isCourse)
    const sorted = [...list]
    if (isCourse) sorted.sort((a, b) => a.position - b.position)
    else if (sort === 'recent') sorted.sort((a, b) => b.updated.at.localeCompare(a.updated.at))
    else if (sort === 'title') sorted.sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'))
    else sorted.sort((a, b) => (a.mastery ?? 101) - (b.mastery ?? 101))

    const tiles: FolderTile[] = browsing && !isCourse
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

    const courseGroups: CourseGroup[] = isCourse
      ? [
          { module: null, files: sorted.filter(file => file.folderId === folderId), bytes: 0 },
          ...folders
            .filter(item => item.parentId === folderId)
            .sort((a, b) => a.position - b.position)
            .map(module => ({
              module,
              files: files.filter(file => file.folderId === module.id).sort((a, b) => a.position - b.position),
              bytes: folderBytes(module.id, folders, files, file => fileBytes(file, sizes[file.id], media)),
            })),
        ].filter(group => group.files.length)
      : []

    const filtering = Boolean(types.size || lowMastery || tag || trimmed)
    const hideFiles = browsing && !sorted.length && tiles.length > 0 && !filtering
    return { folder, files: sorted, tiles, isCourse, courseGroups, filtering, hideFiles, browsing }
  }, [files, folders, contents, sizes, media, view, folderId, trimmed, types, lowMastery, tag, sort])
}
