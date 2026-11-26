import { create } from 'zustand'

import type {
  Activity,
  Artifact,
  Attempt,
  FileMeta,
  FileSidecar,
  FileType,
  FolderMeta,
  Highlight,
  LibraryIndex,
  Settings,
  SharedItem,
  SharedLink,
  ShareRecord,
  Snapshot,
  StoredQuestion,
} from '@/types/domain'
import type { TokenProvider } from '@/controllers/drive.controller'
import { blocking, blockingFailure } from '@/lib/blocking'
import { legacyAiOf, normalizeSettings, targetFor } from '@/lib/ai/config'
import { missingSetup } from '@/lib/ai/providers'
import { artifactsOf, hasOldFields, migrated, removeArtifact, renameArtifact, withArtifact, withoutOldFields } from '@/lib/artifacts'
import { defaultIndex, newFileMeta, newFolderMeta, newSidecar } from '@/lib/defaults'
import { currentDevice, stamp } from '@/lib/device'
import { migrateEntries } from '@/lib/entry-migration'
import { descendantsOf } from '@/lib/family'
import { masteryOf } from '@/lib/exam'
import { folderNamed, folderTaken, freeName, moveConflict, nameKey, type NameRule, noteNamed, noteTaken, placeOf } from '@/lib/names'
import { isSourceNote, mediaOf } from '@/lib/file-types'
import { nameArtifact, nameSource } from '@/lib/generation/artifact-name'
import { GenerationSession } from '@/lib/generation/session'
import { activeLinks, saveSharedAttempt, type SharedAttempts, sharedLibrary } from '@/lib/share'
import { setSharedRoot } from '@/lib/paths'
import { medirAcoes, type OpOf } from '@/lib/perf-actions'
import { apiMessage, type ServerMe } from '@/controllers/api.controller'
import { followAppAi } from '@/lib/ai/app-ai'
import { env } from '@/lib/env'
import { newId, nowIso } from '@/lib/ids'
import { type LocalMedia, listLocalMedia, removeLocalMedia, watchLocalMedia } from '@/lib/recording/media-library'
import { openLive } from '@/lib/storage/app-live'
import { AppRepository } from '@/lib/storage/app-repository'
import { CombinedRepository } from '@/lib/storage/combined-repository'
import { migrateHierarchy } from '@/lib/storage/hierarchy-migration'
import { HierarchyRepository } from '@/lib/storage/hierarchy-repository'
import { openDriveLibrary } from '@/lib/storage/hidden-migration'
import { LocalRepository } from '@/lib/storage/local-repository'
import { MoveJournal, showingOf } from '@/lib/storage/moves'
import type { Repository, StoredSize } from '@/lib/storage/repository'
import { removeStoredSource } from '@/lib/storage/source-storage'
import { useAccountStore } from '@/stores/account'
import type { TrackedTask } from '@/stores/jobs'
import { useServerAccount } from '@/stores/server-account'
import { readingMinutes, wordCount } from '@/utils/format'

export const TRASH_DAYS = 30
const ACTIVITIES_KEPT = 300

export const READ_ONLY_MESSAGE = 'Compartilhado: só leitura. Importe para a sua biblioteca para mexer.'

export interface SharedViewState {
  item: SharedItem
  rootId: string | null
}

type OwnLibrary = Pick<LibraryState, 'folders' | 'files' | 'opened' | 'openedAt' | 'sizes' | 'localMedia'>

export interface OpenedFile {
  content: string
  sidecar: FileSidecar
}

interface LibraryState {
  repo: Repository | null
  accountId: string | null
  ready: boolean
  loadError: string | null
  hiddenPending: boolean
  hiddenWarning: string | null
  /** The App is one of the places (spec 003, entrega 4): the account was freed by a code and "Usar a estrutura do app" is on. */
  appOn: boolean
  /** The account's hierarchy: changes still waiting and whether the account answers (spec 005, FR-011); null without it. */
  hierarchySync: { pending: number; online: boolean } | null
  /** Turns the App place on or off in the library of a Google account, and loads the library again. */
  attachApp(on: boolean): Promise<void>
  folders: FolderMeta[]
  files: FileMeta[]
  index: LibraryIndex
  opened: Record<string, OpenedFile>
  openedAt: Record<string, number>
  sizes: Record<string, StoredSize>
  localMedia: LocalMedia[]
  sharedView: SharedViewState | null
  enterShared(item: SharedItem, attempts: SharedAttempts): void
  leaveShared(): void
  connect(accountId: string, tokenProvider?: TokenProvider): Promise<void>
  /** The library of a job page on the server (spec 007, R10b): only the account's App and hierarchy, no Google Drive nor Local. */
  connectWorker(accountId: string): Promise<void>
  applySnapshot(snapshot: Snapshot, changedFileIds?: string[]): void
  openFile(id: string): Promise<OpenedFile>
  /** `rule` (FR-021): a name already there gets " (2)" (the app's own notes), or the person's act is refused saying which ('block'). */
  createFile(fields: Partial<FileMeta> & { name: string; type: FileType }, content: string, rule?: Exclude<NameRule, 'reuse'>): Promise<FileMeta>
  saveContent(id: string, content: string, patch?: Partial<FileMeta>): Promise<void>
  updateFile(id: string, patch: Partial<FileMeta>, rule?: Exclude<NameRule, 'reuse'>): Promise<void>
  /** The same change for many files: the list shows it for all at once; the writes follow one by one. */
  updateFiles(ids: string[], patch: Partial<FileMeta>, rule?: Exclude<NameRule, 'reuse'>): Promise<void>
  updateSidecar(id: string, change: (sidecar: FileSidecar) => FileSidecar): Promise<FileSidecar>
  /** The person's move: refused, with nothing moved, when one of them would repeat a name in the folder (FR-021). */
  moveFiles(ids: string[], folderId: string | null): Promise<void>
  hasMedia(id: string): boolean
  trashFiles(ids: string[], options?: { media?: boolean }): Promise<void>
  /** "Apagar tudo": the item and its live descendants go to the Lixeira marked with its id, to come back together. */
  trashFamily(id: string): Promise<void>
  /** "Apagar só esta": its children pass to its mother (none: they become roots), but an Ata stays with its entrada; only the item goes to the Lixeira. */
  trashOnly(id: string, options?: { media?: boolean }): Promise<void>
  /** "Apagar só a mídia": the media leaves; the entrada stays, marked as media deleted, with the transcription and the notes. */
  removeMedia(id: string): Promise<void>
  /** An item of an "Apagar tudo" brings back all with the same mark; each to the root when its folder is gone. */
  restoreFile(id: string): Promise<void>
  deleteFileForever(id: string): Promise<void>
  /** `rule` (FR-021): the app's folder by name is the one already there ('reuse'); 'number' gives " (2)"; 'block' refuses saying which. */
  createFolder(fields: Partial<FolderMeta> & { name: string }, rule?: NameRule): Promise<FolderMeta>
  /** The folders of who is looking, even while a shared link is open (the importer's folder picker). */
  ownFolders(): FolderMeta[]
  /** The notes of who is looking, even while a shared link is open (what an import would repeat, FR-021). */
  ownFiles(): FileMeta[]
  /** A folder in one's own library, even while a shared link is open: the link stays read only. */
  createOwnFolder(fields: Partial<FolderMeta> & { name: string }, rule?: NameRule): Promise<FolderMeta>
  updateFolder(id: string, patch: Partial<FolderMeta>, rule?: Exclude<NameRule, 'reuse'>): Promise<void>
  trashFolder(id: string): Promise<void>
  restoreFolder(id: string): Promise<void>
  deleteFolderForever(id: string): Promise<void>
  emptyTrash(): Promise<void>
  purgeExpiredTrash(): Promise<number>
  updateSettings(patch: Partial<Settings>): Promise<void>
  startActivity(fields: Omit<Activity, 'id' | 'status' | 'detail' | 'createdAt' | 'finishedAt' | 'deviceId'>): Promise<string>
  finishActivity(id: string, status: Activity['status'], detail: string): Promise<void>
  setQuestions(id: string, questions: StoredQuestion[], append?: boolean): Promise<void>
  recordAttempt(id: string, attempt: Omit<Attempt, 'id' | 'createdAt' | 'deviceId'>): Promise<void>
  saveHighlight(id: string, highlight: Highlight): Promise<void>
  removeHighlight(id: string, highlightId: string): Promise<void>
  /** Adds the artifact, or updates the one with its id; `replaceId`: "Substituir este" (takes that one's place and id). */
  saveArtifact(fileId: string, artifact: Artifact, replaceId?: string): Promise<Artifact>
  renameArtifact(fileId: string, id: string, name: string): Promise<void>
  deleteArtifact(fileId: string, id: string): Promise<void>
  markOpened(id: string): void
  forgetCurrent(): Promise<void>
  saveShare(share: ShareRecord): Promise<void>
  dropShare(id: string): Promise<void>
  rememberSharedLink(link: SharedLink): Promise<void>
  pruneSharedLinks(): Promise<void>
}

