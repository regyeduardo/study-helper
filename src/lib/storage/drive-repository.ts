import type { DeviceRecord, FileMeta, FileSidecar, FolderMeta, LibraryIndex, Snapshot } from '@/types/domain'
import {
  createDriveFileController,
  createDriveFolderController,
  deleteDriveFileController,
  downloadDriveBlobController,
  downloadDriveTextController,
  type DriveFile,
  type DriveSpace,
  FOLDER_MIME,
  getDriveFileController,
  getDriveQuotaController,
  HIDDEN_SPACE_PARENT,
  listDriveFilesController,
  type TokenProvider,
  updateDriveFileController,
} from '@/controllers/drive.controller'
import { defaultIndex, newFileMeta, newSidecar } from '@/lib/defaults'
import { deleteDatabase, KeyValueStore } from '@/lib/storage/idb'
import {
  bytesOf,
  type Conflict,
  type ConflictResolver,
  type RemoteChanges,
  type Repository,
  StorageLimitError,
  type StorageUsage,
  type StoredSource,
} from '@/lib/storage/repository'
import { applyFieldChoices, hasTextConflict, joinHunks, mergeSidecar, mergeText } from '@/lib/sync/merge'

export const ROOT_NAME = '.sync-study-helper'
export const INDEX_NAME = 'study-helper.json'
const FOLDER_META_NAME = '.folder.json'
const DEVICES_NAME = 'devices'
const SOURCES_NAME = 'sources'

type Kind = 'root' | 'folder' | 'folder-meta' | 'md' | 'sidecar' | 'index' | 'devices' | 'device' | 'sources' | 'source'

interface Cached<T> {
  md5: string
  value: T
}

interface FileEntry {
  md?: DriveFile
  sidecar?: DriveFile
}

interface FolderEntry {
  folder: DriveFile
  meta?: DriveFile
}

const MD_TYPE = 'text/markdown'
const JSON_TYPE = 'application/json'

function kindOf(file: DriveFile): Kind | undefined {
  return file.appProperties?.shKind as Kind | undefined
}

function appIdOf(file: DriveFile): string {
  return file.appProperties?.shId ?? file.id
}

function stripExtension(name: string, extension: string): string {
  return name.endsWith(extension) ? name.slice(0, -extension.length) : name
}

function jsonBlob(value: unknown): Blob {
  return new Blob([JSON.stringify(value, null, 2)], { type: JSON_TYPE })
}

const retiredVisibleFolders = new Set<string>()

export class DriveRepository implements Repository {
  readonly kind = 'drive' as const
  private readonly db: KeyValueStore
  private resolver: ConflictResolver | null = null
  private rootId = ''
  private devicesId = ''
  private sourcesId = ''
  private indexFile: DriveFile | null = null
  private files = new Map<string, FileEntry>()
  private folders = new Map<string, FolderEntry>()
  private folderByDriveId = new Map<string, string>()
  private devices = new Map<string, DriveFile>()
  private sources = new Map<string, DriveFile>()
  private listing: DriveFile[] = []
  unlimited = false

  constructor(
    readonly accountId: string,
    private readonly token: TokenProvider,
    readonly space: DriveSpace = 'drive',
  ) {
    this.db = new KeyValueStore(`study-helper-drive-${accountId}`)
  }

  async exists(): Promise<boolean> {
    const listing = await listDriveFilesController(this.token, 'trashed=false', this.space)
    return Boolean(this.findRoot(listing))
  }

  async removeEverything(): Promise<void> {
    if (!this.rootId) await this.ensureRoot()
    await deleteDriveFileController(this.token, this.rootId)
    this.rootId = ''
    if (this.space === 'drive') retiredVisibleFolders.add(this.accountId)
  }

  sourceRefFor(fileId: string): string | null {
    return [...this.sources.values()].find(file => file.appProperties?.shId === fileId)?.id ?? null
  }

  sourceChecksum(ref: string): string | null {
    return this.sources.get(ref)?.md5Checksum ?? null
  }

  async contentFromDrive(fileId: string): Promise<string | null> {
    const md = this.files.get(fileId)?.md
    return md ? downloadDriveTextController(this.token, md.id) : null
  }

