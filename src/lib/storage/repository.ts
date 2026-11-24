import type { FileSidecar, FolderMeta, LibraryIndex, Snapshot } from '@/types/domain'
import { formatBytes } from '@/utils/format'

export interface StorageUsage {
  appBytes: number
  limitBytes: number | null
  cloudUsedBytes: number | null
  cloudTotalBytes: number | null
}

export interface StoredSize {
  noteBytes: number
  sourceBytes: number
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

/**
 * A media going from one place to another (a change of place): how much went, and Cancelar. The person waits for it in the window, so
 * the bar moves with the bytes and Cancelar stops it at once (24/11, the owner: "ficou 0% por muito tempo, cancelei, demorou séculos").
 */
export interface Transfer {
  signal?: AbortSignal
  onProgress?: (doneBytes: number, totalBytes: number) => void
  /** The size the media should have, for a download whose answer does not say it. */
  sizeBytes?: number
}

/** A download read as it arrives, telling the bytes; Cancelar (the signal of the request) stops it in the middle. */
export async function countedBlob(response: Response, transfer?: Transfer): Promise<Blob> {
  const onProgress = transfer?.onProgress
  if (!onProgress || !response.body) return response.blob()
  const total = Number(response.headers.get('Content-Length')) || transfer.sizeBytes || 0
  let done = 0
  onProgress(0, total)
  const counted = response.body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        done += chunk.byteLength
        onProgress(done, Math.max(total, done))
        controller.enqueue(chunk)
      },
    }),
  )
  return new Response(counted, { headers: { 'Content-Type': response.headers.get('Content-Type') ?? '' } }).blob()
}

export interface Repository {
  readonly kind: 'local' | 'drive' | 'app'
  readonly accountId: string
  load(): Promise<Snapshot>
  readContent(fileId: string): Promise<string>
  readSidecar(fileId: string): Promise<FileSidecar>
  saveFile(sidecar: FileSidecar, content?: string): Promise<FileSidecar>
  removeFile(fileId: string): Promise<void>
  saveFolder(folder: FolderMeta): Promise<void>
  removeFolder(folderId: string): Promise<void>
  saveIndex(index: LibraryIndex): Promise<void>
  putSource(fileId: string, blob: Blob, name: string, transfer?: Transfer): Promise<StoredSource>
  getSource(ref: string, transfer?: Transfer): Promise<Blob>
  removeSource(ref: string): Promise<void>
  usage(): Promise<StorageUsage>
  fileSizes(fileIds?: string[]): Promise<Record<string, StoredSize>>
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
