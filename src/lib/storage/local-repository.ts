import type { FileSidecar, FolderMeta, LibraryIndex, Snapshot } from '@/types/domain'
import { defaultIndex } from '@/lib/defaults'
import { newId } from '@/lib/ids'
import { deleteDatabase, KeyValueStore } from '@/lib/storage/idb'
import {
  bytesOf,
  type ConflictResolver,
  type RemoteChanges,
  type Repository,
  StorageLimitError,
  type StorageUsage,
  type StoredSize,
  type StoredSource,
} from '@/lib/storage/repository'

export const LOCAL_ACCOUNT_ID = 'local'
const INDEX_KEY = 'index'

export class LocalRepository implements Repository {
  readonly kind = 'local' as const
  readonly accountId = LOCAL_ACCOUNT_ID
  private readonly db: KeyValueStore

  constructor(private readonly databaseName = 'study-helper-local') {
    this.db = new KeyValueStore(databaseName)
  }

  async load(): Promise<Snapshot> {
    const [folders, sidecars, index] = await Promise.all([
      this.db.all<FolderMeta>('folders'),
      this.db.all<FileSidecar>('files'),
      this.db.get<LibraryIndex>('index', INDEX_KEY),
    ])
    if (!index) await this.db.put('index', INDEX_KEY, defaultIndex())
    void persistStorage()
    return {
      folders,
      files: sidecars.map(sidecar => sidecar.meta),
      index: index ?? (await this.db.get<LibraryIndex>('index', INDEX_KEY))!,
    }
  }

  async readContent(fileId: string): Promise<string> {
    return (await this.db.get<string>('contents', fileId)) ?? ''
  }

  async readSidecar(fileId: string): Promise<FileSidecar> {
    const sidecar = await this.db.get<FileSidecar>('files', fileId)
    if (!sidecar) throw new Error('Arquivo não encontrado.')
    return sidecar
  }

  async saveFile(sidecar: FileSidecar, content?: string): Promise<FileSidecar> {
    const growth = await this.growthOf(sidecar, content)
    await this.ensureRoom(growth)
    await this.db.put('files', sidecar.meta.id, sidecar)
    if (content !== undefined) await this.db.put('contents', sidecar.meta.id, content)
    return sidecar
  }

  async removeFile(fileId: string): Promise<void> {
    await Promise.all([this.db.delete('files', fileId), this.db.delete('contents', fileId)])
  }

  async saveFolder(folder: FolderMeta): Promise<void> {
    await this.db.put('folders', folder.id, folder)
  }

  async removeFolder(folderId: string): Promise<void> {
    await this.db.delete('folders', folderId)
  }

  async saveIndex(index: LibraryIndex): Promise<void> {
    await this.db.put('index', INDEX_KEY, index)
  }

  async putSource(_fileId: string, blob: Blob): Promise<StoredSource> {
    await this.ensureRoom(blob.size)
    const ref = newId()
    await this.db.put('sources', ref, blob)
    return { ref }
  }

  async getSource(ref: string): Promise<Blob> {
    const blob = await this.db.get<Blob>('sources', ref)
    if (!blob) throw new Error('A fonte não está mais guardada neste navegador.')
    return blob
  }

  async removeSource(ref: string): Promise<void> {
    await this.db.delete('sources', ref)
  }

  async usage(): Promise<StorageUsage> {
    const index = await this.db.get<LibraryIndex>('index', INDEX_KEY)
    const estimate = navigator.storage?.estimate ? await navigator.storage.estimate() : null
    return {
      appBytes: await this.measuredBytes(),
      limitBytes: index?.settings.storageLimitBytes ?? null,
      cloudUsedBytes: null,
      cloudTotalBytes: estimate?.quota ?? null,
    }
  }

  async fileSizes(fileIds?: string[]): Promise<Record<string, StoredSize>> {
    const ids = fileIds ?? (await this.db.keys('files'))
    const sizes: Record<string, StoredSize> = {}
    await Promise.all(
      ids.map(async fileId => {
        const [content, sidecar] = await Promise.all([this.db.get<string>('contents', fileId), this.db.get<FileSidecar>('files', fileId)])
        if (sidecar) sizes[fileId] = { noteBytes: bytesOf(content ?? '') + bytesOf(JSON.stringify(sidecar)), sourceBytes: 0 }
      }),
    )
    return sizes
  }

  async pullChanges(): Promise<RemoteChanges> {
    return { snapshot: await this.load(), changedFileIds: [] }
  }

  setConflictResolver(_resolver: ConflictResolver): void {}

  async forget(): Promise<void> {
    await deleteDatabase(this.databaseName)
  }

  private async measuredBytes(): Promise<number> {
    const [contents, sidecars, sources] = await Promise.all([this.db.all<string>('contents'), this.db.all<FileSidecar>('files'), this.db.all<Blob>('sources')])
    return contents.reduce((sum, text) => sum + bytesOf(text), 0) + bytesOf(JSON.stringify(sidecars)) + sources.reduce((sum, blob) => sum + blob.size, 0)
  }

  private async growthOf(sidecar: FileSidecar, content?: string): Promise<number> {
    if (content === undefined) return 0
    const previous = (await this.db.get<string>('contents', sidecar.meta.id)) ?? ''
    return bytesOf(content) - bytesOf(previous)
  }

  private async ensureRoom(growth: number): Promise<void> {
    if (growth <= 0) return
    const { appBytes, limitBytes, cloudTotalBytes } = await this.usage()
    const ceiling = limitBytes ?? cloudTotalBytes
    if (ceiling !== null && appBytes + growth > ceiling) {
      throw new StorageLimitError(growth, appBytes + growth - ceiling)
    }
  }
}

async function persistStorage(): Promise<void> {
  try {
    if (navigator.storage?.persist && !(await navigator.storage.persisted())) await navigator.storage.persist()
  } catch {
    return
  }
}
