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
import type { Repository } from '@/lib/storage/repository'

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

export function sourceExpired(origin: SourceMeta | null): boolean {
  return Boolean(origin?.expiresAt) && Date.parse(origin!.expiresAt!) < Date.now()
}

export async function removeStoredSource(origin: SourceMeta, repo: Repository): Promise<SourceMeta> {
  if (origin.storage === 'drive' && origin.storedFileId) await repo.removeSource(origin.storedFileId)
  if (origin.storage === 'filebin' && origin.storedUrl) await deleteFromFilebinController(origin.storedUrl)
  return { ...origin, storedFileId: undefined, storedUrl: undefined, removedAt: new Date().toISOString() }
}

export async function downloadStoredSource(origin: SourceMeta, repo: Repository): Promise<Blob | string> {
  if (origin.storage === 'drive' && origin.storedFileId) return repo.getSource(origin.storedFileId)
  if (origin.storedUrl) return origin.storedUrl
  throw new Error('A fonte não está mais guardada.')
}
