import type { Attempt, FileMeta, FolderMeta, ShareContent, SharedFile, SharedFolder, SharedItem, SharedLink, ShareKind } from '@/types/domain'
import { currentDevice } from '@/lib/device'
import { env } from '@/lib/env'
import { masteryOf } from '@/lib/exam'
import { FILE_TYPES } from '@/lib/file-types'
import { newId, nowIso } from '@/lib/ids'
import { bytesOf } from '@/lib/storage/repository'
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

export async function buildShareContent(target: ShareTarget, folders: FolderMeta[], files: FileMeta[], open: (id: string) => Promise<OpenedFile>, withExams: boolean): Promise<ShareContent> {
  const tree = target.kind === 'folder' ? folderTree(folders, target.id) : []
  const folderIds = new Set(tree.map(folder => folder.id))
  const chosen = target.kind === 'file' ? files.filter(file => file.id === target.id) : files.filter(file => !file.deletedAt && file.status === 'ready' && file.folderId !== null && folderIds.has(file.folderId)).sort((a, b) => a.position - b.position)
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
    sharedFiles.push({
      id: file.id,
      name: file.name,
      folderId: target.kind === 'file' ? null : file.folderId,
      type: file.type,
      position: file.position,
      description: file.description,
      tags: file.tags,
      content: opened.content,
      questions: withExams ? opened.sidecar.questions : [],
      highlights: opened.sidecar.highlights,
      ...(opened.sidecar.transcript !== undefined ? { transcript: opened.sidecar.transcript } : {}),
      meta: { ...file, mastery: null, lastReviewedAt: null },
    })
  }
  const title = target.kind === 'folder' ? (tree[0]?.name ?? '') : (chosen[0]?.name ?? '')
  return { kind: target.kind, title, folders: sharedFolders, files: sharedFiles }
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

export async function importSharedItem(item: SharedItem, attempts: SharedAttempts, actions: ImportActions): Promise<{ folderId: string | null; fileId: string | null }> {
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
      meta: { ...sidecar.meta, questionCount: file.questions.length, ...(last ? { mastery: masteryOf(last.correct, last.total), lastReviewedAt: last.createdAt } : {}) },
    }))
  }
  const rootId = item.folders.find(folder => folder.parentId === null)?.id
  return { folderId: rootId ? (folderIds.get(rootId) ?? null) : null, fileId: item.kind === 'file' ? firstFileId : null }
}
