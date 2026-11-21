import type { FileMeta, FileSidecar, FolderMeta, LibraryIndex, Place, Snapshot } from '@/types/domain'
import { DriveRepository } from '@/lib/storage/drive-repository'
import { LocalRepository } from '@/lib/storage/local-repository'
import { filePlaceOf, folderPlaceOf } from '@/lib/storage/place'
import type { ConflictResolver, RemoteChanges, Repository, StorageUsage, StoredSize, StoredSource } from '@/lib/storage/repository'

/** Where an item is kept right now: the account's Google Drive or this browser (Local). */
export type Side = 'drive' | 'local'

const sideOfPlace = (place: Place): Side => (place === 'local' ? 'local' : 'drive')

/**
 * The library of a Google account (spec 003, história 9, R16): its Google Drive and this browser's Local in one tree. Each write goes to the
 * place of the item; an item already kept somewhere stays there until a move (moves.ts) takes it. Local never reaches the Drive: a note or
 * folder kept in the Drive inside a Local folder sits, in the Drive, in the nearest Drive folder above and keeps the real one in
 * `awayFolderId`/`awayParentId`, which only this browser can follow.
 */
export class CombinedRepository implements Repository {
  readonly kind = 'drive' as const
  private readonly sides = new Map<string, Side>()
  private readonly folders = new Map<string, FolderMeta>()
  /** During a move an item is on both sides: the journal says which one the library shows. */
  private showing: (id: string) => Side | undefined = () => undefined

  constructor(
    readonly drive: Repository,
    readonly local: Repository,
  ) {}

  get accountId(): string {
    return this.drive.accountId
  }

  /** Which Drive folder the library uses (the hidden one or `.sync-study-helper`). */
  get space(): DriveRepository['space'] | undefined {
    return this.drive instanceof DriveRepository ? this.drive.space : undefined
  }

  /** The devices of the account live in its Drive. */
  listDevices(): ReturnType<DriveRepository['listDevices']> {
    return this.drive instanceof DriveRepository ? this.drive.listDevices() : Promise.resolve([])
  }

  heartbeat(device: Parameters<DriveRepository['heartbeat']>[0]): Promise<void> {
    return this.drive instanceof DriveRepository ? this.drive.heartbeat(device) : Promise.resolve()
  }

  /** The index as it is in the Drive, without this browser's copy. */
  indexFromDrive(): Promise<LibraryIndex | null> {
    return this.drive instanceof DriveRepository ? this.drive.indexFromDrive() : Promise.resolve(null)
  }

  removeDevice(deviceId: string): Promise<void> {
    return this.drive instanceof DriveRepository ? this.drive.removeDevice(deviceId) : Promise.resolve()
  }

  setShowing(showing: (id: string) => Side | undefined): void {
    this.showing = showing
  }

  sideOf(id: string): Side | undefined {
    return this.sides.get(id)
  }

  /** After a move, the item lives on the other side. */
  adopt(id: string, side: Side): void {
    this.sides.set(id, side)
  }

  async load(): Promise<Snapshot> {
    const [drive, local] = await Promise.all([this.drive.load(), this.local.load()])
    return this.merge(drive, local)
  }

  async pullChanges(): Promise<RemoteChanges> {
    const [{ snapshot, changedFileIds }, local] = await Promise.all([this.drive.pullChanges(), this.local.load()])
    return { snapshot: this.merge(snapshot, local), changedFileIds }
  }

  async readContent(fileId: string): Promise<string> {
    return this.repoOf(fileId).readContent(fileId)
  }

  async readSidecar(fileId: string): Promise<FileSidecar> {
    const side = this.sides.get(fileId) ?? 'drive'
    const sidecar = await this.repoOf(fileId).readSidecar(fileId)
    return side === 'drive' ? { ...sidecar, meta: this.trueFile(sidecar.meta) } : sidecar
  }

  async saveFile(sidecar: FileSidecar, content?: string): Promise<FileSidecar> {
    const meta = sidecar.meta
    return this.writeFileTo(this.sides.get(meta.id) ?? sideOfPlace(filePlaceOf(meta, [...this.folders.values()], 'drive')), sidecar, content)
  }

