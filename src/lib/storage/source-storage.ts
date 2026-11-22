import type { SourceMeta, SourceStorage } from '@/types/domain'
import {
  deleteFromFilebinController,
  HOSTS,
  type HostId,
  isHostOnlineController,
  type LitterboxTime,
  uploadToFilebinController,
  uploadToGofileController,
  uploadToLitterboxController,
  uploadToOnlyfilesController,
  uploadToTmpfilesController,
} from '@/controllers/hosting.controller'
import { recordingName, sourceTypeOf } from '@/lib/file-types'
import { keepLocalMedia, linkLocalMedia, type LocalMedia, readLocalMedia } from '@/lib/recording/media-library'
import { CombinedRepository } from '@/lib/storage/combined-repository'
import type { Repository } from '@/lib/storage/repository'
import { useLibraryStore } from '@/stores/library'

export interface StorageOption {
  id: SourceStorage
  name: string
  description: string
  fits: boolean
  enabled: boolean
  reason?: string
  thirdParty: boolean
}

export function storageOptions(sizeBytes: number, driveAvailable: boolean, driveRoomBytes: number | null): StorageOption[] {
  const driveFits = driveRoomBytes === null || sizeBytes <= driveRoomBytes
  const options: StorageOption[] = [
    {
      id: 'drive',
      name: 'Google Drive',
      description: 'O único 100% confiável. Conta no seu limite de armazenamento.',
      fits: true,
      enabled: driveAvailable && driveFits,
      reason: !driveAvailable ? 'Entre com o Google para guardar no Drive.' : !driveFits ? 'Não cabe no limite de armazenamento do app.' : undefined,
      thirdParty: false,
    },
    { id: 'none', name: 'Não guardar', description: 'Usa o arquivo só para gerar. Depois, fica só o nome.', fits: true, enabled: true, thirdParty: false },
  ]
  return options
}

export function defaultStorage(driveAvailable: boolean, options: StorageOption[]): SourceStorage {
  const drive = options.find(option => option.id === 'drive')
  return driveAvailable && drive?.enabled ? 'drive' : 'none'
}

export async function storeSource(
  file: File,
  choice: SourceStorage,
  fileId: string,
  repo: Repository,
  litterboxTime: LitterboxTime,
): Promise<Pick<SourceMeta, 'storage' | 'storedUrl' | 'storedFileId' | 'expiresAt'>> {
  if (choice === 'none') return { storage: 'none' }
  if (choice === 'drive') {
    const stored = await repo.putSource(fileId, file, file.name)
    return { storage: 'drive', storedFileId: stored.ref, expiresAt: null }
  }
  const host = HOSTS.find(item => item.id === choice)!
  if (!(await isHostOnlineController(host))) throw new Error(`O ${host.name} parece fora do ar agora. Escolha outro lugar para guardar.`)
  const upload: Record<HostId, () => Promise<{ url: string; expiresAt: string | null }>> = {
    gofile: () => uploadToGofileController(file),
    litterbox: () => uploadToLitterboxController(file, litterboxTime),
    filebin: () => uploadToFilebinController(file),
    tmpfiles: () => uploadToTmpfilesController(file),
    onlyfiles: () => uploadToOnlyfilesController(file),
  }
  const hosted = await upload[choice as HostId]()
  return { storage: choice, storedUrl: hosted.url, expiresAt: hosted.expiresAt }
}

const GONE_FROM_BROWSER = 'O arquivo não está mais neste navegador.'

/** FR-043: uploads what is kept in this browser and gives the item its Drive address. The copy in Mídias stays. */
export async function saveToDrive(fileId: string, kept?: LocalMedia): Promise<void> {
  const library = useLibraryStore.getState()
  const { repo } = library
  if (repo?.kind !== 'drive') throw new Error('Entre com o Google para guardar no Drive.')
  const origin = library.files.find(file => file.id === fileId)?.origin
  const local = kept ?? library.localMedia.find(item => item.fileIds.includes(fileId))
  const gone = new Error(GONE_FROM_BROWSER)
  if (!origin || !local) throw gone
  const media = await readLocalMedia(local).catch(() => {
    throw gone
  })
  const stored = await storeSource(media, 'drive', fileId, repo, '72h')
  try {
    await library.updateFile(fileId, { origin: { ...origin, ...stored, removedAt: undefined } })
  } catch (error) {
    // without the address nothing would ever find this copy, and it would keep using the person's space
    await repo.removeSource(stored.storedFileId!).catch(() => undefined)
    throw error
  }
}

