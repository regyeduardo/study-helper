import type { Artifact, FileMeta, FileSidecar, FolderMeta, LibraryIndex, Snapshot } from '@/types/domain'
import { ApiError, getMe } from '@/controllers/api.controller'
import {
  deleteItem,
  deleteMedia,
  deletePart,
  getIndex,
  getItem,
  getMap,
  getMedia,
  getPart,
  getParts,
  type LibraryRow,
  type LibraryRowFields,
  mediaUrl,
  putIndex,
  putItem,
  putPart,
} from '@/controllers/library-api.controller'
import { defaultIndex } from '@/lib/defaults'
import { isRecording } from '@/lib/file-types'
import type { Conflict, ConflictResolver, RemoteChanges, Repository, StorageUsage, StoredSize, StoredSource } from '@/lib/storage/repository'
import { uploadMedia, type UploadOptions } from '@/lib/storage/uploads'
import { applyFieldChoices, hasTextConflict, joinHunks, mergeFolder, mergeKept, mergeShares, mergeSidecar, mergeText } from '@/lib/sync/merge'

/**
 * The library kept in the App (spec 003, entrega 4): the map of folders and notes on the server, each note's content in parts
 * that never change once written (a new version per save), the media in the account's storage.
 *
 * Merging (FR-016): each save says which version it was based on. When another device wrote in between, the server answers 409 and
 * this device brings the current version, joins it with its own from the common base (lines of text with `mergeText`, fields and
 * lists with `mergeSidecar`) and sends again; only the same line or field changed on both sides goes to the conflict screen of today.
 * Trash, "Apagar tudo" and restore are fields of the row, so they reach every device with the map (FR-017).
 */

const FILE_PARTS = ['text', 'source', 'transcript', 'exam', 'highlights', 'documents']
const ARTIFACT = 'artifacts/'
type Parts = Record<string, string>

/** A write was refused because the server has a newer version: merge and try again. */
class Stale extends Error {}

const stale = <T>(run: () => Promise<T>): Promise<T> =>
  run().catch(error => {
    throw error instanceof ApiError && error.code === 'conflict' ? new Stale() : error
  })

function parse<T>(text: string | undefined, fallback: T): T {
  if (text === undefined || text === '') return fallback
  try {
    return JSON.parse(text) as T
  } catch {
    return fallback
  }
}

/** The meta that goes in the map: without the source text, which is a part of its own. */
function mapMeta(meta: FileMeta): Record<string, unknown> {
  const { sourceExcerpt: _excerpt, pendingExcerpt: _pending, source, ...rest } = meta
  const out: Record<string, unknown> = { ...rest, sourceExcerpt: null, pendingExcerpt: null }
  if (source) {
    const { text: _text, ...sourceRest } = source
    out.source = sourceRest
  }
  return JSON.parse(JSON.stringify(out)) as Record<string, unknown>
}

function folderMapMeta(folder: FolderMeta): Record<string, unknown> {
  const { courseMaterial: _material, courseDescription: _description, ...rest } = folder
  return JSON.parse(JSON.stringify({ ...rest, courseMaterial: null, courseDescription: null })) as Record<string, unknown>
}

function fileFields(meta: FileMeta): LibraryRowFields {
  return {
    itemKind: 'file',
    noteType: meta.type,
    name: meta.name,
    folderId: meta.folderId,
    parentFileId: meta.parentFileId,
    place: 'app',
    placeOwn: meta.place !== undefined,
    recording: isRecording(meta),
    position: meta.position,
    meta: mapMeta(meta),
    driveRef: null,
    createdAt: meta.created.at,
    updatedAt: meta.updated.at,
    trashedAt: meta.deletedAt,
    trashedWith: meta.trashedWith ?? null,
  }
}