  async sidecarFromDrive(fileId: string): Promise<FileSidecar | null> {
    const file = this.files.get(fileId)?.sidecar
    if (!file) return null
    const sidecar = JSON.parse(await downloadDriveTextController(this.token, file.id)) as FileSidecar
    return this.withTreeFacts(fileId, { ...sidecar, questions: sidecar.questions ?? [], attempts: sidecar.attempts ?? [], highlights: sidecar.highlights ?? [] })
  }

  async indexFromDrive(): Promise<LibraryIndex | null> {
    return this.indexFile ? { ...defaultIndex(), ...(JSON.parse(await downloadDriveTextController(this.token, this.indexFile.id)) as LibraryIndex) } : null
  }

  setConflictResolver(resolver: ConflictResolver): void {
    this.resolver = resolver
  }

  async load(): Promise<Snapshot> {
    await this.ensureRoot()
    return this.snapshotFromListing()
  }

  async pullChanges(): Promise<RemoteChanges> {
    const before = new Map([...this.files].map(([id, entry]) => [id, `${entry.md?.md5Checksum}|${entry.sidecar?.md5Checksum}`]))
    const snapshot = await this.load()
    const changedFileIds = [...this.files]
      .filter(([id, entry]) => before.has(id) && before.get(id) !== `${entry.md?.md5Checksum}|${entry.sidecar?.md5Checksum}`)
      .map(([id]) => id)
    return { snapshot, changedFileIds }
  }

  async readContent(fileId: string): Promise<string> {
    const md = this.files.get(fileId)?.md
    if (!md) return ''
    const cached = await this.db.get<Cached<string>>('cache', `md:${fileId}`)
    if (cached && cached.md5 === md.md5Checksum) return cached.value
    const text = await downloadDriveTextController(this.token, md.id)
    await this.remember('md', fileId, md.md5Checksum ?? '', text)
    return text
  }

  async readSidecar(fileId: string): Promise<FileSidecar> {
    const entry = this.files.get(fileId)
    if (!entry?.sidecar) throw new Error('Arquivo não encontrado no Google Drive.')
    return this.withTreeFacts(fileId, await this.sidecarOf(fileId, entry.sidecar))
  }

  async saveFile(sidecar: FileSidecar, content?: string): Promise<FileSidecar> {
    const fileId = sidecar.meta.id
    const entry = this.files.get(fileId)
    const parentId = this.driveFolderId(sidecar.meta.folderId)
    const growth = await this.growthOf(fileId, sidecar, content)
    await this.ensureRoom(growth)

    if (!entry?.md || !entry.sidecar) {
      const md = await createDriveFileController(this.token, `${sidecar.meta.name}.md`, parentId, new Blob([content ?? ''], { type: MD_TYPE }), {
        shKind: 'md',
        shId: fileId,
      })
      const json = await createDriveFileController(this.token, `${sidecar.meta.name}.json`, parentId, jsonBlob(sidecar), {
        shKind: 'sidecar',
        shId: fileId,
      })
      this.files.set(fileId, { md, sidecar: json })
      await this.remember('md', fileId, md.md5Checksum ?? '', content ?? '')
      await this.remember('sidecar', fileId, json.md5Checksum ?? '', sidecar)
      return sidecar
    }

    const moved = entry.md.parents?.[0] !== parentId
    const renamed = stripExtension(entry.md.name, '.md') !== sidecar.meta.name
    const place = {
      name: renamed ? `${sidecar.meta.name}.md` : undefined,
      addParent: moved ? parentId : undefined,
      removeParent: moved ? entry.md.parents?.[0] : undefined,
    }

    if (content !== undefined) {
      const merged = await this.mergedContent(fileId, sidecar, entry, content)
      entry.md = await updateDriveFileController(this.token, entry.md.id, { ...place, media: new Blob([merged], { type: MD_TYPE }) })
      await this.remember('md', fileId, entry.md.md5Checksum ?? '', merged)
    } else if (moved || renamed) {
      entry.md = await updateDriveFileController(this.token, entry.md.id, place)
    }

    const finalSidecar = await this.mergedSidecar(fileId, sidecar, entry.sidecar)
    entry.sidecar = await updateDriveFileController(this.token, entry.sidecar.id, {
      name: renamed ? `${sidecar.meta.name}.json` : undefined,
      addParent: place.addParent,
      removeParent: moved ? entry.sidecar.parents?.[0] : undefined,
      media: jsonBlob(finalSidecar),
    })
    await this.remember('sidecar', fileId, entry.sidecar.md5Checksum ?? '', finalSidecar)
    return finalSidecar
  }

