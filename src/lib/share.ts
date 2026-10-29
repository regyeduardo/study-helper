import type { Attempt, FileMeta, FolderMeta, ShareContent, SharedFile, SharedFolder, SharedItem, SharedLink, SharedMedia, ShareKind, SourceMeta } from '@/types/domain'
import { currentDevice } from '@/lib/device'
import { env } from '@/lib/env'
import { masteryOf } from '@/lib/exam'
import { FILE_TYPES, mediaOf } from '@/lib/file-types'
import { newFileMeta, newFolderMeta } from '@/lib/defaults'
import { newId, nowIso } from '@/lib/ids'
import { keepLocalMedia, type LocalMedia, readLocalMedia } from '@/lib/recording/media-library'
import { bytesOf, type Repository, type StoredSize } from '@/lib/storage/repository'
import { downloadStoredSource, sourceExpired, storeSource } from '@/lib/storage/source-storage'
import { RECORDER, withRecorder } from '@/lib/transcription/turns'
import { readingMinutes, wordCount } from '@/utils/format'
import type { TrackedTask } from '@/stores/jobs'
import type { OpenedFile } from '@/stores/library'

const DAY_MS = 24 * 3600 * 1000
const ATTEMPTS_KEY = 'study-helper:shared-attempts'

export interface ShareTarget {
  kind: ShareKind
  id: string
}

export type SharedAttempts = Record<string, Attempt[]>

export function shareUrl(id: string, origin: string = window.location.origin): string {
  return `${origin}${env.basePath.replace(/\/$/, '')}/shared/${id}`
}

export function isExpired(expiresAt: string, now = Date.now()): boolean {
  return Date.parse(expiresAt) <= now
}

export function daysLeft(expiresAt: string, now = Date.now()): number {
  return Math.max(0, Math.ceil((Date.parse(expiresAt) - now) / DAY_MS))
}

export function daysLeftText(expiresAt: string, now = Date.now()): string {
  if (isExpired(expiresAt, now)) return 'expirado'
  const days = daysLeft(expiresAt, now)
  return days === 1 ? '1 dia' : `${days} dias`
}

export function activeLinks(links: SharedLink[], now = Date.now()): SharedLink[] {
  return links.filter(link => !isExpired(link.expiresAt, now))
}

export function shareBytes(content: ShareContent): number {
  return bytesOf(JSON.stringify(content))
}

function folderTree(folders: FolderMeta[], rootId: string): FolderMeta[] {
  const live = folders.filter(folder => !folder.deletedAt)
  const walk = (id: string): FolderMeta[] => {
    const folder = live.find(item => item.id === id)
    if (!folder) return []
    return [folder, ...live.filter(item => item.parentId === id).sort((a, b) => a.position - b.position).flatMap(child => walk(child.id))]
  }
  return walk(rootId)
}