  /** Writes a note to one side, whatever side it is on now: a move copies with it before taking the item out of the other side. */
  async writeFileTo(side: Side, sidecar: FileSidecar, content?: string): Promise<FileSidecar> {
    const meta = sidecar.meta
    if (side === 'local') {
      const { awayFolderId: _away, ...plain } = meta
      const saved = await this.local.saveFile({ ...sidecar, meta: plain }, content)
      if (!this.sides.has(meta.id)) this.sides.set(meta.id, 'local')
      return saved
    }
    const folderId = this.driveFolderOf(meta.folderId)
    const away = folderId !== meta.folderId ? (meta.folderId ?? undefined) : meta.awayFolderId && !this.folders.has(meta.awayFolderId) ? meta.awayFolderId : undefined
    const { awayFolderId: _old, ...rest } = meta
    const saved = await this.drive.saveFile({ ...sidecar, meta: { ...rest, folderId, ...(away ? { awayFolderId: away } : {}) } }, content)
    if (!this.sides.has(meta.id)) this.sides.set(meta.id, 'drive')
    return { ...saved, meta: this.trueFile(saved.meta) }
  }

  /** Reads a note from one side (a move checks what arrived). */
  async readFrom(side: Side, fileId: string): Promise<{ content: string; sidecar: FileSidecar }> {
    const repo = side === 'local' ? this.local : this.drive
    const [content, sidecar] = await Promise.all([repo.readContent(fileId), repo.readSidecar(fileId)])
    return { content, sidecar: side === 'drive' ? { ...sidecar, meta: this.trueFile(sidecar.meta) } : sidecar }
  }

  /** Takes a note out of one side only. */
  async removeFrom(side: Side, fileId: string): Promise<void> {
    await (side === 'local' ? this.local : this.drive).removeFile(fileId)
  }

  async removeFile(fileId: string): Promise<void> {
    await this.repoOf(fileId).removeFile(fileId)
    this.sides.delete(fileId)
  }

  async saveFolder(folder: FolderMeta): Promise<void> {
    const tree = [...this.folders.values()].filter(item => item.id !== folder.id).concat(folder)
    await this.writeFolderTo(this.sides.get(folder.id) ?? sideOfPlace(folderPlaceOf(folder.id, tree, 'drive')), folder)
  }

  async writeFolderTo(side: Side, folder: FolderMeta): Promise<void> {
    if (side === 'local') {
      const { awayParentId: _away, ...plain } = folder
      await this.local.saveFolder(plain)
    } else {
      const parentId = this.driveFolderOf(folder.parentId)
      const away = parentId !== folder.parentId ? (folder.parentId ?? undefined) : folder.awayParentId && !this.folders.has(folder.awayParentId) ? folder.awayParentId : undefined
      const { awayParentId: _old, ...rest } = folder
      await this.drive.saveFolder({ ...rest, parentId, ...(away ? { awayParentId: away } : {}) })
    }
    if (!this.sides.has(folder.id)) this.sides.set(folder.id, side)
    this.folders.set(folder.id, folder)
  }

  /**
   * Takes a folder out of one side only. Deleting a Drive folder deletes what is inside it in the Drive, so a Drive folder that still
   * holds a note or a folder is never deleted: the move fails with the reason and nothing is lost.
   */
  async removeFolderFrom(side: Side, folderId: string): Promise<void> {
    if (side === 'drive' && this.drive instanceof DriveRepository && this.drive.holdsItems(folderId)) throw new Error('A pasta ainda tem itens no Google Drive; nada foi apagado.')
    await (side === 'local' ? this.local : this.drive).removeFolder(folderId)
  }

  async removeFolder(folderId: string): Promise<void> {
    await (this.sides.get(folderId) === 'local' ? this.local : this.drive).removeFolder(folderId)
    this.sides.delete(folderId)
    this.folders.delete(folderId)
  }

  async saveIndex(index: LibraryIndex): Promise<void> {
    await this.drive.saveIndex(index)
  }

  async putSource(fileId: string, blob: Blob, name: string): Promise<StoredSource> {
    return this.repoOf(fileId).putSource(fileId, blob, name)
  }

