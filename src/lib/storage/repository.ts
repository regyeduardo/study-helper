import type { FileSidecar, FolderMeta, LibraryIndex, Snapshot } from '@/types/domain'
import { formatBytes } from '@/utils/format'

export interface StorageUsage {
  appBytes: number
  limitBytes: number | null
  cloudUsedBytes: number | null
  cloudTotalBytes: number | null
}

export interface StoredSource {
  ref: string
  url?: string
}

export interface TextConflict {
  kind: 'text'
  fileId: string
  fileName: string
  base: string
  mine: string
  theirs: string
  resolved?: string
  mineStamp: { at: string; deviceName: string }
  theirsStamp: { at: string; deviceName: string }
}

export interface FieldConflict {
  path: string
  label: string
  mine: unknown
  theirs: unknown
  choice?: 'mine' | 'theirs'
}

export interface JsonConflict {
  kind: 'json'
  fileId: string
  fileName: string
  fields: FieldConflict[]
  mineStamp: { at: string; deviceName: string }
  theirsStamp: { at: string; deviceName: string }
}

export type Conflict = TextConflict | JsonConflict

export type ConflictResolver = (conflict: Conflict) => Promise<Conflict>

export interface RemoteChanges {
  snapshot: Snapshot
  changedFileIds: string[]
}

export interface Repository {
  readonly kind: 'local' | 'drive'
  readonly accountId: string
  load(): Promise<Snapshot>
  readContent(fileId: string): Promise<string>
  readSidecar(fileId: string): Promise<FileSidecar>
  saveFile(sidecar: FileSidecar, content?: string): Promise<FileSidecar>
  removeFile(fileId: string): Promise<void>
  saveFolder(folder: FolderMeta): Promise<void>
  removeFolder(folderId: string): Promise<void>
  saveIndex(index: LibraryIndex): Promise<void>
  putSource(fileId: string, blob: Blob, name: string): Promise<StoredSource>
  getSource(ref: string): Promise<Blob>
  removeSource(ref: string): Promise<void>
  usage(): Promise<StorageUsage>
  pullChanges(): Promise<RemoteChanges>
  setConflictResolver(resolver: ConflictResolver): void
  forget(): Promise<void>
}

export class StorageLimitError extends Error {
  constructor(
    readonly neededBytes: number,
    readonly missingBytes: number,
  ) {
    super(`Passou do limite de armazenamento do app: faltam ${formatBytes(missingBytes)}. Aumente o limite nas Configurações ou apague coisas da lixeira.`)
  }
}

export function bytesOf(text: string): number {
  return new Blob([text]).size
}
