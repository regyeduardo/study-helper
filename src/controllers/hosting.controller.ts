import type { SourceStorage } from '@/types/domain'
import { newId } from '@/lib/ids'

export type HostId = Exclude<SourceStorage, 'none' | 'drive'>

export type LitterboxTime = '1h' | '12h' | '24h' | '72h'

export interface HostInfo {
  id: HostId
  name: string
  maxBytes: number | null
  keeps: string
  probeUrl: string
}

const MB = 1024 * 1024

export const HOSTS: HostInfo[] = [
  { id: 'gofile', name: 'Gofile', maxBytes: null, keeps: 'some depois de 10 dias sem ninguém baixar', probeUrl: 'https://gofile.io' },
  { id: 'litterbox', name: 'Litterbox', maxBytes: 1024 * MB, keeps: 'fica pelo prazo escolhido (1 h a 72 h)', probeUrl: 'https://litterbox.catbox.moe' },
  { id: 'filebin', name: 'filebin', maxBytes: null, keeps: 'fica 7 dias', probeUrl: 'https://filebin.net' },
  { id: 'tmpfiles', name: 'tmpfiles', maxBytes: 100 * MB, keeps: 'fica 1 hora', probeUrl: 'https://tmpfiles.org' },
]

export interface HostedFile {
  url: string
  expiresAt: string | null
}

export class HostingError extends Error {}

function hoursFromNow(hours: number): string {
  return new Date(Date.now() + hours * 3600 * 1000).toISOString()
}

export async function isHostOnlineController(host: HostInfo): Promise<boolean> {
  try {
    await fetch(host.probeUrl, { method: 'GET', mode: 'no-cors', cache: 'no-store' })
    return true
  } catch {
    return false
  }
}

async function post(url: string, init: RequestInit, name: string): Promise<Response> {
  let response: Response
  try {
    response = await fetch(url, init)
  } catch {
    throw new HostingError(`O ${name} não respondeu.`)
  }
  if (!response.ok) throw new HostingError(`O ${name} recusou o arquivo (${response.status}).`)
  return response
}

export async function uploadToGofileController(file: File): Promise<HostedFile> {
  const form = new FormData()
  form.append('file', file)
  const response = await post('https://upload.gofile.io/uploadfile', { method: 'POST', body: form }, 'Gofile')
  const body = (await response.json()) as { status?: string; data?: { downloadPage?: string } }
  if (body.status !== 'ok' || !body.data?.downloadPage) throw new HostingError('O Gofile não devolveu o link.')
  return { url: body.data.downloadPage, expiresAt: null }
}

export async function uploadToLitterboxController(file: File, time: LitterboxTime): Promise<HostedFile> {
  const form = new FormData()
  form.append('reqtype', 'fileupload')
  form.append('time', time)
  form.append('fileToUpload', file)
  const response = await post('https://litterbox.catbox.moe/resources/internals/api.php', { method: 'POST', body: form }, 'Litterbox')
  const url = (await response.text()).trim()
  if (!url.startsWith('http')) throw new HostingError('O Litterbox não devolveu o link.')
  return { url, expiresAt: hoursFromNow(Number(time.replace('h', ''))) }
}

export async function uploadToFilebinController(file: File): Promise<HostedFile> {
  const bin = `study-helper-${newId().slice(0, 12)}`
  const url = `https://filebin.net/${bin}/${encodeURIComponent(file.name)}`
  await post(url, { method: 'POST', body: file, headers: { 'Content-Type': file.type || 'application/octet-stream' } }, 'filebin')
  return { url, expiresAt: hoursFromNow(24 * 7) }
}

export async function uploadToTmpfilesController(file: File): Promise<HostedFile> {
  const form = new FormData()
  form.append('file', file)
  const response = await post('https://tmpfiles.org/api/v1/upload', { method: 'POST', body: form }, 'tmpfiles')
  const body = (await response.json()) as { status?: string; data?: { url?: string } }
  if (!body.data?.url) throw new HostingError('O tmpfiles não devolveu o link.')
  return { url: body.data.url.replace('tmpfiles.org/', 'tmpfiles.org/dl/'), expiresAt: hoursFromNow(1) }
}

export async function deleteFromFilebinController(url: string): Promise<boolean> {
  try {
    const response = await fetch(url, { method: 'DELETE' })
    return response.ok
  } catch {
    return false
  }
}
