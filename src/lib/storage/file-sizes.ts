import type { FileMeta, FolderMeta } from '@/types/domain'
import type { LocalMedia } from '@/lib/recording/media-library'
import type { StoredSize } from '@/lib/storage/repository'

export function fileBytes(meta: FileMeta, stored: StoredSize | undefined, media: LocalMedia[]): number {
  const origin = meta.origin
  const inDrive = origin?.storage === 'drive' && !origin.removedAt ? stored?.sourceBytes || origin.sizeBytes || 0 : 0
  const inBrowser = media.filter(item => item.fileIds.includes(meta.id)).reduce((sum, item) => sum + item.size, 0)
  return (stored?.noteBytes ?? 0) + Math.max(inDrive, inBrowser)
}

export function folderBytes(folderId: string, folders: FolderMeta[], files: FileMeta[], sizeOf: (file: FileMeta) => number): number {
  const own = files.filter(file => file.folderId === folderId).reduce((sum, file) => sum + sizeOf(file), 0)
  return folders.filter(folder => folder.parentId === folderId).reduce((sum, folder) => sum + folderBytes(folder.id, folders, files, sizeOf), own)
}
