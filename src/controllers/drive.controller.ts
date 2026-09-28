import { env } from '@/lib/env'
import { newId } from '@/lib/ids'

export const FOLDER_MIME = 'application/vnd.google-apps.folder'

export type TokenProvider = (options?: { force?: boolean }) => Promise<string>

export interface DriveFile {
  id: string
  name: string
  mimeType: string
  parents?: string[]
  modifiedTime: string
  md5Checksum?: string
  size?: string
  appProperties?: Record<string, string>
}

export interface DriveQuota {
  limit: number | null
  usage: number
}

const FILE_FIELDS = 'id,name,mimeType,parents,modifiedTime,md5Checksum,size,appProperties'

export class DriveError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
  }
}

async function send(accessToken: string, path: string, init: RequestInit): Promise<Response> {
  return fetch(`${env.googleApiBase}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${accessToken}`, ...(init.headers ?? {}) },
  })
}

async function call(token: TokenProvider, path: string, init: RequestInit = {}): Promise<Response> {
  let response = await send(await token(), path, init)
  if (response.status === 401) response = await send(await token({ force: true }), path, init)
  if (!response.ok) {
    const text = await response.text().catch(() => '')
    throw new DriveError(response.status, driveMessage(response.status, text))
  }
  return response
}

function googleReason(body: string): { reason: string; message: string } {
  try {
    const parsed = JSON.parse(body) as { error?: { message?: string; status?: string; errors?: { reason?: string }[]; details?: { reason?: string }[] } }
    const error = parsed.error
    return {
      reason: error?.errors?.[0]?.reason ?? error?.details?.find(detail => detail.reason)?.reason ?? error?.status ?? '',
      message: error?.message ?? '',
    }
  } catch {
    return { reason: '', message: body.slice(0, 200) }
  }
}

function driveMessage(status: number, body: string): string {
  const { reason, message } = googleReason(body)
  if (status === 401) return 'O login do Google expirou. Entre de novo.'
  if (/accessNotConfigured|SERVICE_DISABLED/.test(reason) || /has not been used|is disabled/.test(message)) {
    return 'A Google Drive API não está ativada no projeto do Google Cloud. Ative em APIs e serviços › Biblioteca › Google Drive API e tente de novo em alguns minutos.'
  }
  if (/insufficientPermissions|ACCESS_TOKEN_SCOPE_INSUFFICIENT/.test(reason) || /insufficient.*scope/i.test(message)) {
    return 'O Google não deu acesso ao Drive: na tela de login, a caixa do Google Drive ficou desmarcada. Saia da conta e entre de novo marcando essa caixa.'
  }
  if (/storageQuotaExceeded/.test(reason)) return 'O seu Google Drive está cheio.'
  if (/rateLimit|userRateLimitExceeded/i.test(reason)) return 'O Google Drive pediu pra ir mais devagar. Tente de novo em instantes.'
  if (status === 404) return 'O arquivo não existe mais no Google Drive.'
  return `O Google Drive recusou o pedido (${status}${reason ? `, ${reason}` : ''})${message ? `: ${message}` : '.'}`
}

export async function listDriveFilesController(token: TokenProvider, query: string): Promise<DriveFile[]> {
  const files: DriveFile[] = []
  let pageToken = ''
  do {
    const params = new URLSearchParams({
      q: query,
      fields: `nextPageToken,files(${FILE_FIELDS})`,
      pageSize: '1000',
      spaces: 'drive',
    })
    if (pageToken) params.set('pageToken', pageToken)
    const response = await call(token, `/drive/v3/files?${params}`)
    const body = (await response.json()) as { files?: DriveFile[]; nextPageToken?: string }
    files.push(...(body.files ?? []))
    pageToken = body.nextPageToken ?? ''
  } while (pageToken)
  return files
}

export async function getDriveFileController(token: TokenProvider, id: string): Promise<DriveFile> {
  const response = await call(token, `/drive/v3/files/${id}?fields=${FILE_FIELDS}`)
  return (await response.json()) as DriveFile
}

export async function downloadDriveTextController(token: TokenProvider, id: string): Promise<string> {
  const response = await call(token, `/drive/v3/files/${id}?alt=media`)
  return response.text()
}

export async function downloadDriveBlobController(token: TokenProvider, id: string): Promise<Blob> {
  const response = await call(token, `/drive/v3/files/${id}?alt=media`)
  return response.blob()
}