/** `recorder`: name of who shares, for the microphone voice of notes transcribed back when it was "Você". */
export async function buildShareContent(target: ShareTarget, folders: FolderMeta[], files: FileMeta[], open: (id: string) => Promise<OpenedFile>, withExams: boolean, recorder = ''): Promise<ShareContent> {
  const tree = target.kind === 'folder' ? folderTree(folders, target.id) : []
  const folderIds = new Set(tree.map(folder => folder.id))
  const chosen = target.kind === 'file' ? files.filter(file => file.id === target.id) : files.filter(file => !file.deletedAt && file.folderId !== null && folderIds.has(file.folderId)).sort((a, b) => a.position - b.position)
  const sharedFolders: SharedFolder[] = tree.map(folder => ({
    id: folder.id,
    name: folder.name,
    parentId: folder.id === target.id ? null : folder.parentId,
    position: folder.position,
    isCourse: folder.isCourse,
    description: folder.description,
  }))
  const sharedFiles: SharedFile[] = []
  for (const file of chosen) {
    const opened = await open(file.id)
    const recording = opened.sidecar.recording && withRecorder(opened.sidecar.recording, recorder)
    // only the speaker label at the start of a line: "Você" inside what was said stays
    const named = (text: string) => (recording !== opened.sidecar.recording ? text.replace(/^Você(?= \[)/gm, recorder.trim() || RECORDER) : text)
    sharedFiles.push({
      id: file.id,
      name: file.name,
      folderId: target.kind === 'file' ? null : file.folderId,
      type: file.type,
      position: file.position,
      description: file.description,
      tags: file.tags,
      content: named(opened.content),
      questions: withExams ? opened.sidecar.questions : [],
      highlights: opened.sidecar.highlights,
      ...(opened.sidecar.transcript !== undefined ? { transcript: named(opened.sidecar.transcript) } : {}),
      ...(recording ? { recording } : {}),
      ...(opened.sidecar.documents ? { documents: opened.sidecar.documents } : {}),
      meta: { ...file, mastery: null, lastReviewedAt: null },
    })
  }
  const title = target.kind === 'folder' ? (tree[0]?.name ?? '') : (chosen[0]?.name ?? '')
  return { kind: target.kind, title, folders: sharedFolders, files: sharedFiles }
}

export interface ShareMedia {
  fileId: string
  name: string
  mime: string
  size: number | null
  read(): Promise<Blob>
}

async function blobOf(source: Blob | string): Promise<Blob> {
  if (typeof source !== 'string') return source
  const response = await fetch(source)
  if (!response.ok) throw new Error('Não consegui baixar a mídia guardada.')
  return response.blob()
}

export function shareMediaOf(content: ShareContent, files: FileMeta[], localMedia: LocalMedia[], repo: Repository | null): ShareMedia[] {
  const found: ShareMedia[] = []
  for (const shared of content.files) {
    const meta = files.find(file => file.id === shared.id)
    const origin = meta?.origin ?? null
    const kind = meta ? mediaOf(meta) : 'text'
    const local = localMedia.find(item => item.fileIds.includes(shared.id))
    const fallback = `${kind === 'video' ? 'video' : 'audio'}/webm`
    if (local) found.push({ fileId: shared.id, name: local.name, mime: local.mime || origin?.mime || fallback, size: local.size || null, read: () => readLocalMedia(local) })
    else if (origin && repo && kind !== 'text' && (origin.storedFileId || origin.storedUrl) && !origin.removedAt && !sourceExpired(origin))
      found.push({ fileId: shared.id, name: origin.name, mime: origin.mime || fallback, size: origin.sizeBytes ?? null, read: async () => blobOf(await downloadStoredSource(origin, repo)) })
  }
  return found
}

export async function questionCountOf(target: ShareTarget, folders: FolderMeta[], files: FileMeta[]): Promise<number> {
  const ids = target.kind === 'folder' ? new Set(folderTree(folders, target.id).map(folder => folder.id)) : null
  return files.filter(file => (ids ? !file.deletedAt && file.folderId !== null && ids.has(file.folderId) : file.id === target.id)).reduce((sum, file) => sum + file.questionCount, 0)
}

export function readSharedAttempts(shareId: string): SharedAttempts {
  try {
    return JSON.parse(localStorage.getItem(`${ATTEMPTS_KEY}:${shareId}`) ?? '{}') as SharedAttempts
  } catch {
    return {}
  }
}

export function saveSharedAttempt(shareId: string, fileId: string, fields: Omit<Attempt, 'id' | 'createdAt' | 'deviceId'>): SharedAttempts {
  const all = readSharedAttempts(shareId)
  const attempt: Attempt = { ...fields, id: newId(), createdAt: nowIso(), deviceId: currentDevice().id }
  const next = { ...all, [fileId]: [...(all[fileId] ?? []), attempt] }
  try {
    localStorage.setItem(`${ATTEMPTS_KEY}:${shareId}`, JSON.stringify(next))
  } catch {
    return next
  }
  return next
}

export interface ImportActions {
  createFolder(fields: Partial<FolderMeta> & { name: string }): Promise<FolderMeta>
  createFile(fields: Partial<FileMeta> & { name: string; type: FileMeta['type'] }, content: string): Promise<FileMeta>
  updateSidecar(id: string, change: (sidecar: OpenedFile['sidecar']) => OpenedFile['sidecar']): Promise<unknown>
}

function knownType(type: string): FileMeta['type'] {
  return FILE_TYPES.find(item => item.id === type)?.id ?? 'reading'
}

export type MediaPlace = 'browser' | 'drive'

export interface MediaImport {
  place: MediaPlace
  repo: Repository | null
  track(title: string): TrackedTask
}

export function hasSharedMedia(item: SharedItem, now = Date.now()): boolean {
  return !(item.mediaExpiresAt && isExpired(item.mediaExpiresAt, now)) && item.files.some(file => file.media)
}

async function downloadSharedMedia(media: SharedMedia, progress: (fraction: number) => void): Promise<Blob> {
  const response = await fetch(media.url).catch(() => null)
  if (!response?.ok) throw new Error('Não consegui baixar a mídia compartilhada.')
  if (!response.body) return response.blob()
  const total = Number(response.headers.get('Content-Length')) || media.size
  const reader = response.body.getReader()
  const parts: BlobPart[] = []
  let received = 0
  for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) {
    parts.push(chunk.value)
    received += chunk.value.byteLength
    if (total) progress(Math.min(1, received / total))
  }
  return new Blob(parts)
}

async function keepSharedMedia(file: SharedFile, media: SharedMedia, fileId: string, options: MediaImport, task: TrackedTask): Promise<SourceMeta> {
  const shared = file.meta?.origin
  const blob = await downloadSharedMedia(media, fraction => task.update(`Baixando a mídia: ${Math.round(fraction * 100)}%`, fraction))
  const mime = media.mime || shared?.mime || blob.type
  const kept = new File([blob], shared?.name || file.name, { type: mime })
  const origin: SourceMeta = { input: shared?.input === 'file' ? 'file' : 'recording', name: kept.name, mime, sizeBytes: shared?.sizeBytes ?? kept.size, ...(shared?.durationSeconds ? { durationSeconds: shared.durationSeconds } : {}), storage: 'none' }
  if (options.place === 'drive' && options.repo) {
    task.update('Guardando no Google Drive', null)
    return { ...origin, ...(await storeSource(kept, 'drive', fileId, options.repo, '72h')) }
  }
  task.update('Guardando neste navegador', null)
  await keepLocalMedia(kept, fileId, shared?.durationSeconds ?? 0)
  return origin
}