function statsOf(content: string): Pick<FileMeta, 'words' | 'readingMinutes'> {
  return { words: wordCount(content), readingMinutes: readingMinutes(content) }
}

function descendantFolderIds(folders: FolderMeta[], id: string): string[] {
  const children = folders.filter(folder => folder.parentId === id)
  return [id, ...children.flatMap(child => descendantFolderIds(folders, child.id))]
}

function expired(deletedAt: string | null): boolean {
  return Boolean(deletedAt) && Date.now() - Date.parse(deletedAt!) > TRASH_DAYS * 24 * 3600 * 1000
}

const OPENED_KEY = 'study-helper:opened'

function readOpened(accountId: string): Record<string, number> {
  try {
    return JSON.parse(localStorage.getItem(`${OPENED_KEY}:${accountId}`) ?? '{}') as Record<string, number>
  } catch {
    return {}
  }
}


export const useLibraryStore = create<LibraryState>((set, get) => {
  let own: OwnLibrary | null = null

  const repository = (): Repository => {
    if (get().sharedView) throw new Error(READ_ONLY_MESSAGE)
    const repo = get().repo
    if (!repo) throw new Error('A biblioteca ainda não abriu.')
    return repo
  }

  const replaceFile = (meta: FileMeta) => set(state => ({ files: state.files.some(file => file.id === meta.id) ? state.files.map(file => (file.id === meta.id ? meta : file)) : [...state.files, meta] }))

  const replaceFolder = (folder: FolderMeta) =>
    set(state => ({ folders: state.folders.some(item => item.id === folder.id) ? state.folders.map(item => (item.id === folder.id ? folder : item)) : [...state.folders, folder] }))

  /** What a click changes shows at once; the write follows. Returns the way back, for when the write fails (only what is still as shown is put back). */
  const showNow = <T extends FileMeta | FolderMeta>(kind: 'files' | 'folders', ids: string[], patch: Partial<T>): (() => void) => {
    const keys = Object.keys(patch) as (keyof T)[]
    const before = new Map<string, Partial<T>>()
    set(state => ({
      [kind]: (state[kind] as T[]).map(item => {
        if (!ids.includes(item.id)) return item
        before.set(item.id, Object.fromEntries(keys.map(key => [key, item[key]])) as Partial<T>)
        return { ...item, ...patch }
      }),
    }))
    return () =>
      set(state => ({
        [kind]: (state[kind] as T[]).map(item => {
          const old = before.get(item.id)
          if (!old) return item
          const still = keys.filter(key => item[key] === patch[key])
          return still.length ? { ...item, ...Object.fromEntries(still.map(key => [key, old[key]])) } : item
        }),
      }))
  }

  /** Many changes: all of them show now, the writes follow one by one, and the ones not written go back if a write fails. */
  const changeMany = async (changes: [string, Partial<FileMeta>][], write: (id: string, patch: Partial<FileMeta>) => Promise<void>) => {
    // a library that is closed or read only refuses before anything is shown
    repository()
    const undo = new Map(changes.map(([id, patch]) => [id, showNow<FileMeta>('files', [id], patch)]))
    try {
      for (const [id, patch] of changes) {
        await write(id, patch)
        undo.delete(id)
      }
    } catch (error) {
      for (const back of undo.values()) back()
      throw error
    }
  }

  /**
   * FR-021: a note that changes name or folder, or comes back from the Lixeira, does not repeat a name there: 'number' gives the free
   * name, 'block' refuses saying which. `files`: the library as it will be, when many change together.
   */
  const freeNote = (files: FileMeta[], id: string, patch: Partial<FileMeta>, rule: Exclude<NameRule, 'reuse'>): Partial<FileMeta> => {
    const meta = files.find(file => file.id === id)
    if (!meta || !('name' in patch || 'folderId' in patch || 'deletedAt' in patch)) return patch
    const next = { ...meta, ...patch }
    const folderId = next.folderId ?? null
    const changed = folderId !== (meta.folderId ?? null) || nameKey(next.name) !== nameKey(meta.name) || Boolean(meta.deletedAt)
    if (next.deletedAt || !changed) return patch
    const taken = (name: string) => Boolean(noteNamed(files, folderId, name, id))
    const there = noteNamed(files, folderId, next.name, id)
    if (!there) return patch
    if (rule === 'block') throw noteTaken(there.name, placeOf(get().folders, folderId))
    return { ...patch, name: freeName(next.name, taken) }
  }

  /** The same for many: each one sees the names the ones before it took. */
  const freeNotes = (changes: [string, Partial<FileMeta>][], rule: Exclude<NameRule, 'reuse'>): [string, Partial<FileMeta>][] => {
    let files = get().files
    return changes.map(([id, patch]) => {
      const named = freeNote(files, id, patch, rule)
      files = files.map(file => (file.id === id ? { ...file, ...named } : file))
      return [id, named]
    })
  }

  /** FR-021 for a folder that changes name or place, or comes back from the Lixeira. */
  const freeFolder = (id: string, patch: Partial<FolderMeta>, rule: Exclude<NameRule, 'reuse'>): Partial<FolderMeta> => {
    const folders = get().folders
    const folder = folders.find(item => item.id === id)
    if (!folder || !('name' in patch || 'parentId' in patch || 'deletedAt' in patch)) return patch
    const next = { ...folder, ...patch }
    const parentId = next.parentId ?? null
    const changed = parentId !== (folder.parentId ?? null) || nameKey(next.name) !== nameKey(folder.name) || Boolean(folder.deletedAt)
    if (next.deletedAt || !changed) return patch
    const there = folderNamed(folders, parentId, next.name, id)
    if (!there) return patch
    if (rule === 'block') throw folderTaken(there.name, placeOf(folders, parentId))
    return { ...patch, name: freeName(next.name, name => Boolean(folderNamed(folders, parentId, name, id))) }
  }

  /** A folder by name, by the rule: the one already there (`reused`), or a new one to save; `folders`: where it is born (the importer's own library under a shared link). */
  const folderByRule = (folders: FolderMeta[], fields: Partial<FolderMeta> & { name: string }, rule: NameRule): { folder: FolderMeta; reused: boolean } => {
    const parentId = fields.parentId ?? null
    const there = folderNamed(folders, parentId, fields.name)
    if (there && rule === 'reuse') return { folder: there, reused: true }
    if (there && rule === 'block') throw folderTaken(there.name, placeOf(folders, parentId))
    return { folder: newFolderMeta({ ...fields, name: there ? freeName(fields.name, name => Boolean(folderNamed(folders, parentId, name))) : fields.name }), reused: false }
  }

  const sidecarOf = async (id: string): Promise<FileSidecar> => get().opened[id]?.sidecar ?? (await repository().readSidecar(id))

  const measure = (repo: Repository, fileIds?: string[]) =>
    void repo.fileSizes(fileIds).then(
      sizes => {
        if (get().repo === repo) set(state => ({ sizes: fileIds ? { ...state.sizes, ...sizes } : sizes }))
      },
      () => undefined,
    )

  const refreshMedia = () => void listLocalMedia().then(localMedia => set({ localMedia }), () => undefined)

  watchLocalMedia(refreshMedia)

  const removeMediaOf = async (id: string) => {
    const local = get().localMedia.find(item => item.fileIds.includes(id))
    if (local) {
      await removeLocalMedia(local.storedName)
      set({ localMedia: await listLocalMedia() })
    }
    const origin = get().files.find(file => file.id === id)?.origin
    if (!origin) return undefined
    return (origin.storedFileId || origin.storedUrl) && !origin.removedAt ? removeStoredSource(origin, repository()) : { ...origin, removedAt: nowIso() }
  }

  const saveSidecarOnly = async (sidecar: FileSidecar): Promise<FileSidecar> => {
    const saved = await repository().saveFile(sidecar)
    measure(repository(), [saved.meta.id])
    replaceFile(saved.meta)
    set(state => (state.opened[saved.meta.id] ? { opened: { ...state.opened, [saved.meta.id]: { ...state.opened[saved.meta.id], sidecar: saved } } } : {}))
    return saved
  }

  /** A change to the sidecar of an opened file (a highlight, a note) shows at once; the write follows, and if it fails the sidecar goes back. */
  const changeSidecarNow = async (id: string, change: (sidecar: FileSidecar) => FileSidecar): Promise<void> => {
    const before = get().opened[id]
    // not in memory yet: nothing to show ahead of the write
    if (!before) return void (await get().updateSidecar(id, change))
    const next = change(before.sidecar)
    set(state => ({ opened: { ...state.opened, [id]: { ...state.opened[id], sidecar: next } } }))
    try {
      await saveSidecarOnly({ ...next, meta: { ...next.meta, updated: stamp() } })
    } catch (error) {
      set(state => (state.opened[id]?.sidecar === next ? { opened: { ...state.opened, [id]: { ...state.opened[id], sidecar: before.sidecar } } } : {}))
      throw error
    }
  }

  // an index that is being written is newer than the one a sync read from the Drive before the write ended: that sync must not put the old one back
  let indexWrites = 0
  const saveIndex = async (index: LibraryIndex) => {
    set({ index })
    const repo = get().repo
    if (!repo) throw new Error('A biblioteca ainda não abriu.')
    indexWrites++
    try {
      await repo.saveIndex(index)
    } finally {
      indexWrites--
    }
  }

  // Artifact writes of a note run one after the other: each reads what the one before saved.
  const artifactTurns = new Map<string, Promise<unknown>>()
  const inTurn = <T>(fileId: string, task: () => Promise<T>): Promise<T> => {
    const run = (artifactTurns.get(fileId) ?? Promise.resolve()).then(task)
    artifactTurns.set(
      fileId,
      run.catch(() => undefined),
    )
    return run
  }

  /** `byUser`: stamps the note as edited; the migration and the AI naming on open do not. */
  const changeArtifacts = (fileId: string, change: (sidecar: FileSidecar) => FileSidecar, byUser = true) =>
    inTurn(fileId, async () => {
      const sidecar = await sidecarOf(fileId)
      const next = change(sidecar)
      if (next === sidecar) return sidecar
      return saveSidecarOnly(byUser ? { ...next, meta: { ...next.meta, updated: stamp() } } : next)
    })

  // The old single map and deck become artifacts: the list is saved with the old fields still there, and only then are they cleared.
  const migrate = (fileId: string) =>
    inTurn(fileId, async () => {
      let sidecar = await sidecarOf(fileId)
      if (!hasOldFields(sidecar)) return
      const first = migrated(sidecar)
      if (first.artifacts!.length !== (sidecar.artifacts?.length ?? -1)) sidecar = await saveSidecarOnly(first)
      const cleared = withoutOldFields(sidecar)
      if (cleared !== sidecar) await saveSidecarOnly(cleared)
    })

  /** The notes made before entradas existed get theirs (once per library, with a copy first); a failure leaves the library as it was. */
  const migrateOnLoad = async (repo: Repository, snapshot: Snapshot) => {
    const localMedia = (await listLocalMedia().catch(() => [] as LocalMedia[])).flatMap(item => item.fileIds)
    const migrated = await migrateEntries(repo, snapshot, { localMedia }).catch(() => null)
    if (!migrated || migrated === snapshot || get().repo !== repo || get().sharedView) return
    const before = new Map(snapshot.files.map(file => [file.id, file]))
    for (const file of migrated.files) if (before.get(file.id) !== file) replaceFile(file)
    set(state => ({ index: { ...state.index, entriesMigratedAt: migrated.index.entriesMigratedAt } }))
  }

  const naming = new Set<string>()
  const nameProvisional = async (fileId: string) => {
    const target = targetFor(get().index.settings, 'titulo')
    if (missingSetup(target) || naming.has(fileId)) return
    const waiting = artifactsOf(await sidecarOf(fileId)).filter(item => item.provisionalName)
    if (!waiting.length) return
    naming.add(fileId)
    try {
      const session = new GenerationSession(target)
      for (const artifact of waiting) {
        const name = await nameArtifact(nameSource(artifact), artifact.kind, artifact.made?.instruction, session).catch(() => null)
        if (!name) continue
        await changeArtifacts(fileId, sidecar => (artifactsOf(sidecar).find(item => item.id === artifact.id)?.provisionalName ? renameArtifact(sidecar, artifact.id, name) : sidecar), false)
      }
    } finally {
      naming.delete(fileId)
    }
  }

  /** On the first open of a note: migrate the old fields, then let the AI name what still has the placeholder. Failures keep things as they were. */
  const tidyArtifacts = async (fileId: string) => {
    await migrate(fileId).catch(() => undefined)
    await nameProvisional(fileId).catch(() => undefined)
  }

  return {
    repo: null,
    accountId: null,
    ready: false,
    loadError: null,
    hiddenPending: false,
    hiddenWarning: null,
    folders: [],
    files: [],
    index: defaultIndex(),
    opened: {},
    openedAt: {},
    sizes: {},
    localMedia: [],
    sharedView: null,

    appOn: false,
    hierarchySync: null,

    attachApp: async on => {
      const repo = get().repo
      const accountId = get().accountId
      if (!(repo instanceof CombinedRepository) || !accountId || on === Boolean(repo.app)) return
      repo.setApp(on ? new AppRepository(accountId) : null)
      set({ appOn: on })
      followLive(repo)
      // the library is read again with the App in or out: the window holds the app until it is (owner's choice F)
      await blocking(on ? 'Abrindo a biblioteca do App' : 'Tirando o App desta biblioteca', async () => {
        try {
          const snapshot = await repo.load()
          if (get().repo === repo) get().applySnapshot(snapshot)
        } catch (error) {
          if (get().repo === repo) set({ loadError: error instanceof Error ? error.message : 'Não consegui abrir o App.' })
        }
      })
    },

    connect: async (accountId, tokenProvider) => {
      followLive(null)
      set({ repo: null, accountId, appOn: false, hierarchySync: null, ready: false, loadError: null, hiddenPending: false, hiddenWarning: null, folders: [], files: [], opened: {}, openedAt: readOpened(accountId), sizes: {} })
      let repo: Repository
      let offlineOpening = false
      try {
        if (!tokenProvider) repo = new LocalRepository()
        else {
          const session = openServerSession(accountId, tokenProvider)
          const { useJobsStore } = await import('@/stores/jobs')
          let task: TrackedTask | null = null
          const library = await openDriveLibrary(accountId, tokenProvider, (message, fraction) => {
            task ??= useJobsStore.getState().trackTask('Mudando para a pasta oculta do Drive')
            task.update(message, fraction)
          })
          if (library.warning) (task as TrackedTask | null)?.fail(library.warning)
          else (task as TrackedTask | null)?.done('Tudo na pasta oculta do Drive')
          // without internet, the last session of the account says what opens (história 6): its hierarchy and the App, from the cache
          if (library.offline) {
            offlineOpening = true
            await session
          }
          if (get().accountId !== accountId) return
          // The account's Drive and this browser's Local in one tree (spec 003, história 9); a move left open shows its origin until checked.
          const combined = new CombinedRepository(library.repo, new LocalRepository(`study-helper-local-${accountId}`, accountId))
          combined.setShowing(showingOf(await new MoveJournal(accountId).all().catch(() => [])))
          combined.onRefused = tellRefused
          if (serverAppOn()) combined.setApp(new AppRepository(accountId))
          if (hierarchyOn(accountId)) combined.setHierarchy(new HierarchyRepository(accountId))
          set({ appOn: Boolean(combined.app) })
          watchHierarchy(combined)
          repo = combined
          set({ hiddenPending: library.hiddenPending, hiddenWarning: library.warning })
        }
      } catch (error) {
        set({ loadError: error instanceof Error ? error.message : 'Não consegui abrir a biblioteca.', ready: true })
        return
      }
      set({ repo })
      // spec 007 (T046): the live channel opens after the first load, with the seq it brought; opened before, its "hello" said 0, the
      // server answered "map" and every opening of the app pulled the whole library again, alongside the load
      let living = false
      const live = () => {
        if (living || !(repo instanceof CombinedRepository) || get().repo !== repo) return
        living = true
        followLive(repo)
      }
      try {
        const snapshot = await repo.load()
        if (get().repo !== repo) return
        get().applySnapshot(snapshot)
        set({ ready: true })
        live()
        if (offlineOpening) void import('@/stores/ui').then(({ useUiStore }) => useUiStore.getState().toast('Sem internet: a biblioteca abriu com o que está neste aparelho. O que está no Google Drive abre quando a conexão voltar.'))
        await migrateOnLoad(repo, snapshot)
        migrateHierarchyWhenReady()
        warnLostFolders(repo)
        await get().purgeExpiredTrash()
        // a change of place stopped in the middle (a closed tab) continues from where it stopped (FR-054)
        if (repo instanceof CombinedRepository) void import('@/stores/places').then(({ usePlacesStore }) => usePlacesStore.getState().resume()).catch(() => undefined)
      } catch (error) {
        if (get().repo === repo) set({ loadError: error instanceof Error ? error.message : 'Não consegui abrir a biblioteca.', ready: true })
        // the load failed: the channel (or its polling every 15 s) still brings the library when the server answers
        live()
      }
    },

    connectWorker: async accountId => {
      followLive(null)
      set({ repo: null, accountId, appOn: false, hierarchySync: null, ready: false, loadError: null, folders: [], files: [], opened: {}, openedAt: {}, sizes: {} })
      // the job page has no Drive nor Local of its own: empty stores in its own profile stand in for them, and every note it touches is in the App
      const combined = new CombinedRepository(new LocalRepository(`study-helper-worker-drive-${accountId}`, accountId), new LocalRepository(`study-helper-worker-local-${accountId}`, accountId))
      combined.setApp(new AppRepository(accountId))
      combined.setHierarchy(new HierarchyRepository(accountId))
      set({ repo: combined, appOn: true })
      followAppAi(true)
      try {
        const snapshot = await combined.load()
        get().applySnapshot(snapshot)
        set({ ready: true })
      } catch (error) {
        set({ loadError: error instanceof Error ? error.message : 'Não consegui abrir a biblioteca.', ready: true })
        throw error
      }
    },

    enterShared: (item, attempts) => {
      const state = get()
      if (!state.sharedView) own = { folders: state.folders, files: state.files, opened: state.opened, openedAt: state.openedAt, sizes: state.sizes, localMedia: state.localMedia }
      const shared = sharedLibrary(item, attempts)
      setSharedRoot(item.id)
      set({ sharedView: { item, rootId: item.folders.find(folder => folder.parentId === null)?.id ?? null }, ...shared, openedAt: {}, localMedia: [] })
    },

    leaveShared: () => {
      setSharedRoot(null)
      if (own) set({ ...own, sharedView: null })
      own = null
    },

    applySnapshot: (snapshot, changedFileIds = []) => {
      if (get().sharedView && own) {
        own = { ...own, folders: snapshot.folders, files: snapshot.files, opened: {} }
        if (!indexWrites) set({ index: { ...defaultIndex(), ...snapshot.index, settings: normalizeSettings({ ...defaultIndex().settings, ...snapshot.index.settings }) } })
        return
      }
      set(state => {
        const opened = { ...state.opened }
        for (const id of changedFileIds) delete opened[id]
        return { folders: snapshot.folders, files: snapshot.files, ...(indexWrites ? {} : { index: { ...defaultIndex(), ...snapshot.index, settings: normalizeSettings({ ...defaultIndex().settings, ...snapshot.index.settings }) } }), opened }
      })
      const repo = get().repo
      if (repo) measure(repo)
      refreshMedia()
    },

    openFile: async id => {
      const cached = get().opened[id]
      if (cached) return cached
      // the sidecar first: in the App, the text comes in the same request as the other parts (spec 007, R4)
      const sidecarRead = repository().readSidecar(id)
      const [content, sidecar] = await Promise.all([repository().readContent(id), sidecarRead])
      const opened = { content, sidecar }
      set(state => ({ opened: { ...state.opened, [id]: opened } }))
      if (hasOldFields(sidecar) || artifactsOf(sidecar).some(item => item.provisionalName)) void tidyArtifacts(id)
      return opened
    },

    createFile: async (fields, content, rule = 'number') => {
      const folderId = fields.folderId ?? null
      const there = noteNamed(get().files, folderId, fields.name)
      if (there && rule === 'block') throw noteTaken(there.name, placeOf(get().folders, folderId))
      const name = there ? freeName(fields.name, taken => Boolean(noteNamed(get().files, folderId, taken))) : fields.name
      const meta = newFileMeta({ ...fields, name, ...statsOf(content) })
      const sidecar = newSidecar(meta)
      await repository().saveFile(sidecar, content)
      measure(repository(), [meta.id])
      replaceFile(meta)
      set(state => ({ opened: { ...state.opened, [meta.id]: { content, sidecar } } }))
      return meta
    },

    saveContent: async (id, content, patch = {}) => {
      const sidecar = await sidecarOf(id)
      const named = freeNote(get().files, id, patch, 'number')
      const next: FileSidecar = { ...sidecar, meta: { ...sidecar.meta, ...named, ...statsOf(content), updated: stamp() } }
      const saved = await repository().saveFile(next, content)
      measure(repository(), [id])
      const merged = await repository().readContent(id).catch(() => content)
      replaceFile(saved.meta)
      set(state => ({ opened: { ...state.opened, [id]: { content: merged, sidecar: saved } } }))
    },

    updateFile: async (id, patch, rule = 'number') => {
      // a library that is closed or read only refuses before anything is shown
      repository()
      const named = freeNote(get().files, id, patch, rule)
      // the list shows the change now; if the write fails it goes back
      const undo = showNow<FileMeta>('files', [id], named)
      try {
        const sidecar = await sidecarOf(id)
        await saveSidecarOnly({ ...sidecar, meta: { ...sidecar.meta, ...named, updated: stamp() } })
      } catch (error) {
        undo()
        throw error
      }
    },

    updateFiles: (ids, patch, rule = 'number') =>
      changeMany(
        freeNotes(
          ids.map(id => [id, patch]),
          rule,
        ),
        (id, change) => get().updateFile(id, change, rule),
      ),

    updateSidecar: async (id, change) => {
      const sidecar = await sidecarOf(id)
      const next = change(sidecar)
      return saveSidecarOnly({ ...next, meta: { ...next.meta, updated: stamp() } })
    },

    moveFiles: async (ids, folderId) => {
      const conflict = moveConflict(get().files, get().folders, ids, [], folderId)
      if (conflict) throw conflict
      await get().updateFiles(ids, { folderId }, 'block')
    },

    hasMedia: id => {
      const meta = get().files.find(file => file.id === id)
      const origin = meta?.origin
      return Boolean(meta && mediaOf(meta) !== 'text' && (get().localMedia.some(item => item.fileIds.includes(id)) || (origin && (origin.storedFileId || origin.storedUrl) && !origin.removedAt)))
    },

    trashFiles: async (ids, options) => {
      const at = nowIso()
      await changeMany(
        ids.map(id => [id, { deletedAt: at }]),
        async id => {
          const origin = options?.media && get().hasMedia(id) ? await removeMediaOf(id) : undefined
          await get().updateFile(id, { deletedAt: at, ...(origin && { origin }) })
        },
      )
    },

    trashFamily: async id => {
      const root = get().files.find(file => file.id === id)
      if (!root) return
      const at = nowIso()
      const family = [root, ...descendantsOf(get().files, id)].map(file => file.id)
      await get().updateFiles(family, { deletedAt: at, trashedWith: id })
    },

    trashOnly: async (id, options) => {
      const meta = get().files.find(file => file.id === id)
      if (!meta) return
      // an Ata never loses the media note it came from (FR-055): at most, its mother is in the Lixeira
      const keeps = (child: FileMeta) => isSourceNote(meta) && child.type === 'meeting'
      for (const child of get().files.filter(file => file.parentFileId === id && !keeps(file))) await get().updateFile(child.id, { parentFileId: meta.parentFileId ?? null })
      await get().trashFiles([id], options)
    },

    removeMedia: async id => {
      if (!get().hasMedia(id)) return
      const origin = await removeMediaOf(id)
      if (origin) await get().updateFile(id, { origin })
    },

    restoreFile: async id => {
      const meta = get().files.find(file => file.id === id)
      if (!meta) return
      const mark = meta.trashedWith
      const family = mark ? get().files.filter(file => file.trashedWith === mark && file.deletedAt) : [meta]
      const back = family.map((file): [string, Partial<FileMeta>] => {
        const folder = get().folders.find(item => item.id === file.folderId)
        return [file.id, { deletedAt: null, folderId: folder && !folder.deletedAt ? file.folderId : null, ...(mark ? { trashedWith: undefined } : {}) }]
      })
      // where the name is taken by now, it comes back with " (2)" (FR-021)
      await changeMany(freeNotes(back, 'number'), (id, patch) => get().updateFile(id, patch))
    },

    deleteFileForever: async id => {
      const meta = get().files.find(file => file.id === id)
      const ref = meta?.origin?.storage === 'drive' ? meta.origin.storedFileId : undefined
      // a library that is closed or read only refuses before anything is shown
      repository()
      // it leaves the list now; if the Drive refuses, it comes back
      if (meta) set(state => ({ files: state.files.filter(file => file.id !== id) }))
      try {
        // an entrada and the notes that existed before it share the stored file: it goes with the last one
        if (ref && !get().files.some(file => file.id !== id && file.origin?.storedFileId === ref)) await repository().removeSource(ref).catch(() => undefined)
        await repository().removeFile(id)
      } catch (error) {
        if (meta) replaceFile(meta)
        throw error
      }
      set(state => {
        const opened = { ...state.opened }
        delete opened[id]
        const sizes = { ...state.sizes }
        delete sizes[id]
        return { files: state.files.filter(file => file.id !== id), opened, sizes }
      })
    },

    createFolder: async (fields, rule = 'reuse') => {
      const { folder, reused } = folderByRule(get().folders, fields, rule)
      if (reused) return folder
      await repository().saveFolder(folder)
      replaceFolder(folder)
      return folder
    },

    ownFolders: () => (own ?? get()).folders,

    ownFiles: () => (own ?? get()).files,

    createOwnFolder: async (fields, rule = 'reuse') => {
      if (!own) return get().createFolder(fields, rule)
      const repo = get().repo
      if (!repo) throw new Error('A biblioteca ainda não abriu.')
      const { folder, reused } = folderByRule(own.folders, fields, rule)
      if (reused) return folder
      await repo.saveFolder(folder)
      if (own) own = { ...own, folders: [...own.folders, folder] }
      return folder
    },

    updateFolder: async (id, patch, rule = 'number') => {
      const folder = get().folders.find(item => item.id === id)
      if (!folder) return
      repository()
      const named = freeFolder(id, patch, rule)
      const undo = showNow<FolderMeta>('folders', [id], named)
      try {
        const next = { ...folder, ...named, updated: stamp() }
        await repository().saveFolder(next)
        replaceFolder(next)
      } catch (error) {
        undo()
        throw error
      }
    },

    trashFolder: async id => {
      await get().updateFolder(id, { deletedAt: nowIso() })
    },

    restoreFolder: async id => {
      const folder = get().folders.find(item => item.id === id)
      const parent = get().folders.find(item => item.id === folder?.parentId)
      await get().updateFolder(id, { deletedAt: null, parentId: parent && !parent.deletedAt ? folder!.parentId : null })
    },

    deleteFolderForever: async id => {
      const ids = descendantFolderIds(get().folders, id)
      for (const file of get().files.filter(item => item.folderId && ids.includes(item.folderId))) await get().deleteFileForever(file.id)
      for (const folderId of [...ids].reverse()) await repository().removeFolder(folderId)
      set(state => ({ folders: state.folders.filter(folder => !ids.includes(folder.id)) }))
    },

    emptyTrash: async () => {
      for (const folder of get().folders.filter(item => item.deletedAt)) await get().deleteFolderForever(folder.id)
      for (const file of get().files.filter(item => item.deletedAt)) await get().deleteFileForever(file.id)
    },

    purgeExpiredTrash: async () => {
      let removed = 0
      for (const folder of get().folders.filter(item => expired(item.deletedAt))) {
        await get().deleteFolderForever(folder.id)
        removed++
      }
      for (const file of get().files.filter(item => expired(item.deletedAt))) {
        await get().deleteFileForever(file.id)
        removed++
      }
      return removed
    },

    updateSettings: async patch => {
      const index = get().index
      const settings = { ...index.settings, ...patch }
      // The old single AI follows the Tutor model of the new config (old code still reads it).
      await saveIndex({ ...index, settings: patch.aiConfig ? { ...settings, ai: legacyAiOf(patch.aiConfig) } : settings, updated: stamp() })
    },

    startActivity: async fields => {
      const activity: Activity = { ...fields, id: newId(), status: 'running', detail: '', createdAt: nowIso(), finishedAt: null, deviceId: currentDevice().id }
      const index = get().index
      await saveIndex({ ...index, activities: [activity, ...index.activities].slice(0, ACTIVITIES_KEPT), updated: stamp() }).catch(() => undefined)
      return activity.id
    },

    finishActivity: async (id, status, detail) => {
      const index = get().index
      const activities = index.activities.map(activity => (activity.id === id ? { ...activity, status, detail, finishedAt: nowIso() } : activity))
      await saveIndex({ ...index, activities, updated: stamp() }).catch(() => undefined)
    },

    setQuestions: async (id, questions, append = false) => {
      await get().updateSidecar(id, sidecar => {
        const all = append ? [...sidecar.questions, ...questions] : questions
        return { ...sidecar, questions: all, meta: { ...sidecar.meta, questionCount: all.length } }
      })
    },

    recordAttempt: async (id, fields) => {
      const shared = get().sharedView
      if (shared) {
        const done = saveSharedAttempt(shared.item.id, id, fields)[id] ?? []
        const last = done[done.length - 1]
        set(state => {
          const opened = state.opened[id]
          if (!opened || !last) return {}
          const meta = { ...opened.sidecar.meta, mastery: masteryOf(last.correct, last.total), lastReviewedAt: last.createdAt }
          return { opened: { ...state.opened, [id]: { ...opened, sidecar: { ...opened.sidecar, attempts: done, meta } } }, files: state.files.map(file => (file.id === id ? meta : file)) }
        })
        return
      }
      const attempt: Attempt = { ...fields, id: newId(), createdAt: nowIso(), deviceId: currentDevice().id }
      await get().updateSidecar(id, sidecar => ({
        ...sidecar,
        attempts: [...sidecar.attempts, attempt],
        meta: { ...sidecar.meta, mastery: masteryOf(attempt.correct, attempt.total), lastReviewedAt: attempt.createdAt },
      }))
    },

    saveHighlight: async (id, highlight) => {
      await changeSidecarNow(id, sidecar => ({
        ...sidecar,
        highlights: sidecar.highlights.some(item => item.id === highlight.id)
          ? sidecar.highlights.map(item => (item.id === highlight.id ? highlight : item))
          : [...sidecar.highlights, highlight],
      }))
    },

    removeHighlight: async (id, highlightId) => {
      await changeSidecarNow(id, sidecar => ({ ...sidecar, highlights: sidecar.highlights.filter(item => item.id !== highlightId) }))
    },

    saveArtifact: async (fileId, artifact, replaceId) => {
      const list = artifactsOf(await changeArtifacts(fileId, sidecar => withArtifact(sidecar, { ...artifact, updatedAt: nowIso() }, replaceId)))
      return list.find(item => item.id === replaceId) ?? list.find(item => item.id === artifact.id)!
    },

    renameArtifact: async (fileId, id, name) => {
      await changeArtifacts(fileId, sidecar => renameArtifact(sidecar, id, name))
    },

    deleteArtifact: async (fileId, id) => {
      await changeArtifacts(fileId, sidecar => removeArtifact(sidecar, id))
    },

    markOpened: id => {
      if (get().sharedView) return
      const openedAt = { ...get().openedAt, [id]: Date.now() }
      set({ openedAt })
      try {
        localStorage.setItem(`${OPENED_KEY}:${get().accountId}`, JSON.stringify(openedAt))
      } catch {
        return
      }
    },

    saveShare: async share => {
      const index = get().index
      await saveIndex({ ...index, shares: [share, ...index.shares.filter(item => item.id !== share.id)], updated: stamp() })
    },

    dropShare: async id => {
      const index = get().index
      await saveIndex({ ...index, shares: index.shares.filter(item => item.id !== id), updated: stamp() })
    },

    rememberSharedLink: async link => {
      const index = get().index
      await saveIndex({ ...index, sharedWithMe: activeLinks([link, ...index.sharedWithMe.filter(item => item.id !== link.id)]), updated: stamp() })
    },

    pruneSharedLinks: async () => {
      const index = get().index
      const kept = activeLinks(index.sharedWithMe)
      if (kept.length !== index.sharedWithMe.length) await saveIndex({ ...index, sharedWithMe: kept, updated: stamp() })
    },

    forgetCurrent: async () => {
      const repo = get().repo
      if (repo) await repo.forget()
      try {
        localStorage.removeItem(`${OPENED_KEY}:${get().accountId}`)
      } catch {
        return
      }
    },
  }
})