  async removeFile(fileId: string): Promise<void> {
    const entry = this.files.get(fileId)
    if (!entry) return
    await Promise.all([entry.md, entry.sidecar].filter(Boolean).map(file => deleteDriveFileController(this.token, file!.id)))
    this.files.delete(fileId)
    await Promise.all([this.db.delete('cache', `md:${fileId}`), this.db.delete('cache', `sidecar:${fileId}`)])
  }

  async saveFolder(folder: FolderMeta): Promise<void> {
    const parentDriveId = this.driveFolderId(folder.parentId)
    const entry = this.folders.get(folder.id)
    if (!entry) {
      const created = await createDriveFolderController(this.token, folder.name, parentDriveId, { shKind: 'folder', shId: folder.id })
      const meta = await createDriveFileController(this.token, FOLDER_META_NAME, created.id, jsonBlob(folder), {
        shKind: 'folder-meta',
        shId: folder.id,
      })
      this.folders.set(folder.id, { folder: created, meta })
      this.folderByDriveId.set(created.id, folder.id)
      return
    }
    const moved = entry.folder.parents?.[0] !== parentDriveId
    if (moved || entry.folder.name !== folder.name) {
      entry.folder = await updateDriveFileController(this.token, entry.folder.id, {
        name: entry.folder.name !== folder.name ? folder.name : undefined,
        addParent: moved ? parentDriveId : undefined,
        removeParent: moved ? entry.folder.parents?.[0] : undefined,
      })
    }
    entry.meta = entry.meta
      ? await updateDriveFileController(this.token, entry.meta.id, { media: jsonBlob(folder) })
      : await createDriveFileController(this.token, FOLDER_META_NAME, entry.folder.id, jsonBlob(folder), { shKind: 'folder-meta', shId: folder.id })
  }

  async removeFolder(folderId: string): Promise<void> {
    const entry = this.folders.get(folderId)
    if (!entry) return
    await deleteDriveFileController(this.token, entry.folder.id)
    this.folders.delete(folderId)
    this.folderByDriveId.delete(entry.folder.id)
  }

  async saveIndex(index: LibraryIndex): Promise<void> {
    const merged = this.indexFile ? await this.mergedIndex(index, this.indexFile) : index
    this.indexFile = this.indexFile
      ? await updateDriveFileController(this.token, this.indexFile.id, { media: jsonBlob(merged) })
      : await createDriveFileController(this.token, INDEX_NAME, this.rootId, jsonBlob(merged), { shKind: 'index', shId: 'index' })
    await this.db.put('cache', 'index', { md5: this.indexFile.md5Checksum ?? '', value: merged })
  }

  async putSource(fileId: string, blob: Blob, name: string): Promise<StoredSource> {
    await this.ensureRoom(blob.size)
    const file = await createDriveFileController(this.token, `${fileId}-${name}`, this.sourcesId, blob, { shKind: 'source', shId: fileId })
    this.sources.set(file.id, file)
    return { ref: file.id }
  }

  getSource(ref: string): Promise<Blob> {
    return downloadDriveBlobController(this.token, ref)
  }

  async removeSource(ref: string): Promise<void> {
    await deleteDriveFileController(this.token, ref)
    this.sources.delete(ref)
  }

  async usage(): Promise<StorageUsage> {
    const quota = await getDriveQuotaController(this.token)
    const index = (await this.db.get<Cached<LibraryIndex>>('cache', 'index'))?.value
    return {
      appBytes: this.appBytes(),
      limitBytes: index?.settings.storageLimitBytes ?? null,
      cloudUsedBytes: quota.usage,
      cloudTotalBytes: quota.limit,
    }
  }

  async heartbeat(device: DeviceRecord): Promise<void> {
    const existing = this.devices.get(device.id)
    const file = existing
      ? await updateDriveFileController(this.token, existing.id, { media: jsonBlob(device) })
      : await createDriveFileController(this.token, `${device.id}.json`, this.devicesId, jsonBlob(device), { shKind: 'device', shId: device.id })
    this.devices.set(device.id, file)
  }