function folderFields(folder: FolderMeta): LibraryRowFields {
  return {
    itemKind: 'folder',
    noteType: null,
    name: folder.name,
    folderId: folder.parentId,
    parentFileId: null,
    place: 'app',
    placeOwn: folder.place !== undefined,
    recording: false,
    position: folder.position,
    meta: folderMapMeta(folder),
    driveRef: null,
    createdAt: folder.created.at,
    updatedAt: folder.updated.at,
    trashedAt: folder.deletedAt,
    trashedWith: null,
  }
}

const FIELD_KEYS = Object.keys(fileFields({ created: {}, updated: {} } as unknown as FileMeta)) as (keyof LibraryRowFields)[]
const sameFields = (row: LibraryRow, fields: LibraryRowFields) => FIELD_KEYS.every(key => JSON.stringify(row[key] ?? null) === JSON.stringify(fields[key] ?? null))

/** What each part of a note holds; a part with nothing in it is not kept. `content` undefined = the text did not change. */
function partsOf(sidecar: FileSidecar, content: string | undefined): Parts {
  const { meta } = sidecar
  const parts: Parts = {}
  if (content !== undefined) parts.text = content
  if (meta.sourceExcerpt !== null || meta.pendingExcerpt !== null || meta.source?.text !== undefined) {
    parts.source = JSON.stringify({ sourceExcerpt: meta.sourceExcerpt, pendingExcerpt: meta.pendingExcerpt, sourceText: meta.source?.text ?? null })
  }
  if (sidecar.recording !== undefined || sidecar.transcript !== undefined) parts.transcript = JSON.stringify({ recording: sidecar.recording ?? null, transcript: sidecar.transcript ?? null })
  if (sidecar.questions.length || sidecar.attempts.length) parts.exam = JSON.stringify({ questions: sidecar.questions, attempts: sidecar.attempts })
  if (sidecar.highlights.length) parts.highlights = JSON.stringify(sidecar.highlights)
  if (sidecar.documents !== undefined || sidecar.cards !== undefined || sidecar.mindmap !== undefined) {
    parts.documents = JSON.stringify({ documents: sidecar.documents ?? null, cards: sidecar.cards ?? null, mindmap: sidecar.mindmap ?? null })
  }
  for (const artifact of sidecar.artifacts ?? []) parts[`${ARTIFACT}${artifact.id}`] = JSON.stringify(artifact)
  return parts
}

function fileMetaOf(row: LibraryRow, source: string | undefined): FileMeta {
  const meta = row.meta as unknown as FileMeta
  const kept = parse<{ sourceExcerpt: string | null; pendingExcerpt: string | null; sourceText: string | null }>(source, { sourceExcerpt: null, pendingExcerpt: null, sourceText: null })
  return {
    ...meta,
    sourceExcerpt: kept.sourceExcerpt ?? null,
    pendingExcerpt: kept.pendingExcerpt ?? null,
    ...(meta.source ? { source: { ...meta.source, ...(kept.sourceText !== null ? { text: kept.sourceText } : {}) } } : {}),
  }
}

function sidecarOf(row: LibraryRow, parts: Parts): FileSidecar {
  const exam = parse<{ questions: FileSidecar['questions']; attempts: FileSidecar['attempts'] }>(parts.exam, { questions: [], attempts: [] })
  const transcript = parse<{ recording: FileSidecar['recording'] | null; transcript: string | null } | null>(parts.transcript, null)
  const documents = parse<{ documents: FileSidecar['documents'] | null; cards: FileSidecar['cards'] | null; mindmap: FileSidecar['mindmap'] | null } | null>(parts.documents, null)
  const artifactKeys = Object.keys(row.parts).filter(part => part.startsWith(ARTIFACT))
  const artifacts = artifactKeys.map(part => parse<Artifact | null>(parts[part], null)).filter((item): item is Artifact => item !== null)
  return {
    meta: fileMetaOf(row, parts.source),
    questions: exam.questions ?? [],
    attempts: exam.attempts ?? [],
    highlights: parse(parts.highlights, []),
    ...(transcript?.recording ? { recording: transcript.recording } : {}),
    ...(transcript && transcript.transcript !== null ? { transcript: transcript.transcript } : {}),
    ...(documents?.documents ? { documents: documents.documents } : {}),
    ...(documents?.cards ? { cards: documents.cards } : {}),
    ...(documents?.mindmap ? { mindmap: documents.mindmap } : {}),
    ...(artifactKeys.length ? { artifacts } : {}),
  }
}

