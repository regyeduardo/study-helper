// Migração de entradas: the notes made before entradas existed get theirs, once, with a copy of everything saved first.
import type { FileMeta, FileSidecar, Snapshot, SourceMeta } from '@/types/domain'
import { newFileMeta, newSidecar } from '@/lib/defaults'
import { stamp } from '@/lib/device'
import { isNote } from '@/lib/family'
import { mediaOf } from '@/lib/file-types'
import { nowIso } from '@/lib/ids'
import type { Repository } from '@/lib/storage/repository'
import { transcriptText } from '@/lib/transcription/export'

/** The id the copy of the metadata is saved under (the repository keeps it with the stored sources). */
export const BACKUP_ID = 'copia-antes-das-entradas'

const REAL_SOURCES = new Set<SourceMeta['input']>(['file', 'url', 'youtube', 'text', 'topic', 'recording'])

/** FNV-1a twice, with two seeds: the same source gets the same id on every device. */
function hashOf(text: string): string {
  const one = (seed: number) => {
    let hash = seed
    for (let index = 0; index < text.length; index++) hash = Math.imul(hash ^ text.charCodeAt(index), 0x01000193)
    return (hash >>> 0).toString(36)
  }
  return `${one(0x811c9dc5)}${one(0x01000193)}`
}

/** What says two origins are the same source: the link; else the file by name and size (or where it is stored); the topic; the pasted text by size. */
export function sourceKey(origin: SourceMeta): string {
  if (origin.url && (origin.input === 'url' || origin.input === 'youtube')) return `link:${origin.url}`
  if (origin.input === 'topic') return `tema:${origin.name}`
  if (origin.input === 'text') return `texto:${origin.name}:${origin.sizeBytes ?? ''}`
  if (origin.sizeBytes === undefined && (origin.storedFileId || origin.storedUrl)) return `guardado:${origin.storedFileId ?? origin.storedUrl}`
  return `arquivo:${origin.name}:${origin.sizeBytes ?? ''}`
}

export function entryIdOf(origin: SourceMeta): string {
  return `entrada-${hashOf(sourceKey(origin))}`
}

/** The file is kept somewhere: stored (Drive or a host) and not deleted, or, for media, in this browser. */
export function keptOf(origin: SourceMeta, inBrowser = false): 'registro' | 'arquivo' {
  return !origin.removedAt && (inBrowser || Boolean(origin.storedFileId || origin.storedUrl)) ? 'arquivo' : 'registro'
}

/** A source the person brought: a pasted text has its size; other "text" origins name the note it came from. */
function realSource(origin: SourceMeta | null): origin is SourceMeta {
  return Boolean(origin && REAL_SOURCES.has(origin.input) && (origin.input !== 'text' || origin.mime === 'text/plain'))
}

type Spoken = Pick<FileSidecar, 'transcript' | 'recording'>

interface MediaNotes {
  /** Notes whose own content IS the recording: each becomes the entrada itself, keeping its id. */
  holders: Set<string>
  /** The transcription of a note written from media (Aula, Explicação, Leitura…): it stays a note, and its new entrada gets a copy. */
  spoken: Map<string, Spoken>
}

/**
 * A note is the recording itself when its source is a recording (old meeting notes keep their Ata inside) or when its text is
 * its transcription (or it has no text of its own). A note the person reads as written text made from a media stays a note.
 */
async function mediaNotesOf(repo: Repository, files: FileMeta[]): Promise<MediaNotes> {
  const holders = new Set<string>()
  const spoken = new Map<string, Spoken>()
  for (const file of files.filter(item => isNote(item) && !item.deletedAt && !item.parentFileId && realSource(item.origin) && mediaOf(item) !== 'text')) {
    if (file.origin!.input === 'recording') {
      holders.add(file.id)
      continue
    }
    const [content, sidecar] = await Promise.all([repo.readContent(file.id), repo.readSidecar(file.id)])
    const text = content.trim()
    const transcription = [sidecar.transcript, sidecar.recording?.blocks.length ? transcriptText(sidecar.recording) : undefined].map(item => item?.trim()).filter(Boolean)
    if (!text || transcription.includes(text)) holders.add(file.id)
    else if (sidecar.transcript !== undefined || sidecar.recording) spoken.set(file.id, { ...(sidecar.transcript !== undefined ? { transcript: sidecar.transcript } : {}), ...(sidecar.recording ? { recording: sidecar.recording } : {}) })
  }
  return { holders, spoken }
}

