import type { Artifact, ArtifactKind, Attempt, FileMeta, FolderMeta, ShareContent, ShareRecord, SharedFile, SharedFolder, SharedItem, SharedLink, SharedMedia, ShareKind, SourceMeta } from '@/types/domain'
import { artifactMeta, artifactsOf } from '@/lib/artifacts'
import { currentDevice } from '@/lib/device'
import { env } from '@/lib/env'
import { masteryOf } from '@/lib/exam'
import { FILE_TYPES, mediaOf, SOURCE_TYPES, sourceTypeOf } from '@/lib/file-types'
import { today } from '@/lib/generation/cards'
import { mapToMermaid } from '@/lib/generation/map-render'
import { newFileMeta, newFolderMeta } from '@/lib/defaults'
import { newId, nowIso } from '@/lib/ids'
import { folderNamed, folderTaken, type NameRule, type NameTakenError, noteNamed, noteTaken, placeOf } from '@/lib/names'
import { keepLocalMedia, type LocalMedia, readLocalMedia } from '@/lib/recording/media-library'
import { makeSeekable } from '@/lib/recording/seekable'
import { choiceOf, defaultChoice, type EntryShareChoice, entryShareTree } from '@/lib/share-entry'
import { fileMetaOf, folderOf, sidecarOf } from '@/lib/storage/app-repository'
import { bytesOf, type Repository, type StoredSize } from '@/lib/storage/repository'
import { downloadStoredSource, sourceExpired, storeSource } from '@/lib/storage/source-storage'
import { RECORDER, withRecorder } from '@/lib/transcription/turns'
import { readingMinutes, wordCount } from '@/utils/format'
import type { TrackedTask } from '@/stores/jobs'
import { type LiveContent, liveMediaUrl } from '@/controllers/live-share.controller'
import type { LibraryRow } from '@/controllers/library-api.controller'
import type { OpenedFile } from '@/stores/library'

const DAY_MS = 24 * 3600 * 1000
const ATTEMPTS_KEY = 'study-helper:shared-attempts'

export interface ShareTarget {
  kind: ShareKind
  id: string
}

export type SharedAttempts = Record<string, Attempt[]>

export type SharedArtifact = NonNullable<SharedFile['artifacts']>[number]

export function shareUrl(id: string, origin: string = window.location.origin): string {
  // the Worker page carries the whole content for AI agents, which do not run the app, and sends a person on to the app
  if (env.shareWorkerUrl) return `${env.shareWorkerUrl}/s/${id}`
  return `${origin}${env.basePath.replace(/\/$/, '')}/shared/${id}`
}

/** A link of the App never expires (spec 003, FR-036): the far date keeps it valid wherever a link is checked for its days. */
export const LIVE_EXPIRES = '9999-12-31T23:59:59.000Z'

/** The link of the App opens the app itself: the item's page, read from the App as it is now (no share-worker). */
export function appShareUrl(id: string, origin: string = window.location.origin): string {
  return `${origin}${env.basePath.replace(/\/$/, '')}/shared/${id}`
}

/** The address of a link of the App that people copy and agents read (spec 007, FR-038): the service's page, which takes people to the app. */
export function liveShareUrl(id: string): string {
  return env.apiUrl ? `${env.apiUrl.replace(/\/$/, '')}/s/${id}` : appShareUrl(id)
}

/** The address of a link made or received: the service's page for a link of the App, else the one of the share-worker. */
export function linkUrl(link: { id: string; live?: boolean }): string {
  return link.live ? liveShareUrl(link.id) : shareUrl(link.id)
}

/** A link of the App without a deadline (the far date of before, or none). */
export const permanent = (expiresAt: string | null | undefined) => !expiresAt || expiresAt === LIVE_EXPIRES

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