function folderOf(row: LibraryRow, course: string | undefined): FolderMeta {
  const kept = parse<{ courseDescription: string | null; courseMaterial: string | null }>(course, { courseDescription: null, courseMaterial: null })
  return { ...(row.meta as unknown as FolderMeta), courseDescription: kept.courseDescription ?? null, courseMaterial: kept.courseMaterial ?? null }
}

/** A media id that comes from the file itself (name, size, type, date): the same file always gets the same one. */
function mediaIdOf(name: string, blob: Blob): string {
  const key = `${name}|${blob.size}|${blob.type}|${(blob as File).lastModified ?? ''}`
  let hash = 2166136261
  for (let i = 0; i < key.length; i++) hash = Math.imul(hash ^ key.charCodeAt(i), 16777619)
  return `m${(hash >>> 0).toString(36)}${blob.size.toString(36)}`
}

/** No AI key ever leaves the device in the index (the server refuses one): with the app structure, the app provides the AI. */
function withoutKeys<T>(value: T): T {
  if (Array.isArray(value)) return value.map(item => withoutKeys(item)) as T
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, /api[_-]?key$/i.test(key) && typeof item === 'string' ? '' : withoutKeys(item)])) as T
  }
  return value
}

/** The index changed on two devices: the same joins the Google Drive does (activities by id, tags, shares, received links). */
function mergeIndex(base: LibraryIndex, mine: LibraryIndex, theirs: LibraryIndex): LibraryIndex {
  const byId = new Map(mine.activities.map(activity => [activity.id, activity]))
  for (const activity of theirs.activities ?? []) {
    const own = byId.get(activity.id)
    if (!own || (!own.finishedAt && activity.finishedAt)) byId.set(activity.id, activity)
  }
  const removedTags = new Set(base.tags.filter(tag => !mine.tags.includes(tag)))
  return {
    ...mine,
    tags: [...new Set([...mine.tags, ...(theirs.tags ?? []).filter(tag => !removedTags.has(tag))])],
    activities: [...byId.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    shares: mergeShares(base.shares ?? [], mine.shares, theirs.shares ?? []),
    sharedWithMe: mergeKept(base.sharedWithMe ?? [], mine.sharedWithMe, theirs.sharedWithMe ?? []),
    ...((mine.entriesMigratedAt ?? theirs.entriesMigratedAt) ? { entriesMigratedAt: mine.entriesMigratedAt ?? theirs.entriesMigratedAt } : {}),
  }
}

export class AppRepository implements Repository {
  readonly kind = 'app' as const
  /** The last row this device saw of each item: the base of its next write. */
  private rows = new Map<string, LibraryRow>()
  /** The last version this device read or wrote of each part (`<item>/<part>`), with its content: the base of a merge. */
  private parts = new Map<string, { version: string; content: string }>()
  private seq = 0
  private index: { version: string; value: LibraryIndex } | null = null
  private resolver: ConflictResolver | null = null

  constructor(
    readonly accountId: string,
    /** How the media goes up (tests pass a wait that does not wait). */
    private readonly uploadOptions: UploadOptions = {},
  ) {}

  /** What this device already has of the map (the live channel says it to the server). */
  get currentSeq(): number {
    return this.seq
  }

  setConflictResolver(resolver: ConflictResolver): void {
    this.resolver = resolver
  }

  async load(): Promise<Snapshot> {
    this.rows.clear()
    const map = await getMap(0)
    this.seq = map.seq
    for (const row of map.rows) this.rows.set(row.id, row)
    await this.bringListParts([...this.rows.values()])
    const stored = await getIndex()
    this.index = stored ? { version: stored.version, value: { ...defaultIndex(), ...parse<Partial<LibraryIndex>>(stored.content, {}) } } : null
    return this.snapshot()
  }

  async pullChanges(): Promise<RemoteChanges> {
    const map = await getMap(this.seq)
    this.seq = Math.max(this.seq, map.seq)
    const changedFileIds: string[] = []
    for (const row of map.rows) {
      this.rows.set(row.id, row)
      if (row.itemKind === 'file') changedFileIds.push(row.id)
    }
    await this.bringListParts(map.rows)
    return { snapshot: this.snapshot(), changedFileIds: [...new Set(changedFileIds)] }
  }

  async readContent(fileId: string): Promise<string> {
    const row = this.rows.get(fileId) ?? (await this.fetchRow(fileId))
    if (!row?.parts.text) return ''
    return (await this.part(fileId, 'text', row.parts.text)) ?? ''
  }

  async readSidecar(fileId: string): Promise<FileSidecar> {
    const row = this.rows.get(fileId) ?? (await this.fetchRow(fileId))
    if (!row) throw new Error('Esta nota não existe mais no App.')
    return sidecarOf(row, await this.allParts(row))
  }

  /** A note this device has not seen in the map yet (opened by a link, before the first pull). */
  private async fetchRow(fileId: string): Promise<LibraryRow | undefined> {
    try {
      const row = await getItem(fileId)
      this.rows.set(fileId, row)
      return row
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) return undefined
      throw error
    }
  }

  async saveFile(sidecar: FileSidecar, content?: string): Promise<FileSidecar> {
    let mine = sidecar
    let text = content
    for (let round = 0; round < 4; round++) {
      try {
        await this.writeFile(mine, text)
        return mine
      } catch (error) {
        if (!(error instanceof Stale)) throw error
        ;({ sidecar: mine, content: text } = await this.mergeFile(mine, text))
      }
    }
    throw new Error('A nota mudou em outro aparelho várias vezes seguidas. Tente salvar de novo.')
  }

  async removeFile(fileId: string): Promise<void> {
    await this.removeItem(fileId)
  }

  async saveFolder(folder: FolderMeta): Promise<void> {
    let mine = folder
    for (let round = 0; round < 4; round++) {
      try {
        return await this.writeFolder(mine)
      } catch (error) {
        if (!(error instanceof Stale)) throw error
        mine = await this.mergeFolderWithServer(mine)
      }
    }
    throw new Error('A pasta mudou em outro aparelho várias vezes seguidas. Tente de novo.')
  }

  async removeFolder(folderId: string): Promise<void> {
    await this.removeItem(folderId)
  }

  async saveIndex(index: LibraryIndex): Promise<void> {
    let mine = withoutKeys(index)
    for (let round = 0; round < 4; round++) {
      try {
        const stored = await stale(() => putIndex(JSON.stringify(mine), this.index?.version ?? null))
        this.index = { version: stored.version, value: mine }
        return
      } catch (error) {
        if (!(error instanceof Stale)) throw error
        const current = await getIndex()
        const theirs = current ? { ...defaultIndex(), ...parse<Partial<LibraryIndex>>(current.content, {}) } : defaultIndex()
        mine = withoutKeys(mergeIndex(this.index?.value ?? theirs, mine, theirs))
        this.index = current ? { version: current.version, value: theirs } : null
      }
    }
    throw new Error('As configurações mudaram em outro aparelho várias vezes seguidas. Tente de novo.')
  }

  async putSource(fileId: string, blob: Blob, name: string): Promise<StoredSource> {
    // the same file again gets the same media id, so the server continues the upload that stopped instead of starting over (FR-019)
    const media = mediaIdOf(name, blob)
    await uploadMedia({ item: fileId, media, file: blob, name, mime: blob.type }, this.uploadOptions)
    return { ref: `app:${fileId}/${media}`, url: mediaUrl(fileId, media) }
  }

  async getSource(ref: string): Promise<Blob> {
    const [item, media] = this.mediaOf(ref)
    return getMedia(item, media)
  }

  /** The player streams the media from the API: the browser asks for the parts (Range) with the session cookie. */
  streamSource(ref: string): string {
    const [item, media] = this.mediaOf(ref)
    return mediaUrl(item, media)
  }

  async removeSource(ref: string): Promise<void> {
    const [item, media] = this.mediaOf(ref)
    await deleteMedia(item, media)
  }

  async usage(): Promise<StorageUsage> {
    const me = await getMe()
    const space = me?.space
    return { appBytes: (space?.notes ?? 0) + (space?.media ?? 0), limitBytes: space?.limit ?? null, cloudUsedBytes: null, cloudTotalBytes: null }
  }

  async fileSizes(fileIds?: string[]): Promise<Record<string, StoredSize>> {
    const out: Record<string, StoredSize> = {}
    for (const row of this.rows.values()) {
      if (row.itemKind !== 'file' || row.removedAt || (fileIds && !fileIds.includes(row.id))) continue
      out[row.id] = { noteBytes: row.noteBytes, sourceBytes: row.mediaBytes }
    }
    return out
  }

  async forget(): Promise<void> {
    this.rows.clear()
    this.parts.clear()
    this.index = null
    this.seq = 0
  }

  // ---------- inside ----------

  private snapshot(): Snapshot {
    const live = [...this.rows.values()].filter(row => !row.removedAt)
    return {
      folders: live.filter(row => row.itemKind === 'folder').map(row => folderOf(row, this.cached(row.id, 'course', row.parts.course))),
      files: live.filter(row => row.itemKind === 'file').map(row => fileMetaOf(row, this.cached(row.id, 'source', row.parts.source))),
      index: this.index?.value ?? defaultIndex(),
    }
  }

  private cached(id: string, part: string, version: string | undefined): string | undefined {
    const hit = version ? this.parts.get(`${id}/${part}`) : undefined
    return hit && hit.version === version ? hit.content : undefined
  }

  /** What the list shows without opening a note: the source text of notes and the course of folders, in one batch. */
  private async bringListParts(rows: LibraryRow[]): Promise<void> {
    const wanted = rows
      .filter(row => !row.removedAt)
      .flatMap(row => (['source', 'course'] as const).filter(part => row.parts[part] && this.cached(row.id, part, row.parts[part]) === undefined).map(part => ({ item: row.id, part, version: row.parts[part] })))
    if (!wanted.length) return
    for (const found of await getParts(wanted)) if (found.content !== undefined) this.parts.set(`${found.item}/${found.part}`, { version: found.version, content: found.content })
  }

  private async part(id: string, part: string, version: string): Promise<string | undefined> {
    const hit = this.cached(id, part, version)
    if (hit !== undefined) return hit
    try {
      const stored = await getPart(id, part, version)
      this.parts.set(`${id}/${part}`, { version, content: stored.content })
      return stored.content
    } catch (error) {
      if (error instanceof ApiError && error.code === 'part_not_found') return undefined
      throw error
    }
  }

  private async allParts(row: LibraryRow): Promise<Parts> {
    const out: Parts = {}
    for (const [part, version] of Object.entries(row.parts)) {
      const content = await this.part(row.id, part, version)
      if (content !== undefined) out[part] = content
    }
    return out
  }

  /** The content of a part at an exact (old) version, without touching the base this device keeps. */
  private async partAt(id: string, part: string, version: string | undefined): Promise<string | undefined> {
    if (!version) return undefined
    const hit = this.cached(id, part, version)
    if (hit !== undefined) return hit
    try {
      return (await getPart(id, part, version)).content
    } catch (error) {
      if (error instanceof ApiError && error.code === 'part_not_found') return undefined
      throw error
    }
  }

  /** Creates the row when new, writes the parts that changed and drops the ones that went away, then the row's own fields. */
  private async writeFile(sidecar: FileSidecar, content: string | undefined): Promise<void> {
    const id = sidecar.meta.id
    const fields = fileFields(sidecar.meta)
    const seen = this.rows.get(id)
    let row: LibraryRow = !seen || seen.removedAt ? await this.createRow(id, fields, seen?.rev ?? 0) : seen
    const wanted = partsOf(sidecar, content)
    for (const [part, value] of Object.entries(wanted)) {
      const base = this.parts.get(`${id}/${part}`)
      const current: string | undefined = row.parts[part]
      if (current && base && base.version === current && base.content === value) continue
      const baseVersion = base?.version ?? current ?? null
      const stored = await stale(() => putPart(id, part, value, baseVersion))
      this.parts.set(`${id}/${part}`, { version: stored.version, content: value })
      row = { ...row, parts: { ...row.parts, [part]: stored.version }, seq: stored.seq }
      this.rows.set(id, row)
      this.seq = Math.max(this.seq, stored.seq)
    }
    for (const part of Object.keys(row.parts)) {
      if (part in wanted || part === 'course' || (part === 'text' && content === undefined)) continue
      const baseVersion = this.parts.get(`${id}/${part}`)?.version ?? row.parts[part]
      const stored = await stale(() => deletePart(id, part, baseVersion))
      this.parts.delete(`${id}/${part}`)
      const { [part]: _gone, ...rest } = row.parts
      row = { ...row, parts: rest, seq: stored.seq }
      this.rows.set(id, row)
    }
    if (!sameFields(row, fields)) await this.writeFields(id, row, fields)
  }

  private async writeFolder(folder: FolderMeta): Promise<void> {
    const id = folder.id
    const fields = folderFields(folder)
    const seen = this.rows.get(id)
    let row: LibraryRow = !seen || seen.removedAt ? await this.createRow(id, fields, seen?.rev ?? 0) : seen
    const course = folder.courseDescription !== null || folder.courseMaterial !== null ? JSON.stringify({ courseDescription: folder.courseDescription, courseMaterial: folder.courseMaterial }) : null
    const base = this.parts.get(`${id}/course`)
    if (course !== null && !(row.parts.course && base?.version === row.parts.course && base.content === course)) {
      const baseVersion = base?.version ?? row.parts.course ?? null
      const stored = await stale(() => putPart(id, 'course', course, baseVersion))
      this.parts.set(`${id}/course`, { version: stored.version, content: course })
      row = { ...row, parts: { ...row.parts, course: stored.version }, seq: stored.seq }
      this.rows.set(id, row)
    }
    if (!sameFields(row, fields)) await this.writeFields(id, row, fields)
  }

  private async createRow(id: string, fields: LibraryRowFields, baseRev: number): Promise<LibraryRow> {
    const saved = await stale(() => putItem(id, baseRev, fields))
    const row: LibraryRow = { ...fields, id, parts: {}, media: null, noteBytes: 0, mediaBytes: 0, removedAt: null, rev: saved.rev, seq: saved.seq }
    this.rows.set(id, row)
    this.seq = Math.max(this.seq, saved.seq)
    return row
  }

  private async writeFields(id: string, row: LibraryRow, fields: LibraryRowFields): Promise<void> {
    const saved = await stale(() => putItem(id, row.rev, fields))
    this.rows.set(id, { ...row, ...fields, rev: saved.rev, seq: saved.seq })
    this.seq = Math.max(this.seq, saved.seq)
  }

  /** Brings the current note, joins it with this device's from the common base, and takes the current one as the new base. */
  private async mergeFile(mine: FileSidecar, mineText: string | undefined): Promise<{ sidecar: FileSidecar; content: string | undefined }> {
    const id = mine.meta.id
    const baseRow = this.rows.get(id)
    const theirsRow = await getItem(id)
    const baseParts: Parts = {}
    if (baseRow) {
      for (const [part, version] of Object.entries(baseRow.parts)) {
        const content = await this.partAt(id, part, version)
        if (content !== undefined) baseParts[part] = content
      }
    }
    const theirsParts: Parts = {}
    for (const [part, version] of Object.entries(theirsRow.parts)) {
      const content = await this.partAt(id, part, version)
      if (content !== undefined) theirsParts[part] = content
    }
    const theirs = sidecarOf(theirsRow, theirsParts)
    const base = baseRow ? sidecarOf(baseRow, baseParts) : theirs

    let content = mineText
    if (mineText !== undefined) {
      const baseText = baseParts.text ?? ''
      const theirsText = theirsParts.text ?? ''
      if (theirsText !== baseText && theirsText !== mineText) content = await this.mergedText(mine, baseText, mineText, theirsText, theirs)
    }

    const { merged, conflicts } = mergeSidecar(base, mine, theirs)
    let sidecar = merged
    if (conflicts.length && this.resolver) {
      const resolved: Conflict = await this.resolver({
        kind: 'json',
        fileId: id,
        fileName: mine.meta.name,
        fields: conflicts,
        mineStamp: { at: mine.meta.updated.at, deviceName: mine.meta.updated.deviceName },
        theirsStamp: { at: theirs.meta.updated.at, deviceName: theirs.meta.updated.deviceName },
      })
      if (resolved.kind === 'json') sidecar = applyFieldChoices(merged, conflicts, Object.fromEntries(resolved.fields.map(field => [field.path, field.choice ?? 'mine'])) as Record<string, 'mine' | 'theirs'>)
    }

    // the current one is the base from now on
    this.rows.set(id, theirsRow)
    for (const key of [...this.parts.keys()]) if (key.startsWith(`${id}/`) && !(key.slice(id.length + 1) in theirsRow.parts)) this.parts.delete(key)
    for (const [part, value] of Object.entries(theirsParts)) this.parts.set(`${id}/${part}`, { version: theirsRow.parts[part], content: value })
    return { sidecar, content }
  }

  private async mergedText(mine: FileSidecar, base: string, mineText: string, theirsText: string, theirs: FileSidecar): Promise<string> {
    const hunks = mergeText(base, mineText, theirsText)
    if (!hasTextConflict(hunks)) return joinHunks(hunks)
    if (!this.resolver) return mineText
    const resolved = await this.resolver({
      kind: 'text',
      fileId: mine.meta.id,
      fileName: mine.meta.name,
      base,
      mine: mineText,
      theirs: theirsText,
      mineStamp: { at: mine.meta.updated.at, deviceName: mine.meta.updated.deviceName },
      theirsStamp: { at: theirs.meta.updated.at, deviceName: theirs.meta.updated.deviceName },
    })
    return resolved.kind === 'text' ? (resolved.resolved ?? mineText) : mineText
  }

  /** A folder has no conflict screen: per field, the side that changed it since the base wins (mergeFolder, as in the Drive). */
  private async mergeFolderWithServer(mine: FolderMeta): Promise<FolderMeta> {
    const id = mine.id
    const baseRow = this.rows.get(id)
    const theirsRow = await getItem(id)
    const theirs = folderOf(theirsRow, await this.partAt(id, 'course', theirsRow.parts.course))
    const base = baseRow ? folderOf(baseRow, await this.partAt(id, 'course', baseRow.parts.course)) : theirs
    this.rows.set(id, theirsRow)
    const course = await this.partAt(id, 'course', theirsRow.parts.course)
    if (course !== undefined) this.parts.set(`${id}/course`, { version: theirsRow.parts.course, content: course })
    return mergeFolder(base, mine, theirs)
  }

  private async removeItem(id: string): Promise<void> {
    const row = this.rows.get(id)
    if (!row || row.removedAt) return
    const done = await deleteItem(id, row.rev)
    this.rows.set(id, { ...row, removedAt: new Date().toISOString(), parts: {}, seq: done.seq })
    for (const key of [...this.parts.keys()]) if (key.startsWith(`${id}/`)) this.parts.delete(key)
  }

  private mediaOf(ref: string): [string, string] {
    const [item, media] = ref.replace(/^app:/, '').split('/')
    return [item, media]
  }
}