/**
 * T136: a media in Mídias that never became a note has nowhere to hold a Drive address, so it first gets a media note, the way
 * "Só guardar para ler" makes one for a media file (Vídeo or Áudio, kept 'arquivo'), and then goes to the Drive. No other note is made.
 * If the upload fails the media note stays linked to the media, and trying again uploads for it.
 */
export async function saveLocalMediaToDrive(item: LocalMedia, onEntry?: (entryId: string) => void): Promise<void> {
  const library = useLibraryStore.getState()
  if (library.repo?.kind !== 'drive') throw new Error('Entre com o Google para guardar no Drive.')
  await readLocalMedia(item).catch(() => {
    throw new Error(GONE_FROM_BROWSER)
  })
  const origin: SourceMeta = { input: item.storedName.startsWith('envio-') ? 'file' : 'recording', name: item.name, mime: item.mime, sizeBytes: item.size, durationSeconds: item.durationSeconds, storage: 'none' }
  const entry = await library.createFile({ name: recordingName(item.name), kept: 'registro', type: sourceTypeOf(origin), description: '', folderId: null, status: 'ready', pendingExcerpt: null, origin }, '')
  onEntry?.(entry.id)
  await linkLocalMedia(item.storedName, entry.id)
  await library.updateFile(entry.id, { kept: 'arquivo' })
  await saveToDrive(entry.id, { ...item, fileIds: [...item.fileIds, entry.id] })
}

/** T136: brings what is only in the Drive to Mídias, linked to the item that has the address. The copy in the Drive stays. */
export async function keepFromDrive(fileId: string): Promise<void> {
  const { repo, files } = useLibraryStore.getState()
  if (repo?.kind !== 'drive') throw new Error('Entre com o Google para pegar do Drive.')
  const origin = files.find(file => file.id === fileId)?.origin
  if (!origin?.storedFileId || origin.storage !== 'drive' || origin.removedAt) throw new Error('A mídia não está mais guardada no Drive.')
  const stored = await repo.getSource(origin.storedFileId)
  await keepLocalMedia(new File([stored], origin.name, { type: origin.mime || stored.type }), fileId, origin.durationSeconds ?? 0)
}

/** T137: the media of an item to download: the copy of this browser first, then the Drive or the host; a host's address comes back as text. */
export async function mediaToDownload(fileId: string): Promise<Blob | string> {
  const { files, localMedia, repo } = useLibraryStore.getState()
  const origin = files.find(file => file.id === fileId)?.origin ?? null
  const local = localMedia.find(item => item.fileIds.includes(fileId))
  const stored = Boolean(origin && (origin.storedFileId || origin.storedUrl) && !origin.removedAt && !sourceExpired(origin))
  if (local) {
    try {
      return await readLocalMedia(local)
    } catch {
      if (!stored) throw new Error(GONE_FROM_BROWSER)
    }
  }
  if (origin && stored && repo) return downloadStoredSource(origin, repo)
  throw new Error('A mídia não está mais guardada.')
}

export function sourceExpired(origin: SourceMeta | null): boolean {
  return Boolean(origin?.expiresAt) && Date.parse(origin!.expiresAt!) < Date.now()
}

export async function removeStoredSource(origin: SourceMeta, repo: Repository): Promise<SourceMeta> {
  if (origin.storage === 'drive' && origin.storedFileId) await repo.removeSource(origin.storedFileId)
  if (origin.storage === 'filebin' && origin.storedUrl) await deleteFromFilebinController(origin.storedUrl)
  return { ...origin, storedFileId: undefined, storedUrl: undefined, removedAt: new Date().toISOString() }
}

/** A repository that can give the player an address to stream a media it keeps (the App's API, the Drive through the app's worker). */
interface Streams {
  streamSource(ref: string): Promise<string | null> | string | null
}

/**
 * Where the player streams a kept media from, without downloading it first: the browser asks for it in parts. Null where it cannot
 * (Local, the Drive in a browser without the app's worker): then `downloadStoredSource` brings it whole.
 */
export async function storedStream(origin: SourceMeta, repo: Repository): Promise<string | null> {
  const ref = origin.storage === 'drive' && !origin.removedAt ? origin.storedFileId : undefined
  if (!ref) return null
  const side = repo instanceof CombinedRepository ? (ref.startsWith('app:') ? repo.app : repo.drive) : repo
  return side && 'streamSource' in side ? (side as Repository & Streams).streamSource(ref) : null
}

export async function downloadStoredSource(origin: SourceMeta, repo: Repository): Promise<Blob | string> {
  if (origin.storage === 'drive' && origin.storedFileId) return repo.getSource(origin.storedFileId)
  if (origin.storedUrl) return origin.storedUrl
  throw new Error('A fonte não está mais guardada.')
}