  async getSource(ref: string): Promise<Blob> {
    return (await this.inLocal(ref)) ? this.local.getSource(ref) : this.drive.getSource(ref)
  }

  async removeSource(ref: string): Promise<void> {
    await ((await this.inLocal(ref)) ? this.local.removeSource(ref) : this.drive.removeSource(ref))
  }

  async usage(): Promise<StorageUsage> {
    return this.drive.usage()
  }

  async fileSizes(fileIds?: string[]): Promise<Record<string, StoredSize>> {
    if (!fileIds) {
      const [drive, local] = await Promise.all([this.drive.fileSizes(), this.local.fileSizes()])
      return { ...drive, ...local }
    }
    const local = fileIds.filter(id => this.sides.get(id) === 'local')
    const drive = fileIds.filter(id => this.sides.get(id) !== 'local')
    const [fromDrive, fromLocal] = await Promise.all([drive.length ? this.drive.fileSizes(drive) : {}, local.length ? this.local.fileSizes(local) : {}])
    return { ...fromDrive, ...fromLocal }
  }

  setConflictResolver(resolver: ConflictResolver): void {
    this.drive.setConflictResolver(resolver)
  }

  /** Forgetting the account clears only the copies of the Drive: what is in Local has no copy anywhere else and stays (FR-055). */
  async forget(): Promise<void> {
    await this.drive.forget()
  }

  private repoOf(id: string): Repository {
    return this.sides.get(id) === 'local' ? this.local : this.drive
  }

  private async inLocal(ref: string): Promise<boolean> {
    return this.local instanceof LocalRepository ? this.local.hasSource(ref) : this.local.getSource(ref).then(() => true, () => false)
  }

  /** The folder itself when it is in the Drive, else the nearest Drive folder above it; null is the root. */
  private driveFolderOf(folderId: string | null): string | null {
    const seen = new Set<string>()
    let current = folderId
    while (current && !seen.has(current)) {
      seen.add(current)
      if (this.sides.get(current) !== 'local') return current
      current = this.folders.get(current)?.parentId ?? null
    }
    return null
  }

  /** A Drive note's real folder, when that Local folder is in this browser. */
  private trueFile(meta: FileMeta): FileMeta {
    if (!meta.awayFolderId || this.sides.get(meta.awayFolderId) !== 'local') return meta
    const { awayFolderId, ...rest } = meta
    return { ...rest, folderId: awayFolderId }
  }

  private merge(drive: Snapshot, local: Snapshot): Snapshot {
    this.sides.clear()
    this.folders.clear()
    const chosen = <T extends { id: string }>(fromDrive: T[], fromLocal: T[]): T[] => {
      const inLocal = new Map(fromLocal.map(item => [item.id, item]))
      const kept: T[] = []
      for (const item of fromDrive) {
        const twin = inLocal.get(item.id)
        if (twin && this.showing(item.id) === 'local') continue
        if (twin) inLocal.delete(item.id)
        this.sides.set(item.id, 'drive')
        kept.push(item)
      }
      for (const item of inLocal.values()) {
        this.sides.set(item.id, 'local')
        kept.push(item)
      }
      return kept
    }
    const folders = chosen(drive.folders, local.folders)
    const files = chosen(drive.files, local.files)
    // the away links resolve only after every side is known
    const trueFolders = folders.map(folder => {
      if (!folder.awayParentId || this.sides.get(folder.awayParentId) !== 'local') return folder
      const { awayParentId, ...rest } = folder
      return { ...rest, parentId: awayParentId }
    })
    for (const folder of trueFolders) this.folders.set(folder.id, folder)
    return { folders: trueFolders, files: files.map(file => (this.sides.get(file.id) === 'drive' ? this.trueFile(file) : file)), index: drive.index }
  }
}

/** The Drive half of the library, for what only the Drive has (devices, heartbeat). */
export function driveOf(repo: Repository | null): DriveRepository | null {
  if (repo instanceof DriveRepository) return repo
  if (repo instanceof CombinedRepository && repo.drive instanceof DriveRepository) return repo.drive
  return null
}