interface Plan {
  create: { meta: FileMeta; spoken?: Spoken }[]
  patches: { id: string; patch: Partial<FileMeta> }[]
}

function planOf(files: FileMeta[], inBrowser: Set<string>, { holders, spoken }: MediaNotes): Plan {
  const create = new Map<string, Plan['create'][number]>()
  const patches: Plan['patches'] = []
  const candidates = files
    .filter(file => isNote(file) && !file.deletedAt && !file.parentFileId && realSource(file.origin))
    .sort((a, b) => a.created.at.localeCompare(b.created.at) || a.id.localeCompare(b.id))
  // the recordings first: a note written from the same media goes under the recording that became the entrada
  const live = [...files.filter(file => file.role === 'entrada' && !file.deletedAt), ...candidates.filter(file => holders.has(file.id))]
  for (const file of candidates.filter(item => holders.has(item.id))) patches.push({ id: file.id, patch: { role: 'entrada', kept: keptOf(file.origin!, inBrowser.has(file.id)) } })
  for (const file of candidates.filter(item => !holders.has(item.id))) {
    const origin = file.origin!
    const id = entryIdOf(origin)
    const key = sourceKey(origin)
    const existing = files.find(item => item.id === id) ?? live.find(item => item.origin && sourceKey(item.origin) === key) ?? create.get(id)?.meta
    if (!existing)
      create.set(id, {
        meta: newFileMeta({ id, name: origin.name, role: 'entrada', kept: keptOf(origin), type: 'reading', folderId: file.folderId, origin: { ...origin }, status: 'ready', created: file.created, updated: file.created }),
        spoken: spoken.get(file.id),
      })
    patches.push({ id: file.id, patch: { parentFileId: existing?.id ?? id } })
  }
  return { create: [...create.values()], patches }
}

/**
 * Runs once per library (`entriesMigratedAt`). Additive: it only creates entradas and sets `role`, `kept` and `parentFileId`;
 * no `origin` is deleted. A failure in the middle loses nothing: running again finds the same entradas by their ids.
 * `localMedia`: ids of the notes whose media is kept in this browser.
 */
export async function migrateEntries(repo: Repository, snapshot: Snapshot, options: { localMedia?: string[] } = {}): Promise<Snapshot> {
  if (snapshot.index.entriesMigratedAt) return snapshot
  const inBrowser = new Set(options.localMedia ?? [])
  const plan = planOf(snapshot.files, inBrowser, await mediaNotesOf(repo, snapshot.files))
  if (plan.create.length || plan.patches.length) {
    const copy = new Blob([JSON.stringify({ at: nowIso(), folders: snapshot.folders, files: snapshot.files, index: snapshot.index }, null, 2)], { type: 'application/json' })
    await repo.putSource(BACKUP_ID, copy, `metadados-antes-das-entradas-${nowIso().replace(/[:.]/g, '-')}.json`)
  }
  const files = new Map(snapshot.files.map(file => [file.id, file]))
  for (const { meta, spoken } of plan.create) {
    // the transcription is part of the media: the entrada gets a copy; the note keeps its own
    const text = spoken?.transcript ?? (spoken?.recording?.blocks.length ? transcriptText(spoken.recording) : '')
    await repo.saveFile({ ...newSidecar(meta), ...spoken }, text)
    files.set(meta.id, meta)
  }
  for (const { id, patch } of plan.patches) {
    const sidecar = await repo.readSidecar(id)
    // not stamped as edited: the migration is not the person changing the note
    const saved = await repo.saveFile({ ...sidecar, meta: { ...sidecar.meta, ...patch } })
    files.set(id, saved.meta)
  }
  const index = { ...snapshot.index, entriesMigratedAt: nowIso(), updated: stamp() }
  await repo.saveIndex(index)
  return { ...snapshot, files: [...files.values()], index }
}