/** The library's operations of the Lista de operações (spec 007, T015), measured from the start of the action to the frame after it. */
export const LIBRARY_OPS: Partial<Record<keyof LibraryState, OpOf>> = {
  createFile: 'criar',
  createFolder: 'criar',
  createOwnFolder: 'criar',
  moveFiles: 'mover',
  trashFiles: 'apagar',
  trashFamily: 'apagar',
  trashOnly: 'apagar',
  trashFolder: 'apagar',
  restoreFile: 'restaurar',
  restoreFolder: 'restaurar',
  saveContent: 'guardar-texto',
  updateFile: { args: (_id: string, patch: Partial<FileMeta>) => ('name' in patch ? 'renomear' : 'folderId' in patch ? 'mover' : null) },
  updateFolder: { args: (_id: string, patch: Partial<FolderMeta>) => ('name' in patch ? 'renomear' : 'parentId' in patch ? 'mover' : null) },
  openFile: { result: (opened?: OpenedFile) => (!opened ? null : opened.sidecar.meta.type === 'pdf' ? 'abrir-nota-pdf' : mediaOf(opened.sidecar.meta) !== 'text' ? 'abrir-nota-midia' : 'abrir-nota-texto') },
}
medirAcoes(useLibraryStore, LIBRARY_OPS)