  async listDevices(): Promise<DeviceRecord[]> {
    return Promise.all(
      [...this.devices.values()].map(async file => {
        const cached = await this.db.get<Cached<DeviceRecord>>('cache', `device:${file.id}`)
        const record =
          cached && cached.md5 === file.md5Checksum
            ? cached.value
            : (JSON.parse(await downloadDriveTextController(this.token, file.id)) as DeviceRecord)
        await this.db.put('cache', `device:${file.id}`, { md5: file.md5Checksum ?? '', value: record })
        return { ...record, lastSeen: file.modifiedTime }
      }),
    )
  }

  async removeDevice(deviceId: string): Promise<void> {
    const file = this.devices.get(deviceId)
    if (!file) return
    await deleteDriveFileController(this.token, file.id)
    this.devices.delete(deviceId)
  }

  async forget(): Promise<void> {
    await deleteDatabase(`study-helper-drive-${this.accountId}`)
  }

  private findRoot(listing: DriveFile[]): DriveFile | undefined {
    const tagged = listing.find(file => kindOf(file) === 'root')
    if (tagged || this.space === 'appDataFolder') return tagged
    return listing.find(file => file.name === ROOT_NAME && file.mimeType === FOLDER_MIME && !file.parents?.some(parent => listing.some(other => other.id === parent)))
  }

  private async ensureRoot(): Promise<void> {
    this.listing = await listDriveFilesController(this.token, 'trashed=false', this.space)
    let root = this.findRoot(this.listing)
    if (!root && this.space === 'drive' && retiredVisibleFolders.has(this.accountId)) throw new Error('A biblioteca mudou para a pasta oculta do Drive; recarregue a página.')
    if (!root) {
      root = await createDriveFolderController(this.token, ROOT_NAME, this.space === 'appDataFolder' ? HIDDEN_SPACE_PARENT : null, { shKind: 'root', shId: 'root' })
      this.listing.push(root)
    }
    this.rootId = root.id
    this.devicesId = await this.ensureSystemFolder('devices', DEVICES_NAME)
    this.sourcesId = await this.ensureSystemFolder('sources', SOURCES_NAME)
  }

  private async ensureSystemFolder(kind: Kind, name: string): Promise<string> {
    const found = this.listing.find(file => kindOf(file) === kind && file.parents?.includes(this.rootId))
    if (found) return found.id
    const created = await createDriveFolderController(this.token, name, this.rootId, { shKind: kind, shId: kind })
    this.listing.push(created)
    return created.id
  }

  private insideRoot(file: DriveFile): boolean {
    const byId = new Map(this.listing.map(item => [item.id, item]))
    let parent = file.parents?.[0]
    for (let depth = 0; parent && depth < 64; depth++) {
      if (parent === this.rootId) return true
      parent = byId.get(parent)?.parents?.[0]
    }
    return false
  }

  private async snapshotFromListing(): Promise<Snapshot> {
    this.files = new Map()
    this.folders = new Map()
    this.folderByDriveId = new Map()
    this.devices = new Map()
    this.sources = new Map()
    this.indexFile = null

    for (const file of this.listing) {
      if (!this.insideRoot(file)) continue
      const kind = kindOf(file)
      const id = appIdOf(file)
      if (kind === 'folder') {
        this.folders.set(id, { ...this.folders.get(id), folder: file })
        this.folderByDriveId.set(file.id, id)
      } else if (kind === 'folder-meta') {
        const entry = this.folders.get(id)
        if (entry) entry.meta = file
        else this.folders.set(id, { folder: { id: '', name: '', mimeType: FOLDER_MIME, modifiedTime: '' }, meta: file })
      } else if (kind === 'md' || kind === 'sidecar') {
        this.files.set(id, { ...this.files.get(id), [kind]: file })
      } else if (kind === 'index' && file.parents?.includes(this.rootId)) {
        this.indexFile = file
      } else if (kind === 'device') {
        this.devices.set(id, file)
      } else if (kind === 'source') {
        this.sources.set(file.id, file)
      }
    }
    for (const [id, entry] of this.folders) if (!entry.folder.id) this.folders.delete(id)

    const [index, folders, files] = await Promise.all([this.loadIndex(), this.loadFolders(), this.loadFiles()])
    return { index, folders, files }
  }