export async function createDriveFolderController(
  token: TokenProvider,
  name: string,
  parentId: string | null,
  appProperties: Record<string, string>,
): Promise<DriveFile> {
  const response = await call(token, `/drive/v3/files?fields=${FILE_FIELDS}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, mimeType: FOLDER_MIME, parents: parentId ? [parentId] : undefined, appProperties }),
  })
  return (await response.json()) as DriveFile
}

function multipart(metadata: object, media: Blob): { body: Blob; boundary: string } {
  const boundary = `study-helper-${newId()}`
  const body = new Blob([
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n`,
    `--${boundary}\r\nContent-Type: ${media.type || 'application/octet-stream'}\r\n\r\n`,
    media,
    `\r\n--${boundary}--`,
  ])
  return { body, boundary }
}

const MULTIPART_LIMIT_BYTES = 5 * 1024 * 1024

async function createResumable(token: TokenProvider, metadata: object, media: Blob): Promise<DriveFile> {
  const type = media.type || 'application/octet-stream'
  const opened = await call(token, `/upload/drive/v3/files?uploadType=resumable&fields=${FILE_FIELDS}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=UTF-8', 'X-Upload-Content-Type': type, 'X-Upload-Content-Length': String(media.size) },
    body: JSON.stringify(metadata),
  })
  const uploadId = opened.headers.get('X-GUploader-UploadID')
  const session = opened.headers.get('Location') ?? (uploadId ? `${env.googleApiBase}/upload/drive/v3/files?uploadType=resumable&fields=${FILE_FIELDS}&upload_id=${uploadId}` : null)
  if (!session) throw new DriveError(0, 'O Google Drive não abriu o envio do arquivo grande.')
  const response = await fetch(session, { method: 'PUT', headers: { 'Content-Type': type }, body: media })
  if (!response.ok) throw new DriveError(response.status, driveMessage(response.status, await response.text().catch(() => '')))
  return (await response.json()) as DriveFile
}

export async function createDriveFileController(
  token: TokenProvider,
  name: string,
  parentId: string,
  media: Blob,
  appProperties: Record<string, string>,
): Promise<DriveFile> {
  const metadata = { name, parents: [parentId], appProperties, mimeType: media.type || undefined }
  if (media.size > MULTIPART_LIMIT_BYTES) return createResumable(token, metadata, media)
  const { body, boundary } = multipart(metadata, media)
  const response = await call(token, `/upload/drive/v3/files?uploadType=multipart&fields=${FILE_FIELDS}`, {
    method: 'POST',
    headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
    body,
  })
  return (await response.json()) as DriveFile
}

export async function updateDriveFileController(
  token: TokenProvider,
  id: string,
  changes: { name?: string; addParent?: string; removeParent?: string; media?: Blob },
): Promise<DriveFile> {
  const params = new URLSearchParams({ fields: FILE_FIELDS })
  if (changes.addParent) params.set('addParents', changes.addParent)
  if (changes.removeParent) params.set('removeParents', changes.removeParent)
  const metadata = changes.name !== undefined ? { name: changes.name } : {}

  if (changes.media) {
    params.set('uploadType', 'multipart')
    const { body, boundary } = multipart(metadata, changes.media)
    const response = await call(token, `/upload/drive/v3/files/${id}?${params}`, {
      method: 'PATCH',
      headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
      body,
    })
    return (await response.json()) as DriveFile
  }

  const response = await call(token, `/drive/v3/files/${id}?${params}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(metadata),
  })
  return (await response.json()) as DriveFile
}

export async function deleteDriveFileController(token: TokenProvider, id: string): Promise<void> {
  try {
    await call(token, `/drive/v3/files/${id}`, { method: 'DELETE' })
  } catch (error) {
    if (error instanceof DriveError && error.status === 404) return
    throw error
  }
}

export async function getDriveQuotaController(token: TokenProvider): Promise<DriveQuota> {
  const response = await call(token, '/drive/v3/about?fields=storageQuota')
  const body = (await response.json()) as { storageQuota?: { limit?: string; usage?: string } }
  return {
    limit: body.storageQuota?.limit ? Number(body.storageQuota.limit) : null,
    usage: Number(body.storageQuota?.usage ?? 0),
  }
}