export function liveFolders(folders: FolderMeta[]): FolderMeta[] {
  const trashed = new Set(folders.filter(folder => folder.deletedAt).map(folder => folder.id))
  const byId = new Map(folders.map(folder => [folder.id, folder]))
  const hidden = (folder: FolderMeta): boolean => {
    let current: FolderMeta | undefined = folder
    for (let depth = 0; current && depth < 64; depth++) {
      if (trashed.has(current.id)) return true
      current = current.parentId ? byId.get(current.parentId) : undefined
    }
    return false
  }
  return folders.filter(folder => !hidden(folder))
}

export function liveFiles(files: FileMeta[], folders: FolderMeta[]): FileMeta[] {
  const live = new Set(liveFolders(folders).map(folder => folder.id))
  return files.filter(file => !file.deletedAt && (file.folderId === null || live.has(file.folderId)))
}

let stopLive: (() => void) | null = null

/** With the App on, the live channel brings another device's change in seconds (SC-004); without it, the channel is closed. */
function followLive(repo: CombinedRepository | null): void {
  stopLive?.()
  stopLive = null
  // with the hierarchy on the account, every session follows it, with or without the App (spec 005, FR-004); before it, only the App
  const hierarchy = repo?.hierarchy
  const app = repo?.app
  const seq = hierarchy ? () => hierarchy.currentSeq : app instanceof AppRepository ? () => app.currentSeq : null
  if (!seq || typeof WebSocket === 'undefined') return
  stopLive = openLive({
    seq,
    onMap: () => void import('@/stores/sync').then(({ useSyncStore }) => useSyncStore.getState().syncNow()).catch(() => undefined),
    // spec 007, história 2: the jobs of generating in the account, in Gerações of every device
    onJob: job => void import('@/stores/account-jobs').then(({ useAccountJobsStore }) => useAccountJobsStore.getState().apply(job as never)).catch(() => undefined),
  })
}