/** The link of an item made before and still valid: a note shared as "arquivo" is the same item as when it is an entrada (the migration made the old media notes entradas), a folder is another thing. */
export function findValidShare(shares: ShareRecord[], target: ShareKind, itemId: string, now = Date.now()): ShareRecord | null {
  const sameKind = (kind: ShareKind) => (kind === 'folder') === (target === 'folder')
  // a link of the App is not the share-worker's: its window asks the App (ShareDialog)
  const found = shares.filter(record => record.itemId === itemId && !record.live && sameKind(record.kind) && !isExpired(record.expiresAt, now))
  return found.reduce<ShareRecord | null>((best, record) => (!best || Date.parse(record.expiresAt) > Date.parse(best.expiresAt) ? record : best), null)
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

/** What of an artifact goes in a link: the map without its conversation, versions or highlight, with its Mermaid code; the cards without their review progress. */
function sharedArtifact(artifact: Artifact): SharedArtifact {
  if (artifact.kind === 'mapa') return { id: artifact.id, kind: 'mapa', name: artifact.name, diagram: artifact.diagram, mermaid: mapToMermaid(artifact.diagram) }
  if (artifact.kind === 'cartoes') return { id: artifact.id, kind: 'cartoes', name: artifact.name, cards: artifact.cards.map(({ id, front, back }) => ({ id, front, back })) }
  return { id: artifact.id, kind: 'tutor', name: artifact.name, turns: artifact.turns.map(({ who, text }) => ({ who, text })) }
}

// the summary of every artifact and the due dates of the cards stay home: only the chosen artifacts go, in their own field
function sharedMeta({ artifacts: _artifacts, cardDue: _cardDue, hasMindmap: _hasMindmap, ...meta }: FileMeta): Partial<FileMeta> {
  return { ...meta, mastery: null, lastReviewedAt: null }
}

interface SharedFileOptions {
  folderId: string | null
  withExams: boolean
  artifact(artifact: Artifact): boolean
  meta: Partial<FileMeta>
}

/** A note as it goes in a link: `recorder` names the microphone voice of notes transcribed back when it was "Você". */
function sharedFileOf(file: FileMeta, opened: OpenedFile, recorder: string, options: SharedFileOptions): SharedFile {
  const recording = opened.sidecar.recording && withRecorder(opened.sidecar.recording, recorder)
  // only the speaker label at the start of a line: "Você" inside what was said stays
  const named = (text: string) => (recording !== opened.sidecar.recording ? text.replace(/^Você(?= \[)/gm, recorder.trim() || RECORDER) : text)
  const artifacts = artifactsOf(opened.sidecar).filter(options.artifact).map(sharedArtifact)
  return {
    id: file.id,
    name: file.name,
    folderId: options.folderId,
    type: file.type,
    position: file.position,
    description: file.description,
    tags: file.tags,
    content: named(opened.content),
    questions: options.withExams ? opened.sidecar.questions : [],
    highlights: opened.sidecar.highlights,
    ...(opened.sidecar.transcript !== undefined ? { transcript: named(opened.sidecar.transcript) } : {}),
    ...(recording ? { recording } : {}),
    ...(opened.sidecar.documents ? { documents: opened.sidecar.documents } : {}),
    ...(artifacts.length ? { artifacts } : {}),
    meta: options.meta,
  }
}

/** The source of an item without the place it is kept in: the Drive file of who shares never goes. */
function plainOrigin(origin: SourceMeta | null): SourceMeta | null {
  if (!origin) return null
  const { storedFileId: _id, storedUrl: _url, expiresAt: _expires, removedAt: _removed, ...rest } = origin
  return { ...rest, storage: 'none' }
}

/**
 * The link of an entrada (FR-065, FR-066): the entrada with its transcription, then the chosen notes in the order of the tree, each with its mother and only its chosen artifacts.
 * No folder of who shares; the exam goes with the note (FR-020). Without the media, the entrada goes as "Só o registro".
 */
export async function buildEntryShareContent(entryId: string, files: FileMeta[], open: (id: string) => Promise<OpenedFile>, choice: EntryShareChoice, recorder = ''): Promise<ShareContent> {
  const entry = files.find(file => file.id === entryId)
  if (!entry) throw new Error('Nota não encontrada.')
  // `role: 'entrada'` stays in the link only: links already made and the share-worker know the root of a family by it
  const entryMeta: Partial<FileMeta> = { ...sharedMeta(entry), role: 'entrada', folderId: null, parentFileId: null, origin: plainOrigin(entry.origin), kept: choice.media ? 'arquivo' : 'registro' }
  const sharedFiles = [sharedFileOf(entry, await open(entry.id), recorder, { folderId: null, withExams: true, artifact: () => false, meta: entryMeta })]
  for (const id of choice.notes) {
    const note = files.find(file => file.id === id)
    if (!note) continue
    // a note made from the media before entradas existed: in the link it is text, as the notes made now
    const origin = note.origin && mediaOf(note) !== 'text' ? { input: 'text' as const, name: entry.name, storage: 'none' as const } : plainOrigin(note.origin)
    const chosen = new Set(choice.artifacts[id] ?? [])
    sharedFiles.push(sharedFileOf(note, await open(id), recorder, { folderId: null, withExams: true, artifact: artifact => chosen.has(artifact.id), meta: { ...sharedMeta(note), folderId: null, origin } }))
  }
  return { kind: 'entrada', title: entry.name, folders: [], files: sharedFiles }
}

/** `recorder`: name of who shares, for the microphone voice of notes transcribed back when it was "Você". `kinds`: the artifact types that go. */
export async function buildShareContent(target: ShareTarget, folders: FolderMeta[], files: FileMeta[], open: (id: string) => Promise<OpenedFile>, withExams: boolean, recorder = '', kinds: ArtifactKind[] = []): Promise<ShareContent> {
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
  for (const file of chosen) sharedFiles.push(sharedFileOf(file, await open(file.id), recorder, { folderId: target.kind === 'file' ? null : file.folderId, withExams, artifact: artifact => kinds.includes(artifact.kind), meta: sharedMeta(file) }))
  const title = target.kind === 'folder' ? (tree[0]?.name ?? '') : (chosen[0]?.name ?? '')
  return { kind: target.kind, title, folders: sharedFolders, files: sharedFiles }
}

/**
 * The link of the App as the app shows any link (spec 003, história 7): the same notes, meta and artifacts the link of before carries,
 * built by the same code from what the App answers now; the media plays straight from the App. An entrada goes whole: every note born
 * of it, with its maps, as the entrada's page shows it.
 */
export async function liveSharedItem(live: LiveContent): Promise<SharedItem> {
  const asRow = (fields: object, parts: Record<string, string> = {}) => ({ ...fields, parts }) as unknown as LibraryRow
  const files: FileMeta[] = live.files.map(row => ({ ...fileMetaOf(asRow(row), undefined), id: row.id, name: row.name, folderId: row.folderId, parentFileId: row.parentFileId, position: row.position, deletedAt: null }))
  const folders: FolderMeta[] = live.folders.map(folder => ({ ...folderOf(asRow(folder), undefined), id: folder.id, name: folder.name, parentId: folder.parentId, position: folder.position, deletedAt: null }))
  const open = async (id: string): Promise<OpenedFile> => {
    const row = live.files.find(file => file.id === id)!
    return { content: row.parts.text ?? '', sidecar: { ...sidecarOf(asRow(row, row.parts), row.parts), meta: files.find(file => file.id === id)! } }
  }
  const recorder = live.owner?.name ?? ''
  let content: ShareContent
  if (live.kind === 'entrada') {
    const tree = entryShareTree(files, live.itemId)
    const withMedia = Boolean(live.files.find(row => row.id === live.itemId)?.media)
    content = await buildEntryShareContent(live.itemId, files, open, choiceOf(tree, defaultChoice(tree, withMedia)), recorder)
  } else {
    content = await buildShareContent({ kind: live.kind, id: live.itemId }, folders, files, open, live.withExams, recorder, live.artifacts)
  }
  const media = new Map(live.files.flatMap(row => (row.media ? [[row.id, row.media] as const] : [])))
  return {
    ...content,
    title: live.title,
    files: content.files.map(file => {
      const found = media.get(file.id)
      return found ? { ...file, media: { url: liveMediaUrl(live.id, file.id), mime: found.mime, size: found.bytes } } : file
    }),
    version: 3,
    id: live.id,
    createdAt: live.createdAt,
    expiresAt: LIVE_EXPIRES,
    live: true,
  }
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

// a browser recording goes up with its duration and index: the link then jumps straight to a minute instead of downloading up to it
async function seekableWebm(media: Blob, mime: string): Promise<Blob> {
  return /webm/i.test(mime) ? makeSeekable(media) : media
}

export function shareMediaOf(content: ShareContent, files: FileMeta[], localMedia: LocalMedia[], repo: Repository | null): ShareMedia[] {
  const found: ShareMedia[] = []
  for (const shared of content.files) {
    const meta = files.find(file => file.id === shared.id)
    const origin = meta?.origin ?? null
    const kind = meta ? mediaOf(meta) : 'text'
    const local = localMedia.find(item => item.fileIds.includes(shared.id))
    const fallback = `${kind === 'video' ? 'video' : 'audio'}/webm`
    if (local) {
      const mime = local.mime || origin?.mime || fallback
      found.push({ fileId: shared.id, name: local.name, mime, size: local.size || null, read: async () => seekableWebm(await readLocalMedia(local), mime) })
    } else if (origin && repo && kind !== 'text' && (origin.storedFileId || origin.storedUrl) && !origin.removedAt && !sourceExpired(origin)) {
      const mime = origin.mime || fallback
      found.push({ fileId: shared.id, name: origin.name, mime, size: origin.sizeBytes ?? null, read: async () => seekableWebm(await blobOf(await downloadStoredSource(origin, repo)), mime) })
    }
  }
  return found
}

/** The media of an entrada that can go in its link: in this browser, or kept in the Drive or a temporary service and still there. */
export function entryMediaOf(entryId: string, files: FileMeta[], localMedia: LocalMedia[], repo: Repository | null): ShareMedia | null {
  const only: ShareContent = { kind: 'entrada', title: '', folders: [], files: [{ id: entryId } as SharedFile] }
  return shareMediaOf(only, files, localMedia, repo)[0] ?? null
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

/** `rule` (FR-021): what lands where the person chose is refused when the name is there ('block'); what comes inside it never fails for a name. */
export interface ImportActions {
  createFolder(fields: Partial<FolderMeta> & { name: string }, rule?: NameRule): Promise<FolderMeta>
  createFile(fields: Partial<FileMeta> & { name: string; type: FileMeta['type'] }, content: string, rule?: Exclude<NameRule, 'reuse'>): Promise<FileMeta>
  updateSidecar(id: string, change: (sidecar: OpenedFile['sidecar']) => OpenedFile['sidecar']): Promise<unknown>
}

function knownType(type: string): FileMeta['type'] {
  return [...FILE_TYPES, ...SOURCE_TYPES].find(item => item.id === type)?.id ?? 'reading'
}

/** 'app' and 'drive' keep the media with its note, where the note is born; the window says which one before. */
export type MediaPlace = 'browser' | 'drive' | 'app'

export interface MediaImport {
  place: MediaPlace
  repo: Repository | null
  track(title: string): TrackedTask
  /** Media already downloaded while the link was still open, by the id of the shared note: it only has to be stored. */
  downloaded?: Map<string, Blob>
  /** Media that could not be downloaded, by the id of the shared note, with the reason: the note comes without it. */
  failed?: Map<string, string>
}

export function hasSharedMedia(item: SharedItem, now = Date.now()): boolean {
  return !(item.mediaExpiresAt && isExpired(item.mediaExpiresAt, now)) && item.files.some(file => file.media)
}

export type SharedMediaState = { kind: 'ready'; media: SharedMedia } | ({ kind: 'pending' } & Omit<SharedMedia, 'url'>) | { kind: 'expired' } | { kind: 'none' }

/** What the link says about the media of a note: there, still going up (or the upload did not finish), past its 3 days, or none. */
export function sharedMediaState(item: SharedItem, file: SharedFile | undefined, now = Date.now()): SharedMediaState {
  if (!file?.media && !file?.mediaPending) return { kind: 'none' }
  if (item.mediaExpiresAt && isExpired(item.mediaExpiresAt, now)) return { kind: 'expired' }
  if (file.media) return { kind: 'ready', media: file.media }
  return { kind: 'pending', ...file.mediaPending! }
}

const MEDIA_EXPIRED_TEXT = 'A mídia deste compartilhamento expirou (fica 3 dias).'

/** The reason a media of a link did not come, from what the Worker answered (`null`: no answer at all). */
export function sharedMediaFailure(status: number | null): string {
  if (status === null) return 'Sem conexão com o serviço de compartilhamento. Confira a internet e tente de novo.'
  if (status === 410) return MEDIA_EXPIRED_TEXT
  if (status === 404) return 'A mídia ainda não terminou de subir, ou quem compartilhou a apagou.'
  if (status === 403) return 'Este endereço do app não tem permissão para baixar a mídia do link.'
  return `O serviço de compartilhamento não respondeu direito (erro ${status}). Tente de novo daqui a pouco.`
}

async function downloadSharedMedia(media: SharedMedia, progress: (fraction: number) => void): Promise<Blob> {
  const response = await fetch(media.url).catch(() => null)
  if (!response?.ok) throw new Error(sharedMediaFailure(response?.status ?? null))
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

/** The entrada of a link: the note that says so, or the first one. */
function entryOf(item: SharedItem): SharedFile {
  return item.files.find(file => file.meta?.role === 'entrada') ?? item.files[0]
}

/** What the link says about its media as a whole: the entrada's for an entrada, else the best state among the notes (ready, then going up, then past its days). */
export function linkMediaState(item: SharedItem, now = Date.now()): SharedMediaState {
  const states = (item.kind === 'entrada' ? [entryOf(item)] : item.files).map(file => sharedMediaState(item, file, now))
  return states.find(state => state.kind === 'ready') ?? states.find(state => state.kind === 'pending') ?? states.find(state => state.kind === 'expired') ?? { kind: 'none' }
}

function failureText(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback
}

/**
 * The media of the entrada of a link, downloaded before the person leaves the link (it can be hundreds of MB): the link stays open with the progress,
 * and nothing is created in the library until the media is in hand. A media that does not come is told apart, and the entrada then goes as "Só o registro".
 */
export async function prefetchEntryMedia(item: SharedItem, progress: (fraction: number) => void): Promise<Pick<MediaImport, 'downloaded' | 'failed'>> {
  const downloaded = new Map<string, Blob>()
  const failed = new Map<string, string>()
  const entry = entryOf(item)
  if (entry?.media && hasSharedMedia(item)) {
    try {
      downloaded.set(entry.id, await downloadSharedMedia(entry.media, progress))
    } catch (error) {
      failed.set(entry.id, failureText(error, 'Não consegui baixar a mídia compartilhada.'))
    }
  }
  return { downloaded, failed }
}

async function keepSharedMedia(file: SharedFile, media: SharedMedia, fileId: string, options: MediaImport, task: TrackedTask): Promise<SourceMeta> {
  const shared = file.meta?.origin
  const blob = options.downloaded?.get(file.id) ?? (await downloadSharedMedia(media, fraction => task.update(`Baixando a mídia: ${Math.round(fraction * 100)}%`, fraction)))
  const mime = media.mime || shared?.mime || blob.type
  const kept = new File([blob], shared?.name || file.name, { type: mime })
  const origin: SourceMeta = { input: shared?.input === 'file' ? 'file' : 'recording', name: kept.name, mime, sizeBytes: shared?.sizeBytes ?? kept.size, ...(shared?.durationSeconds ? { durationSeconds: shared.durationSeconds } : {}), storage: 'none' }
  if (options.place !== 'browser' && options.repo) {
    const where = options.place === 'app' ? 'Guardando no App' : 'Guardando no Google Drive'
    task.update(where, null)
    // how much went, while it goes: a big video takes minutes, and a window that says nothing looks stuck (25/11)
    const onProgress = (sent: number, total: number) => task.update(where, total ? sent / total : null, { done: sent, total })
    return { ...origin, ...(await storeSource(kept, 'drive', fileId, options.repo, '72h', { onProgress })) }
  }
  task.update('Guardando neste navegador', null)
  await keepLocalMedia(kept, fileId, shared?.durationSeconds ?? 0)
  return origin
}

/** A shared artifact as the app keeps it: the map starts with an empty conversation, the cards start their review over. */
function ownArtifacts(list: SharedFile['artifacts'], at: string): Artifact[] {
  const day = today()
  return (list ?? []).flatMap((shared): Artifact[] => {
    const base = { id: shared.id, name: shared.name, createdAt: at, updatedAt: at }
    if (shared.kind === 'mapa') return shared.diagram?.root ? [{ ...base, kind: 'mapa', diagram: shared.diagram, versions: [], chat: [] }] : []
    if (shared.kind === 'cartoes') return [{ ...base, kind: 'cartoes', cards: (shared.cards ?? []).map(({ id, front, back }) => ({ id, front, back, box: 0, due: day })) }]
    if (shared.kind === 'tutor') return [{ ...base, kind: 'tutor', turns: (shared.turns ?? []).map(({ who, text }) => ({ who, text })) }]
    return []
  })
}

/** What of a shared note lives in its sidecar: the exam with the attempts made in the link, highlights, transcription, Ata and artifacts. */
async function fillImported(actions: ImportActions, id: string, file: SharedFile, attempts: SharedAttempts, at: string): Promise<void> {
  const fileAttempts = attempts[file.id] ?? []
  const last = fileAttempts[fileAttempts.length - 1]
  const artifacts = ownArtifacts(file.artifacts, at)
  await actions.updateSidecar(id, sidecar => ({
    ...sidecar,
    questions: file.questions,
    attempts: fileAttempts,
    highlights: file.highlights ?? [],
    ...(file.transcript !== undefined ? { transcript: file.transcript } : {}),
    ...(file.recording ? { recording: file.recording } : {}),
    ...(file.documents ? { documents: file.documents } : {}),
    ...(artifacts.length ? { artifacts } : {}),
    meta: { ...sidecar.meta, questionCount: file.questions.length, ...(last ? { mastery: masteryOf(last.correct, last.total), lastReviewedAt: last.createdAt } : {}), ...(artifacts.length ? artifactMeta(artifacts) : {}) },
  }))
}

/**
 * Stores the media of an imported note; the reason it did not go is returned, so the person is told and the note is not left pointing at a
 * file that is not there. An entrada says it keeps the file (`kept`) only here, when the file arrived: a send cut in the middle (a tab
 * closed, 25/11) leaves it as "Só o registro".
 */
async function keepImportedMedia(actions: ImportActions, meta: FileMeta, file: SharedFile, media: SharedMedia, options: MediaImport, entry = false): Promise<string | null> {
  const task = options.track(`Guardar a mídia: ${meta.name}`)
  try {
    const origin = await keepSharedMedia(file, media, meta.id, options, task)
    await actions.updateSidecar(meta.id, sidecar => ({ ...sidecar, meta: { ...sidecar.meta, origin, ...(entry ? { kept: 'arquivo' as const } : {}) } }))
    task.done('Mídia guardada.')
    return null
  } catch (error) {
    const reason = failureText(error, 'Não consegui guardar a mídia.')
    task.fail(reason)
    return reason
  }
}

export async function importSharedItem(item: SharedItem, attempts: SharedAttempts, actions: ImportActions, media?: MediaImport): Promise<{ folderId: string | null; fileId: string | null; mediaFailed?: string }> {
  const withMedia = media && hasSharedMedia(item) ? media : null
  const folderIds = new Map<string, string>()
  const pending = [...item.folders]
  while (pending.length) {
    const index = pending.findIndex(folder => folder.parentId === null || folderIds.has(folder.parentId) || !item.folders.some(other => other.id === folder.parentId))
    const [folder] = pending.splice(index < 0 ? 0 : index, 1)
    const parentId = folder.parentId ? (folderIds.get(folder.parentId) ?? null) : null
    // the folder of the link lands in the Biblioteca: a name there refuses it; the ones inside it are the link's own (FR-021)
    const created = await actions.createFolder(
      {
        name: folder.name,
        parentId,
        position: folder.position,
        isCourse: folder.isCourse,
        description: folder.description,
      },
      parentId === null ? 'block' : 'reuse',
    )
    folderIds.set(folder.id, created.id)
  }
  let firstFileId: string | null = null
  let mediaFailed: string | undefined
  for (const file of item.files) {
    const folderId = file.folderId ? (folderIds.get(file.folderId) ?? null) : null
    const meta = await actions.createFile(
      { name: file.name, type: knownType(file.type), folderId, position: file.position, description: file.description, tags: file.tags, origin: { input: 'shared', name: item.title, url: linkUrl(item), storage: 'none' } },
      file.content,
      folderId === null ? 'block' : 'number',
    )
    firstFileId ??= meta.id
    await fillImported(actions, meta.id, file, attempts, item.createdAt)
    if (withMedia && file.media) mediaFailed ??= (await keepImportedMedia(actions, meta, file, file.media, withMedia)) ?? undefined
  }
  const rootId = item.folders.find(folder => folder.parentId === null)?.id
  return { folderId: rootId ? (folderIds.get(rootId) ?? null) : null, fileId: item.kind === 'file' ? firstFileId : null, ...(mediaFailed ? { mediaFailed } : {}) }
}

/** "(cópia N)" when this link was already imported (FR-071): only the entrada changes its name. */
function copyName(name: string, existing: FileMeta[], shareId: string): string {
  const taken = new Set(existing.filter(file => file.sharedFrom === shareId).map(file => file.name))
  if (!taken.size) return name
  let copy = 1
  while (taken.has(`${name} (cópia ${copy})`)) copy++
  return `${name} (cópia ${copy})`
}

/**
 * FR-021 ("Bloquear e avisar", 25/11): what the import would repeat where it lands, said before anything is downloaded or written; null
 * when it fits. An entrada lands in the folder chosen (as "(cópia N)" when this link came before); a folder or a note, in the Biblioteca.
 * `files` and `folders`: the library of who imports.
 */
export function importConflict(item: SharedItem, folderId: string | null, files: FileMeta[], folders: FolderMeta[]): NameTakenError | null {
  if (item.kind === 'entrada') {
    const there = noteNamed(files, folderId, copyName(entryOf(item).name, files, item.id))
    return there ? noteTaken(there.name, placeOf(folders, folderId)) : null
  }
  const ids = new Set(item.folders.map(folder => folder.id))
  for (const folder of item.folders.filter(folder => !folder.parentId || !ids.has(folder.parentId))) {
    const there = folderNamed(folders, null, folder.name)
    if (there) return folderTaken(there.name, placeOf(folders, null))
  }
  for (const file of item.files.filter(file => !file.folderId || !ids.has(file.folderId))) {
    const there = noteNamed(files, null, file.name)
    if (there) return noteTaken(there.name, placeOf(folders, null))
  }
  return null
}

export interface EntryImport {
  /** The folder chosen in the folder picker; the whole family goes into it. */
  folderId: string | null
  /** The library of who imports, to know whether this link came before. */
  existing: FileMeta[]
  media?: MediaImport
}

/** Everything in the link of an entrada, at once (FR-068, FR-069): the entrada, the notes under it and the children under their mothers, with the artifacts inside the notes. */
export async function importSharedEntry(item: SharedItem, attempts: SharedAttempts, actions: ImportActions, options: EntryImport): Promise<{ fileId: string; mediaFailed?: string }> {
  const entry = entryOf(item)
  const failedBefore = options.media?.failed?.get(entry.id)
  const withMedia = options.media && entry.media && hasSharedMedia(item) && !failedBefore ? options.media : null
  const base = (file: SharedFile) => ({ type: knownType(file.type), folderId: options.folderId, position: file.position, description: file.description, tags: file.tags, origin: file.meta?.origin ?? null })
  // "Só o registro" until the media arrives (keepImportedMedia), never a note pointing at a file that is not there; a name already in the
  // folder refuses it (FR-021), and the notes under it never fail for a name
  const created = await actions.createFile({ ...base(entry), name: copyName(entry.name, options.existing, item.id), type: sourceTypeOf(entry.meta?.origin), kept: 'registro', parentFileId: null, sharedFrom: item.id }, entry.content, 'block')
  await fillImported(actions, created.id, entry, attempts, item.createdAt)
  const ids = new Map([[entry.id, created.id]])
  // mothers first: a note whose mother did not come hangs from the entrada
  const pending = item.files.filter(file => file !== entry)
  while (pending.length) {
    const index = pending.findIndex(file => !pending.some(other => other.id === file.meta?.parentFileId))
    const [file] = pending.splice(Math.max(index, 0), 1)
    const meta = await actions.createFile({ ...base(file), name: file.name, parentFileId: ids.get(file.meta?.parentFileId ?? '') ?? created.id }, file.content)
    ids.set(file.id, meta.id)
    await fillImported(actions, meta.id, file, attempts, item.createdAt)
  }
  const failedNow = withMedia && entry.media ? await keepImportedMedia(actions, created, entry, entry.media, withMedia, true) : null
  const mediaFailed = failedBefore ?? failedNow ?? undefined
  return mediaFailed ? { fileId: created.id, mediaFailed } : { fileId: created.id }
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
    const artifacts = ownArtifacts(file.artifacts, item.createdAt)
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
      // only what came in the link, never the summary of the sharer's note; read only, so no card is due
      ...artifactMeta(artifacts),
      cardDue: [],
    }
    opened[file.id] = { content: file.content, sidecar: { meta, questions: file.questions, attempts: done, highlights: file.highlights ?? [], ...(file.transcript !== undefined ? { transcript: file.transcript } : {}), ...(file.recording ? { recording: file.recording } : {}), ...(file.documents ? { documents: file.documents } : {}), artifacts } }
    return meta
  })
  const sizes = Object.fromEntries(files.map(meta => [meta.id, { noteBytes: bytesOf(opened[meta.id].content) + bytesOf(JSON.stringify(opened[meta.id].sidecar)), sourceBytes: 0 }]))
  return { folders, files, opened, sizes }
}
