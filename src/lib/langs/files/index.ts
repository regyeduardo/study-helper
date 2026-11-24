/**
 * The language's JSON files by path (spec 004, FR-040; data-model.md › Drive e Local): `en/language.json`, `en/texts/<id>.json`…
 * The same contract in this browser, in the Google Drive and in memory (tests); the base in the browser only talks to this.
 */
import {
  createDriveFileController,
  createDriveFolderController,
  deleteDriveFileController,
  type DriveFile,
  type DriveSpace,
  downloadDriveTextController,
  listDriveFilesController,
  type TokenProvider,
  updateDriveFileController,
} from '@/controllers/drive.controller'
import { KeyValueStore } from '@/lib/storage/idb'

export interface LangFiles {
  /** The file, or null when there is none. What comes back is a copy. */
  read<T>(path: string): Promise<T | null>
  write(path: string, value: unknown): Promise<void>
  remove(path: string): Promise<void>
  /** The names right under a folder ('' = the top): files and folders, once each. */
  list(folder: string): Promise<string[]>
}

const copy = <T>(value: T): T => (value === undefined ? value : (JSON.parse(JSON.stringify(value)) as T))

/** Names right under `folder`, from every path kept. */
function under(paths: Iterable<string>, folder: string): string[] {
  const prefix = folder ? `${folder.replace(/\/+$/, '')}/` : ''
  const names = new Set<string>()
  for (const path of paths) if (path.startsWith(prefix) && path.length > prefix.length) names.add(path.slice(prefix.length).split('/')[0])
  return [...names]
}

export class MemoryLangFiles implements LangFiles {
  private readonly files = new Map<string, string>()

  async read<T>(path: string): Promise<T | null> {
    const raw = this.files.get(path)
    return raw === undefined ? null : (JSON.parse(raw) as T)
  }

  async write(path: string, value: unknown): Promise<void> {
    this.files.set(path, JSON.stringify(value))
  }

  async remove(path: string): Promise<void> {
    this.files.delete(path)
  }

  async list(folder: string): Promise<string[]> {
    return under(this.files.keys(), folder)
  }
}

/** Local: this browser only (IndexedDB), never sent anywhere. */
export class LocalLangFiles implements LangFiles {
  private readonly kv: KeyValueStore

  constructor(databaseName = 'estudo-idiomas') {
    this.kv = new KeyValueStore(databaseName)
  }

  async read<T>(path: string): Promise<T | null> {
    const value = await this.kv.get<T>('base', path)
    return value === undefined ? null : copy(value)
  }

  async write(path: string, value: unknown): Promise<void> {
    await this.kv.put('base', path, copy(value))
  }

  async remove(path: string): Promise<void> {
    await this.kv.delete('base', path)
  }

  async list(folder: string): Promise<string[]> {
    return under(await this.kv.keys('base'), folder)
  }
}

/** Where the files go in the Google Drive: the "idiomas" folder of the app's space (DriveRepository.languagesFolder). */
export type DriveLangFolder = () => Promise<{ token: TokenProvider; space: DriveSpace; folderId: string }>

const FOLDER_MIME = 'application/vnd.google-apps.folder'
const KIND = 'idioma'

/**
 * The Google Drive: a folder per language inside "idiomas" (`en/`, `en/texts/`…), each file and folder tagged with its path, so one
 * listing finds them all. What was read is kept until it changes here.
 */
export class DriveLangFiles implements LangFiles {
  private opened: Promise<{ token: TokenProvider; space: DriveSpace; folderId: string; byPath: Map<string, DriveFile> }> | null = null

  constructor(private readonly folder: DriveLangFolder) {}

  private open() {
    this.opened ??= (async () => {
      const where = await this.folder()
      const listing = await listDriveFilesController(where.token, `appProperties has { key='shKind' and value='${KIND}' } and trashed=false`, where.space)
      const byPath = new Map<string, DriveFile>()
      for (const file of listing) {
        const path = file.appProperties?.shPath
        if (path && !byPath.has(path)) byPath.set(path, file)
      }
      return { ...where, byPath }
    })().catch(error => {
      this.opened = null
      throw error
    })
    return this.opened
  }

  private async folderOf(path: string): Promise<string> {
    const drive = await this.open()
    if (!path) return drive.folderId
    const found = drive.byPath.get(path)
    if (found) return found.id
    const at = path.lastIndexOf('/')
    const parent = await this.folderOf(at < 0 ? '' : path.slice(0, at))
    const created = await createDriveFolderController(drive.token, path.slice(at + 1), parent, { shKind: KIND, shPath: path })
    drive.byPath.set(path, created)
    return created.id
  }

  async read<T>(path: string): Promise<T | null> {
    const drive = await this.open()
    const file = drive.byPath.get(path)
    if (!file || file.mimeType === FOLDER_MIME) return null
    return JSON.parse(await downloadDriveTextController(drive.token, file.id)) as T
  }

  async write(path: string, value: unknown): Promise<void> {
    const drive = await this.open()
    const media = new Blob([JSON.stringify(value)], { type: 'application/json' })
    const file = drive.byPath.get(path)
    if (file) {
      drive.byPath.set(path, await updateDriveFileController(drive.token, file.id, { media }))
      return
    }
    const at = path.lastIndexOf('/')
    const parent = await this.folderOf(at < 0 ? '' : path.slice(0, at))
    drive.byPath.set(path, await createDriveFileController(drive.token, path.slice(at + 1), parent, media, { shKind: KIND, shPath: path }))
  }

  async remove(path: string): Promise<void> {
    const drive = await this.open()
    const file = drive.byPath.get(path)
    if (!file) return
    await deleteDriveFileController(drive.token, file.id)
    drive.byPath.delete(path)
  }

  async list(folder: string): Promise<string[]> {
    return under((await this.open()).byPath.keys(), folder)
  }
}