/**
 * Every Google account opens its session on the server by itself, with the token the app already has and with no code (spec 005,
 * R4). The library never waits for it: with the server out, it opens as before. Without a server set up, nothing is called. Only
 * when the server was not asked yet: a person who left the server account on purpose is not put back in.
 */
async function openServerSession(accountId: string, tokenProvider: TokenProvider): Promise<void> {
  if (!env.apiUrl) return
  const server = useServerAccount.getState()
  if (server.status !== 'unknown') return
  try {
    await server.refresh()
    if (useServerAccount.getState().status !== 'signed-out' || useLibraryStore.getState().accountId !== accountId) return
    await server.signInWithGoogleToken(await tokenProvider())
  } catch {
    return
  }
}

/** A note written without internet that the server refused for good: it is in a copy in this browser, and the person is told why. */
function tellRefused(name: string, reason: string): void {
  const why = reason === 'not_found' ? 'a nota foi apagada em outro aparelho' : reason === 'app_off' ? 'a estrutura do app está desligada' : 'o servidor recusou'
  void import('@/stores/ui').then(({ useUiStore }) => useUiStore.getState().toast(`“${name}” não subiu: ${why}. O que você escreveu sem internet ficou guardado numa cópia neste navegador.`))
}

/** The session of the server; while it does not answer, the last one this browser had (história 6: the library opens without internet). */
function sessionNow(): { me: ServerMe | null; known: boolean } {
  const { me, status, remembered } = useServerAccount.getState()
  if (status === 'offline') {
    // the session this tab already had, else the one this browser kept
    const last = me ?? remembered
    return { me: last, known: Boolean(last) }
  }
  return { me, known: status === 'signed-in' }
}