export async function importSharedItem(item: SharedItem, attempts: SharedAttempts, actions: ImportActions, media?: MediaImport): Promise<{ folderId: string | null; fileId: string | null }> {
  const withMedia = media && hasSharedMedia(item) ? media : null
  const folderIds = new Map<string, string>()
  const pending = [...item.folders]
  while (pending.length) {
    const index = pending.findIndex(folder => folder.parentId === null || folderIds.has(folder.parentId) || !item.folders.some(other => other.id === folder.parentId))
    const [folder] = pending.splice(index < 0 ? 0 : index, 1)
    const created = await actions.createFolder({
      name: folder.name,
      parentId: folder.parentId ? (folderIds.get(folder.parentId) ?? null) : null,
      position: folder.position,
      isCourse: folder.isCourse,
      description: folder.description,
    })
    folderIds.set(folder.id, created.id)
  }
  let firstFileId: string | null = null
  for (const file of item.files) {
    const meta = await actions.createFile(
      { name: file.name, type: knownType(file.type), folderId: file.folderId ? (folderIds.get(file.folderId) ?? null) : null, position: file.position, description: file.description, tags: file.tags, origin: { input: 'shared', name: item.title, url: shareUrl(item.id), storage: 'none' } },
      file.content,
    )
    firstFileId ??= meta.id
    const fileAttempts = attempts[file.id] ?? []
    const last = fileAttempts[fileAttempts.length - 1]
    await actions.updateSidecar(meta.id, sidecar => ({
      ...sidecar,
      questions: file.questions,
      attempts: fileAttempts,
      highlights: file.highlights ?? [],
      ...(file.transcript !== undefined ? { transcript: file.transcript } : {}),
      ...(file.recording ? { recording: file.recording } : {}),
      ...(file.documents ? { documents: file.documents } : {}),
      meta: { ...sidecar.meta, questionCount: file.questions.length, ...(last ? { mastery: masteryOf(last.correct, last.total), lastReviewedAt: last.createdAt } : {}) },
    }))
    if (withMedia && file.media) {
      const task = withMedia.track(`Guardar a mídia: ${meta.name}`)
      try {
        const origin = await keepSharedMedia(file, file.media, meta.id, withMedia, task)
        await actions.updateSidecar(meta.id, sidecar => ({ ...sidecar, meta: { ...sidecar.meta, origin } }))
        task.done('Mídia guardada.')
      } catch (error) {
        task.fail(error instanceof Error ? error.message : 'Não consegui guardar a mídia.')
      }
    }
  }
  const rootId = item.folders.find(folder => folder.parentId === null)?.id
  return { folderId: rootId ? (folderIds.get(rootId) ?? null) : null, fileId: item.kind === 'file' ? firstFileId : null }
}

export interface SharedLibrary {
  folders: FolderMeta[]
  files: FileMeta[]
  opened: Record<string, OpenedFile>
  sizes: Record<string, StoredSize>
}

export function sharedLibrary(item: SharedItem, attempts: SharedAttempts): SharedLibrary {
  const folders = item.folders.map(folder => ({ ...newFolderMeta({ name: folder.name, parentId: folder.parentId, position: folder.position, isCourse: folder.isCourse, description: folder.description }), id: folder.id }))
  const opened: Record<string, OpenedFile> = {}
  const files = item.files.map(file => {
    const done = attempts[file.id] ?? []
    const last = done[done.length - 1]
    const meta: FileMeta = {
      ...newFileMeta({ name: file.name, type: knownType(file.type), folderId: file.folderId, position: file.position, description: file.description, tags: file.tags }),
      ...file.meta,
      id: file.id,
      name: file.name,
      folderId: file.folderId,
      favorite: false,
      deletedAt: null,
      origin: file.meta?.origin ?? null,
      questionCount: file.questions.length,
      mastery: last ? masteryOf(last.correct, last.total) : null,
      lastReviewedAt: last?.createdAt ?? null,
      words: wordCount(file.content),
      readingMinutes: file.content ? readingMinutes(file.content) : 0,
    }
    opened[file.id] = { content: file.content, sidecar: { meta, questions: file.questions, attempts: done, highlights: file.highlights ?? [], ...(file.transcript !== undefined ? { transcript: file.transcript } : {}), ...(file.recording ? { recording: file.recording } : {}), ...(file.documents ? { documents: file.documents } : {}) } }
    return meta
  })
  const sizes = Object.fromEntries(files.map(meta => [meta.id, { noteBytes: bytesOf(opened[meta.id].content) + bytesOf(JSON.stringify(opened[meta.id].sidecar)), sourceBytes: 0 }]))
  return { folders, files, opened, sizes }
}