  private async loadIndex(): Promise<LibraryIndex> {
    if (!this.indexFile) {
      const index = defaultIndex()
      await this.saveIndex(index)
      return index
    }
    const cached = await this.db.get<Cached<LibraryIndex>>('cache', 'index')
    if (cached && cached.md5 === this.indexFile.md5Checksum) return cached.value
    const index = { ...defaultIndex(), ...(JSON.parse(await downloadDriveTextController(this.token, this.indexFile.id)) as LibraryIndex) }
    await this.db.put('cache', 'index', { md5: this.indexFile.md5Checksum ?? '', value: index })
    return index
  }

  private async loadFolders(): Promise<FolderMeta[]> {
    return Promise.all(
      [...this.folders].map(async ([id, entry]) => {
        const stored = entry.meta ? await this.cachedJson<FolderMeta>(`folder:${id}`, entry.meta) : null
        const parentDriveId = entry.folder.parents?.[0]
        return {
          ...(stored ?? ({} as FolderMeta)),
          id,
          name: entry.folder.name,
          parentId: parentDriveId && parentDriveId !== this.rootId ? (this.folderByDriveId.get(parentDriveId) ?? null) : null,
        } as FolderMeta
      }),
    )
  }

  private async loadFiles(): Promise<FileMeta[]> {
    const metas = await Promise.all(
      [...this.files].map(async ([id, entry]) => {
        if (!entry.md) return null
        const sidecar = entry.sidecar
          ? await this.sidecarOf(id, entry.sidecar)
          : newSidecar(newFileMeta({ id, name: stripExtension(entry.md.name, '.md'), type: 'reading' }))
        return this.withTreeFacts(id, sidecar).meta
      }),
    )
    return metas.filter((meta): meta is FileMeta => meta !== null)
  }

  private withTreeFacts(fileId: string, sidecar: FileSidecar): FileSidecar {
    const md = this.files.get(fileId)?.md
    if (!md) return sidecar
    const parentDriveId = md.parents?.[0]
    return {
      ...sidecar,
      meta: {
        ...sidecar.meta,
        id: fileId,
        name: stripExtension(md.name, '.md'),
        folderId: parentDriveId && parentDriveId !== this.rootId ? (this.folderByDriveId.get(parentDriveId) ?? null) : null,
      },
    }
  }

  private async sidecarOf(fileId: string, file: DriveFile): Promise<FileSidecar> {
    const sidecar = await this.cachedJson<FileSidecar>(`sidecar:${fileId}`, file)
    return { ...sidecar, questions: sidecar.questions ?? [], attempts: sidecar.attempts ?? [], highlights: sidecar.highlights ?? [] }
  }

  private async cachedJson<T>(key: string, file: DriveFile): Promise<T> {
    const cached = await this.db.get<Cached<T>>('cache', key)
    if (cached && cached.md5 === file.md5Checksum) return cached.value
    const value = JSON.parse(await downloadDriveTextController(this.token, file.id)) as T
    await this.db.put('cache', key, { md5: file.md5Checksum ?? '', value })
    return value
  }

  private async remember(kind: 'md' | 'sidecar', fileId: string, md5: string, value: unknown): Promise<void> {
    await this.db.put('cache', `${kind}:${fileId}`, { md5, value })
  }

  private driveFolderId(folderId: string | null): string {
    if (!folderId) return this.rootId
    return this.folders.get(folderId)?.folder.id ?? this.rootId
  }