/** Whether the server account has "Usar a estrutura do app" on (freed by a code). */
function serverAppOn(): boolean {
  const user = sessionNow().me?.user
  return Boolean(user && user.status === 'enabled' && user.appEnabled)
}

/**
 * Whether the library's tree comes from the account's hierarchy (spec 005): only once that account's hierarchy migrated
 * (`hierarchyAt`), with the server session of the same person as the Google account of the library. Before that, all as it was.
 */
function hierarchyOn(accountId: string | null): boolean {
  const { me, known } = sessionNow()
  const account = useAccountStore.getState().accounts.find(item => item.id === accountId)
  return Boolean(known && me?.user.hierarchyAt && account?.kind === 'google' && account.email && account.email.toLowerCase() === me.user.email?.toLowerCase())
}

/**
 * The hierarchy of today has not gone to the account yet (spec 005, história 2): the server knows the hierarchy (`hierarchyAt` is null,
 * not missing) and the session is the same person as the Google account of the library.
 */
function hierarchyToMigrate(accountId: string | null): boolean {
  const { me, status } = useServerAccount.getState()
  const account = useAccountStore.getState().accounts.find(item => item.id === accountId)
  return Boolean(status === 'signed-in' && me?.user.hierarchyAt === null && account?.kind === 'google' && account.email && account.email.toLowerCase() === me.user.email?.toLowerCase())
}

