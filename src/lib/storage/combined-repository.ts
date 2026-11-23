import type { FileMeta, FileSidecar, FolderMeta, LibraryIndex, Place, Snapshot } from '@/types/domain'
import { defaultIndex } from '@/lib/defaults'
import { AppRepository, mapMeta } from '@/lib/storage/app-repository'
import { DriveRepository } from '@/lib/storage/drive-repository'
import { fileOfRow, type HierarchyRepository, type HierarchySnapshot } from '@/lib/storage/hierarchy-repository'
import { LocalRepository } from '@/lib/storage/local-repository'
import { defaultPlace, filePlaceOf, folderPlaceOf } from '@/lib/storage/place'
import type { ConflictResolver, RemoteChanges, Repository, StorageUsage, StoredSize, StoredSource } from '@/lib/storage/repository'

/** Where an item is kept right now: the account's Google Drive, this browser (Local) or the App (spec 003, entrega 4). */
export type Side = 'drive' | 'local' | 'app'

/** What the account's hierarchy owns of a note; the rest of its meta goes with its content. */
const TREE_KEYS = ['name', 'folderId', 'parentFileId', 'position', 'deletedAt', 'trashedWith', 'place', 'awayFolderId', 'updated']

/** JSON with the keys in order, to compare two metas that came by different ways. */
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .filter(key => (value as Record<string, unknown>)[key] !== undefined)
      .sort()
      .map(key => `${JSON.stringify(key)}:${stable((value as Record<string, unknown>)[key])}`)
      .join(',')}}`
  }
  return JSON.stringify(value ?? null)
}

const withoutTree = (meta: Record<string, unknown>) => stable(Object.fromEntries(Object.entries(meta).filter(([key]) => !TREE_KEYS.includes(key))))

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
  /** The App, only for an account freed by a code with "Usar a estrutura do app" on; without it, nothing changes. */
  private appRepo: Repository | null = null
  /** Spec 005: the account's hierarchy, once it migrated (`hierarchyAt`); without it, the library works as before. */
  private tree: HierarchyRepository | null = null
  /** Notes in Local whose folder is gone for good from the hierarchy: they show at the root (R6); the warning is a screen still to come. */
  readonly lostFolder = new Set<string>()

  constructor(
    readonly drive: Repository,
    readonly local: Repository,
  ) {}

  get app(): Repository | null {
    return this.appRepo
  }

  /** Turning the app structure on or off; the library loads again after it. */
  setApp(app: Repository | null): void {
    this.appRepo = app
    if (app && this.resolver) app.setConflictResolver(this.resolver)
  }

  get hierarchy(): HierarchyRepository | null {
    return this.tree
  }

  /**
   * Spec 005, after the account's hierarchy migrated: the tree comes from the account's map plus this browser's notes in Local; each
   * note's content goes to its place (App, Google Drive only as content, Local); a folder is only in the hierarchy.
   */
  setHierarchy(hierarchy: HierarchyRepository | null): void {
    this.tree = hierarchy
    if (this.drive instanceof DriveRepository) this.drive.contentOnly = Boolean(hierarchy)
    if (hierarchy && this.resolver) hierarchy.setConflictResolver(this.resolver)
  }

  /** Where a new note is born when nobody chose: the App with the structure on, else the Google Drive (FR-006). */
  defaultSide(): Side {
    return this.sideOfPlace(defaultPlace({ appOn: Boolean(this.appRepo), signedIn: true }))
  }

  /** The repository of one side; App falls back to the Drive when it is off. */
  repoFor(side: Side): Repository {
    if (side === 'local') return this.local
    if (side === 'app' && this.appRepo) return this.appRepo
    return this.drive
  }

  private sideOfPlace(place: Place): Side {
    if (place === 'local') return 'local'
    return place === 'app' && this.appRepo ? 'app' : 'drive'
  }

  private resolver: ConflictResolver | null = null

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
    if (this.tree) {
      // the Drive out (or without sign-in) does not hide the hierarchy: only its notes do not open
      const [tree, drive, local] = await Promise.all([this.tree.load(), this.drive.load().catch(() => null), this.local.load()])
      return this.fromTree(tree, drive, local)
    }
    const [drive, local, app] = await Promise.all([this.drive.load(), this.local.load(), this.appRepo?.load() ?? Promise.resolve(null)])
    return this.merge(drive, local, app)
  }

  async pullChanges(): Promise<RemoteChanges> {
    if (this.tree) {
      const [tree, drive, local] = await Promise.all([this.tree.pullChanges(), this.drive.pullChanges().catch(() => null), this.local.load()])
      return { snapshot: await this.fromTree(tree.snapshot, drive?.snapshot ?? null, local), changedFileIds: [...new Set([...tree.changedFileIds, ...(drive?.changedFileIds ?? [])])] }
    }
    const [{ snapshot, changedFileIds }, local, app] = await Promise.all([this.drive.pullChanges(), this.local.load(), this.appRepo?.pullChanges() ?? Promise.resolve(null)])
    return { snapshot: this.merge(snapshot, local, app?.snapshot ?? null), changedFileIds: [...new Set([...changedFileIds, ...(app?.changedFileIds ?? [])])] }
  }

  async readContent(fileId: string): Promise<string> {
    if (this.tree) return (await this.contentRepo(this.sides.get(fileId) ?? 'drive', fileId)).readContent(fileId)
    return this.repoOf(fileId).readContent(fileId)
  }

  async readSidecar(fileId: string): Promise<FileSidecar> {
    if (this.tree) return (await this.readFrom(this.sides.get(fileId) ?? 'drive', fileId, false)).sidecar
    const side = this.sides.get(fileId) ?? 'drive'
    const sidecar = await this.repoOf(fileId).readSidecar(fileId)
    return side === 'drive' ? { ...sidecar, meta: this.trueFile(sidecar.meta) } : sidecar
  }

  async saveFile(sidecar: FileSidecar, content?: string): Promise<FileSidecar> {
    const meta = sidecar.meta
    // a new note is born in the place chosen, else in the default one; never in "the folder's place" (spec 005, R9)
    if (this.tree) return this.writeFileTo(this.sides.get(meta.id) ?? (meta.place ? this.sideOfPlace(meta.place) : this.defaultSide()), sidecar, content)
    return this.writeFileTo(this.sides.get(meta.id) ?? this.sideOfPlace(filePlaceOf(meta, [...this.folders.values()], 'drive')), sidecar, content)
  }

  /** Writes a note to one side, whatever side it is on now: a move copies with it before taking the item out of the other side. */
  async writeFileTo(side: Side, sidecar: FileSidecar, content?: string): Promise<FileSidecar> {
    const meta = sidecar.meta
    if (this.tree) return this.writeInTree(side, sidecar, content)
    if (side === 'local' || (side === 'app' && this.appRepo)) {
      const { awayFolderId: _away, ...plain } = meta
      const saved = await this.repoFor(side).saveFile({ ...sidecar, meta: plain }, content)
      if (!this.sides.has(meta.id)) this.sides.set(meta.id, side)
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
  async readFrom(side: Side, fileId: string, withContent = true): Promise<{ content: string; sidecar: FileSidecar }> {
    if (this.tree) {
      const repo = await this.contentRepo(side, fileId)
      const [content, sidecar] = await Promise.all([withContent ? repo.readContent(fileId) : '', repo.readSidecar(fileId)])
      return { content, sidecar: side === 'local' ? sidecar : this.withTree(sidecar) }
    }
    const repo = this.repoFor(side)
    const [content, sidecar] = await Promise.all([repo.readContent(fileId), repo.readSidecar(fileId)])
    return { content, sidecar: side === 'drive' ? { ...sidecar, meta: this.trueFile(sidecar.meta) } : sidecar }
  }

  /** Takes a note out of one side only. */
  async removeFrom(side: Side, fileId: string): Promise<void> {
    if (this.tree) return this.removeInTree(side, fileId)
    await this.repoFor(side).removeFile(fileId)
  }

  async removeFile(fileId: string): Promise<void> {
    if (this.tree) {
      await this.removeInTree(this.sides.get(fileId) ?? 'drive', fileId)
      this.sides.delete(fileId)
      return
    }
    await this.repoOf(fileId).removeFile(fileId)
    this.sides.delete(fileId)
  }

  async saveFolder(folder: FolderMeta): Promise<void> {
    if (this.tree) return this.writeFolderTo('drive', folder)
    const tree = [...this.folders.values()].filter(item => item.id !== folder.id).concat(folder)
    await this.writeFolderTo(this.sides.get(folder.id) ?? this.sideOfPlace(folderPlaceOf(folder.id, tree, 'drive')), folder)
  }

  async writeFolderTo(side: Side, folder: FolderMeta): Promise<void> {
    // a folder has no place: it is only in the account's hierarchy
    if (this.tree) {
      const { place: _place, awayParentId: _away, ...plain } = folder
      await this.tree.saveFolder(plain)
      this.folders.set(folder.id, plain)
      return
    }
    if (side === 'local' || (side === 'app' && this.appRepo)) {
      const { awayParentId: _away, ...plain } = folder
      await this.repoFor(side).saveFolder(plain)
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
    if (this.tree) return
    if (side === 'drive' && this.drive instanceof DriveRepository && this.drive.holdsItems(folderId)) throw new Error('A pasta ainda tem itens no Google Drive; nada foi apagado.')
    await this.repoFor(side).removeFolder(folderId)
  }

  async removeFolder(folderId: string): Promise<void> {
    if (this.tree) {
      await this.tree.remove(folderId)
      this.folders.delete(folderId)
      return
    }
    await this.repoFor(this.sides.get(folderId) ?? 'drive').removeFolder(folderId)
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
    if (ref.startsWith('app:') && this.appRepo) return this.appRepo.getSource(ref)
    return (await this.inLocal(ref)) ? this.local.getSource(ref) : this.drive.getSource(ref)
  }

  async removeSource(ref: string): Promise<void> {
    if (ref.startsWith('app:') && this.appRepo) return this.appRepo.removeSource(ref)
    await ((await this.inLocal(ref)) ? this.local.removeSource(ref) : this.drive.removeSource(ref))
  }

  async usage(): Promise<StorageUsage> {
    return this.drive.usage()
  }

  async fileSizes(fileIds?: string[]): Promise<Record<string, StoredSize>> {
    if (this.tree) {
      // the App's sizes are on the map rows
      const app: Record<string, StoredSize> = {}
      for (const file of this.tree.snapshot().files) {
        const row = this.tree.rowOf(file.id)
        if (row?.place === 'app' && (!fileIds || fileIds.includes(file.id))) app[file.id] = { noteBytes: row.noteBytes, sourceBytes: row.mediaBytes }
      }
      const drive = fileIds?.filter(id => this.sides.get(id) === 'drive')
      const local = fileIds?.filter(id => this.sides.get(id) === 'local')
      const [fromDrive, fromLocal] = await Promise.all([!drive || drive.length ? this.drive.fileSizes(drive).catch(() => ({})) : {}, !local || local.length ? this.local.fileSizes(local) : {}])
      return { ...fromDrive, ...app, ...fromLocal }
    }
    if (!fileIds) {
      const [drive, local, app] = await Promise.all([this.drive.fileSizes(), this.local.fileSizes(), this.appRepo?.fileSizes() ?? {}])
      return { ...drive, ...app, ...local }
    }
    const local = fileIds.filter(id => this.sides.get(id) === 'local')
    const app = this.appRepo ? fileIds.filter(id => this.sides.get(id) === 'app') : []
    const drive = fileIds.filter(id => !local.includes(id) && !app.includes(id))
    const [fromDrive, fromLocal, fromApp] = await Promise.all([
      drive.length ? this.drive.fileSizes(drive) : {},
      local.length ? this.local.fileSizes(local) : {},
      app.length && this.appRepo ? this.appRepo.fileSizes(app) : {},
    ])
    return { ...fromDrive, ...fromApp, ...fromLocal }
  }

  setConflictResolver(resolver: ConflictResolver): void {
    this.resolver = resolver
    this.drive.setConflictResolver(resolver)
    this.appRepo?.setConflictResolver(resolver)
    this.tree?.setConflictResolver(resolver)
  }

  /** Forgetting the account clears only the copies of the Drive: what is in Local has no copy anywhere else and stays (FR-055). */
  async forget(): Promise<void> {
    await this.drive.forget()
    await this.appRepo?.forget()
    await this.tree?.forget()
  }

  private repoOf(id: string): Repository {
    return this.repoFor(this.sides.get(id) ?? (this.tree ? this.defaultSide() : 'drive'))
  }

  // ---------- after the migration (spec 005) ----------

  /** The repository that keeps a note's content, ready to read or write it. */
  private async contentRepo(side: Side, fileId: string): Promise<Repository> {
    if (side === 'local') return this.local
    if (side === 'app') {
      const app = this.appRepo
      if (!app) throw new Error('Esta nota está no App. Ligue "Usar a estrutura do app" para abri-la.')
      // the row the hierarchy brought is the newest this device has
      const row = this.tree?.rowOf(fileId)
      if (row && app instanceof AppRepository) app.takeRow(row)
      return app
    }
    // another device's note: the Drive lists again before it is read or written
    if (this.drive instanceof DriveRepository && !this.drive.knows(fileId) && this.tree?.rowOf(fileId)?.driveRef) await this.drive.load()
    return this.drive
  }

  /** The hierarchy's facts of a note over what its content place keeps. */
  private withTree(sidecar: FileSidecar): FileSidecar {
    const row = this.tree?.rowOf(sidecar.meta.id)
    if (!row || row.removedAt) return sidecar
    const tree = fileOfRow(row)
    const { trashedWith: _with, awayFolderId: _away, ...meta } = sidecar.meta
    return {
      ...sidecar,
      meta: { ...meta, name: tree.name, folderId: tree.folderId, parentFileId: tree.parentFileId, position: tree.position, deletedAt: tree.deletedAt, ...(tree.trashedWith ? { trashedWith: tree.trashedWith } : {}), place: tree.place },
    }
  }

  /** Whether a change of a note touches only what the hierarchy owns (name, folder, position, Lixeira): then the content place is not written. */
  private onlyTreeChanged(side: Side, meta: FileMeta, content: string | undefined): boolean {
    const row = this.tree?.rowOf(meta.id)
    if (content !== undefined || !row || row.removedAt || row.place !== side) return false
    return withoutTree(mapMeta(meta)) === withoutTree(row.meta)
  }

  private async writeInTree(side: Side, sidecar: FileSidecar, content: string | undefined): Promise<FileSidecar> {
    const tree = this.tree!
    const id = sidecar.meta.id
    const { awayFolderId: _away, ...plain } = sidecar.meta
    const next: FileSidecar = { ...sidecar, meta: { ...plain, place: side } }
    if (side === 'local') {
      // a note in Local never goes to the account (FR-020)
      const saved = await this.local.saveFile(next, content)
      if (!this.sides.has(id)) this.sides.set(id, 'local')
      return saved
    }
    if (this.onlyTreeChanged(side, next.meta, content)) {
      await tree.saveFile(next.meta, side, tree.rowOf(id)?.driveRef ?? null)
      return next
    }
    const repo = await this.contentRepo(side, id)
    const saved = await repo.saveFile(next, content)
    if (side === 'app') {
      const row = repo instanceof AppRepository ? repo.rowOf(id) : undefined
      if (row) await tree.adopt(row)
    } else {
      await tree.saveFile(saved.meta, 'drive', this.drive instanceof DriveRepository ? this.drive.driveRefOf(id) : null)
    }
    if (!this.sides.has(id)) this.sides.set(id, side)
    return saved
  }

  /** Takes a note's content out of one place; it leaves the hierarchy only when the hierarchy still has it in that place. */
  private async removeInTree(side: Side, fileId: string): Promise<void> {
    const tree = this.tree!
    if (side === 'local') return this.local.removeFile(fileId)
    const row = tree.rowOf(fileId)
    if (side === 'app') {
      // the note went to the Drive: its row stays (its App parts go with a move of place, T035)
      if (row && row.place !== 'app') return
      const repo = await this.contentRepo('app', fileId)
      await repo.removeFile(fileId)
      const gone = repo instanceof AppRepository ? repo.rowOf(fileId) : undefined
      if (gone) await tree.adopt(gone)
      return
    }
    await this.drive.removeFile(fileId)
    if (row && row.place === 'drive') await tree.remove(fileId)
  }

  /** The tree from the account's hierarchy; the notes in Local from this browser, at the root when their folder is gone for good. */
  private async fromTree(tree: HierarchySnapshot, drive: Snapshot | null, local: Snapshot): Promise<Snapshot> {
    this.sides.clear()
    this.folders.clear()
    this.lostFolder.clear()
    for (const folder of tree.folders) this.folders.set(folder.id, folder)
    const files: FileMeta[] = []
    for (const file of tree.files) {
      this.sides.set(file.id, file.place === 'app' ? 'app' : 'drive')
      files.push(file)
    }
    for (const file of local.files) {
      if (this.sides.has(file.id)) continue
      this.sides.set(file.id, 'local')
      const lost = file.folderId !== null && !this.folders.has(file.folderId)
      if (lost) this.lostFolder.add(file.id)
      files.push(lost ? { ...file, folderId: null } : file)
    }
    const index = drive?.index ?? (this.drive instanceof DriveRepository ? await this.drive.cachedIndex() : null) ?? defaultIndex()
    return { folders: tree.folders, files, index }
  }

  private async inLocal(ref: string): Promise<boolean> {
    return this.local instanceof LocalRepository ? this.local.hasSource(ref) : this.local.getSource(ref).then(() => true, () => false)
  }

  /** Whether a folder is kept in the Drive (a folder in Local or in the App is not there). */
  private inDrive(id: string): boolean {
    const side = this.sides.get(id)
    return side !== 'local' && side !== 'app'
  }

  /** The folder itself when it is in the Drive, else the nearest Drive folder above it; null is the root. */
  private driveFolderOf(folderId: string | null): string | null {
    const seen = new Set<string>()
    let current = folderId
    while (current && !seen.has(current)) {
      seen.add(current)
      if (this.inDrive(current)) return current
      current = this.folders.get(current)?.parentId ?? null
    }
    return null
  }

  /** A Drive note's real folder, when that Local folder is in this browser. */
  private trueFile(meta: FileMeta): FileMeta {
    if (!meta.awayFolderId || this.inDrive(meta.awayFolderId)) return meta
    const { awayFolderId, ...rest } = meta
    return { ...rest, folderId: awayFolderId }
  }

  private merge(drive: Snapshot, local: Snapshot, app: Snapshot | null): Snapshot {
    this.sides.clear()
    this.folders.clear()
    // an item is on one side; during a move it is on two, and the journal says which one shows (else the Drive, then the App)
    const chosen = <T extends { id: string }>(lists: [Side, T[]][]): T[] => {
      const found = new Map<string, Map<Side, T>>()
      const order: string[] = []
      for (const [side, items] of lists) {
        for (const item of items) {
          if (!found.has(item.id)) {
            found.set(item.id, new Map())
            order.push(item.id)
          }
          found.get(item.id)!.set(side, item)
        }
      }
      return order.map(id => {
        const twins = found.get(id)!
        const wanted = this.showing(id)
        const side = wanted && twins.has(wanted) ? wanted : (['drive', 'app', 'local'] as Side[]).find(name => twins.has(name))!
        this.sides.set(id, side)
        return twins.get(side)!
      })
    }
    const sides = (pick: (snapshot: Snapshot) => FolderMeta[] | FileMeta[]) =>
      [['drive', pick(drive)], ...(app ? [['app', pick(app)]] : []), ['local', pick(local)]] as [Side, never[]][]
    const folders = chosen<FolderMeta>(sides(snapshot => snapshot.folders))
    const files = chosen<FileMeta>(sides(snapshot => snapshot.files))
    // the away links resolve only after every side is known
    const trueFolders = folders.map(folder => {
      if (!folder.awayParentId || this.inDrive(folder.awayParentId)) return folder
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