  private async mergedIndex(mine: LibraryIndex, file: DriveFile): Promise<LibraryIndex> {
    const base = await this.db.get<Cached<LibraryIndex>>('cache', 'index')
    const remote = await getDriveFileController(this.token, file.id)
    if (!base || remote.md5Checksum === base.md5) return mine
    const theirs = JSON.parse(await downloadDriveTextController(this.token, file.id)) as Partial<LibraryIndex>
    const byId = new Map(mine.activities.map(activity => [activity.id, activity]))
    for (const activity of theirs.activities ?? []) {
      const own = byId.get(activity.id)
      if (!own || (!own.finishedAt && activity.finishedAt)) byId.set(activity.id, activity)
    }
    const removedTags = new Set(base.value.tags.filter(tag => !mine.tags.includes(tag)))
    return {
      ...mine,
      tags: [...new Set([...mine.tags, ...(theirs.tags ?? []).filter(tag => !removedTags.has(tag))])],
      activities: [...byId.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    }
  }

  private async theirsStampOf(fileId: string, sidecarFile: DriveFile | undefined, remoteMd: DriveFile): Promise<{ at: string; deviceName: string }> {
    const fallback = { at: remoteMd.modifiedTime, deviceName: 'Google Drive' }
    if (!sidecarFile) return fallback
    const base = await this.db.get<Cached<FileSidecar>>('cache', `sidecar:${fileId}`)
    const remote = await getDriveFileController(this.token, sidecarFile.id)
    if (base && remote.md5Checksum === base.md5) return fallback
    const theirs = JSON.parse(await downloadDriveTextController(this.token, sidecarFile.id)) as FileSidecar
    return { ...fallback, deviceName: theirs.meta.updated.deviceName }
  }

  private async mergedContent(fileId: string, sidecar: FileSidecar, entry: FileEntry, mine: string): Promise<string> {
    const md = entry.md!
    const base = await this.db.get<Cached<string>>('cache', `md:${fileId}`)
    const remote = await getDriveFileController(this.token, md.id)
    if (!base || remote.md5Checksum === base.md5) return mine
    const theirs = await downloadDriveTextController(this.token, md.id)
    const hunks = mergeText(base.value, mine, theirs)
    if (!hasTextConflict(hunks)) return joinHunks(hunks)
    if (!this.resolver) return mine
    const resolved = await this.resolver({
      kind: 'text',
      fileId,
      fileName: sidecar.meta.name,
      base: base.value,
      mine,
      theirs,
      mineStamp: { at: sidecar.meta.updated.at, deviceName: sidecar.meta.updated.deviceName },
      theirsStamp: await this.theirsStampOf(fileId, entry.sidecar, remote),
    })
    return resolved.kind === 'text' ? (resolved.resolved ?? mine) : mine
  }

  private async mergedSidecar(fileId: string, mine: FileSidecar, file: DriveFile): Promise<FileSidecar> {
    const base = await this.db.get<Cached<FileSidecar>>('cache', `sidecar:${fileId}`)
    const remote = await getDriveFileController(this.token, file.id)
    if (!base || remote.md5Checksum === base.md5) return mine
    const theirs = JSON.parse(await downloadDriveTextController(this.token, file.id)) as FileSidecar
    const { merged, conflicts } = mergeSidecar(base.value, mine, theirs)
    if (!conflicts.length || !this.resolver) return merged
    const resolved: Conflict = await this.resolver({
      kind: 'json',
      fileId,
      fileName: mine.meta.name,
      fields: conflicts,
      mineStamp: { at: mine.meta.updated.at, deviceName: mine.meta.updated.deviceName },
      theirsStamp: { at: theirs.meta.updated.at, deviceName: theirs.meta.updated.deviceName },
    })
    if (resolved.kind !== 'json') return merged
    const choices = Object.fromEntries(resolved.fields.map(field => [field.path, field.choice ?? 'mine'])) as Record<string, 'mine' | 'theirs'>
    return applyFieldChoices(merged, conflicts, choices)
  }

  private appBytes(): number {
    const tracked = [
      this.indexFile,
      ...[...this.files.values()].flatMap(entry => [entry.md, entry.sidecar]),
      ...[...this.folders.values()].flatMap(entry => [entry.folder, entry.meta]),
      ...this.devices.values(),
      ...this.sources.values(),
    ]
    return tracked.reduce((sum, file) => sum + Number(file?.size ?? 0), 0)
  }

  private async growthOf(fileId: string, sidecar: FileSidecar, content?: string): Promise<number> {
    const entry = this.files.get(fileId)
    const before = Number(entry?.md?.size ?? 0) + Number(entry?.sidecar?.size ?? 0)
    const after = bytesOf(content ?? '') + bytesOf(JSON.stringify(sidecar, null, 2))
    return content === undefined ? 0 : after - before
  }

  private async ensureRoom(growth: number): Promise<void> {
    if (growth <= 0 || this.unlimited) return
    const index = (await this.db.get<Cached<LibraryIndex>>('cache', 'index'))?.value
    const limit = index?.settings.storageLimitBytes ?? null
    if (limit === null) return
    const used = this.appBytes()
    if (used + growth > limit) throw new StorageLimitError(growth, used + growth - limit)
  }
}