const many = (count: number, one: string, more: string) => `${count.toLocaleString('pt-BR')} ${count === 1 ? one : more}`

let migrating = false

/** Once per account, in the window that holds the app; a failure leaves the library as it was and the next opening goes on (FR-016). */
function migrateHierarchyWhenReady(): void {
  const { repo, accountId, ready, folders, files } = useLibraryStore.getState()
  if (!env.hierarchyMigration || migrating || !ready || !(repo instanceof CombinedRepository) || repo.hierarchy || !hierarchyToMigrate(accountId)) return
  migrating = true
  void (async () => {
    try {
      const count = await blocking('Levando a biblioteca para a sua conta', blocker => migrateHierarchy(repo, { folders, files }, blocker))
      const { useUiStore } = await import('@/stores/ui')
      useUiStore.getState().toast(`Pronto: ${many(count.folders, 'pasta', 'pastas')} e ${many(count.files, 'nota', 'notas')} na sua conta. Nada mudou de lugar.`)
      // the session brings `hierarchyAt`, and the library follows the account's hierarchy
      await useServerAccount.getState().refresh()
    } catch (error) {
      blockingFailure('A biblioteca continua como estava', new Error(`${apiMessage(error)} Nada mudou de lugar; ela tenta de novo na próxima vez que você abrir o app.`))
    } finally {
      migrating = false
    }
  })()
}

// the connection is back: what waited for it goes up now (spec 005, FR-011)
if (typeof window !== 'undefined')
  window.addEventListener('online', () => {
    // a library opened with the last session (história 6): the server's own answer takes its place
    if (useServerAccount.getState().status === 'offline') void useServerAccount.getState().refresh().catch(() => undefined)
    const { repo } = useLibraryStore.getState()
    if (repo instanceof CombinedRepository && repo.hierarchy) void import('@/stores/sync').then(({ useSyncStore }) => useSyncStore.getState().syncNow())
  })

/** Spec 005, R6: notes in Local whose folder was deleted for good on another device show at the root, and the app says so once. */
function warnLostFolders(repo: Repository): void {
  if (!(repo instanceof CombinedRepository) || !repo.lostFolder.size) return
  const count = repo.lostFolder.size
  void import('@/stores/ui').then(({ useUiStore }) =>
    useUiStore.getState().toast(`${count === 1 ? '1 nota em Local estava numa pasta apagada' : `${count} notas em Local estavam numa pasta apagada`} em outro aparelho: ${count === 1 ? 'ela está' : 'elas estão'} na raiz da biblioteca.`),
  )
}

/** The foot of the sidebar follows the account's hierarchy: what waits to go up and whether the account answers. */
function watchHierarchy(repo: CombinedRepository): void {
  const tree = repo.hierarchy
  useLibraryStore.setState({ hierarchySync: tree ? { pending: 0, online: true } : null })
  if (!tree) return
  // the hierarchy's changes and the App's content written without internet, each note once (história 6)
  const tell = () => void repo.waiting().then(state => repo.hierarchy === tree && useLibraryStore.setState({ hierarchySync: state }), () => undefined)
  tree.onState = tell
  repo.onHeld = tell
}

/** The migration ended (or the session arrived) with the library open: the tree passes to the account's hierarchy, and loads again. */
async function followHierarchy(repo: CombinedRepository, on: boolean): Promise<void> {
  const accountId = useLibraryStore.getState().accountId
  if (!accountId || on === Boolean(repo.hierarchy)) return
  repo.setHierarchy(on ? new HierarchyRepository(accountId) : null)
  followLive(repo)
  watchHierarchy(repo)
  try {
    const snapshot = await repo.load()
    if (useLibraryStore.getState().repo === repo) {
      useLibraryStore.getState().applySnapshot(snapshot)
      warnLostFolders(repo)
    }
  } catch (error) {
    if (useLibraryStore.getState().repo === repo) useLibraryStore.setState({ loadError: error instanceof Error ? error.message : 'Não consegui abrir a biblioteca.' })
  }
}

// the account on the server arrives after the library (or the person turns the structure on or off): the App place follows it
useServerAccount.subscribe(() => {
  const on = serverAppOn()
  // spec 006: with the structure on, the AI is the app's
  followAppAi(on && useServerAccount.getState().status === 'signed-in')
  if (on !== useLibraryStore.getState().appOn) void useLibraryStore.getState().attachApp(on)
  const { repo, accountId } = useLibraryStore.getState()
  if (repo instanceof CombinedRepository && hierarchyOn(accountId) !== Boolean(repo.hierarchy)) void followHierarchy(repo, hierarchyOn(accountId))
  migrateHierarchyWhenReady()
})
