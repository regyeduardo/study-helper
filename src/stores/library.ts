import { create } from 'zustand'

import type {
  Activity,
  Attempt,
  FileMeta,
  FileSidecar,
  FileType,
  FolderMeta,
  Highlight,
  LibraryIndex,
  Settings,
  SharedLink,
  ShareRecord,
  Snapshot,
  StoredQuestion,
} from '@/types/domain'
import type { TokenProvider } from '@/controllers/drive.controller'
import { isKnownProvider, providerOf } from '@/lib/ai/providers'
import { defaultIndex, newFileMeta, newFolderMeta, newSidecar } from '@/lib/defaults'
import { currentDevice, stamp } from '@/lib/device'
import { masteryOf } from '@/lib/exam'
import { activeLinks } from '@/lib/share'
import { newId, nowIso } from '@/lib/ids'
import { type LocalMedia, listLocalMedia, watchLocalMedia } from '@/lib/recording/media-library'
import { openDriveLibrary } from '@/lib/storage/hidden-migration'
import { LocalRepository } from '@/lib/storage/local-repository'
import type { Repository, StoredSize } from '@/lib/storage/repository'
import type { TrackedTask } from '@/stores/jobs'
import { readingMinutes, wordCount } from '@/utils/format'

export const TRASH_DAYS = 30
const ACTIVITIES_KEPT = 300

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
  folders: FolderMeta[]
  files: FileMeta[]
  index: LibraryIndex
  opened: Record<string, OpenedFile>
  openedAt: Record<string, number>
  sizes: Record<string, StoredSize>
  localMedia: LocalMedia[]
  connect(accountId: string, tokenProvider?: TokenProvider): Promise<void>
  applySnapshot(snapshot: Snapshot, changedFileIds?: string[]): void
  openFile(id: string): Promise<OpenedFile>
  createFile(fields: Partial<FileMeta> & { name: string; type: FileType }, content: string): Promise<FileMeta>
  saveContent(id: string, content: string, patch?: Partial<FileMeta>): Promise<void>
  updateFile(id: string, patch: Partial<FileMeta>): Promise<void>
  updateSidecar(id: string, change: (sidecar: FileSidecar) => FileSidecar): Promise<FileSidecar>
  moveFiles(ids: string[], folderId: string | null): Promise<void>
  trashFiles(ids: string[]): Promise<void>
  restoreFile(id: string): Promise<void>
  deleteFileForever(id: string): Promise<void>
  createFolder(fields: Partial<FolderMeta> & { name: string }): Promise<FolderMeta>
  updateFolder(id: string, patch: Partial<FolderMeta>): Promise<void>
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

function withUsableAi(settings: Settings): Settings {
  const { ai } = settings
  const usable = isKnownProvider(ai.provider) && !(providerOf(ai.provider).needsKey && !ai.apiKey.trim())
  return usable ? settings : { ...settings, ai: defaultIndex().settings.ai }
}

export const useLibraryStore = create<LibraryState>((set, get) => {
  const repository = (): Repository => {
    const repo = get().repo
    if (!repo) throw new Error('A biblioteca ainda não abriu.')
    return repo
  }

  const replaceFile = (meta: FileMeta) => set(state => ({ files: state.files.some(file => file.id === meta.id) ? state.files.map(file => (file.id === meta.id ? meta : file)) : [...state.files, meta] }))

  const replaceFolder = (folder: FolderMeta) =>
    set(state => ({ folders: state.folders.some(item => item.id === folder.id) ? state.folders.map(item => (item.id === folder.id ? folder : item)) : [...state.folders, folder] }))

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

  const saveSidecarOnly = async (sidecar: FileSidecar): Promise<FileSidecar> => {
    const saved = await repository().saveFile(sidecar)
    measure(repository(), [saved.meta.id])
    replaceFile(saved.meta)
    set(state => (state.opened[saved.meta.id] ? { opened: { ...state.opened, [saved.meta.id]: { ...state.opened[saved.meta.id], sidecar: saved } } } : {}))
    return saved
  }

  const saveIndex = async (index: LibraryIndex) => {
    set({ index })
    await repository().saveIndex(index)
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

    connect: async (accountId, tokenProvider) => {
      set({ repo: null, accountId, ready: false, loadError: null, hiddenPending: false, hiddenWarning: null, folders: [], files: [], opened: {}, openedAt: readOpened(accountId), sizes: {} })
      let repo: Repository
      try {
        if (!tokenProvider) repo = new LocalRepository()
        else {
          const { useJobsStore } = await import('@/stores/jobs')
          let task: TrackedTask | null = null
          const library = await openDriveLibrary(accountId, tokenProvider, (message, fraction) => {
            task ??= useJobsStore.getState().trackTask('Mudando para a pasta oculta do Drive')
            task.update(message, fraction)
          })
          if (library.warning) (task as TrackedTask | null)?.fail(library.warning)
          else (task as TrackedTask | null)?.done('Tudo na pasta oculta do Drive')
          if (get().accountId !== accountId) return
          repo = library.repo
          set({ hiddenPending: library.hiddenPending, hiddenWarning: library.warning })
        }
      } catch (error) {
        set({ loadError: error instanceof Error ? error.message : 'Não consegui abrir a biblioteca.', ready: true })
        return
      }
      set({ repo })
      try {
        const snapshot = await repo.load()
        if (get().repo !== repo) return
        get().applySnapshot(snapshot)
        set({ ready: true })
        await get().purgeExpiredTrash()
      } catch (error) {
        if (get().repo === repo) set({ loadError: error instanceof Error ? error.message : 'Não consegui abrir a biblioteca.', ready: true })
      }
    },

    applySnapshot: (snapshot, changedFileIds = []) => {
      set(state => {
        const opened = { ...state.opened }
        for (const id of changedFileIds) delete opened[id]
        return { folders: snapshot.folders, files: snapshot.files, index: { ...defaultIndex(), ...snapshot.index, settings: withUsableAi({ ...defaultIndex().settings, ...snapshot.index.settings }) }, opened }
      })
      const repo = get().repo
      if (repo) measure(repo)
      refreshMedia()
    },

    openFile: async id => {
      const cached = get().opened[id]
      if (cached) return cached
      const [content, sidecar] = await Promise.all([repository().readContent(id), repository().readSidecar(id)])
      const opened = { content, sidecar }
      set(state => ({ opened: { ...state.opened, [id]: opened } }))
      return opened
    },

    createFile: async (fields, content) => {
      const meta = newFileMeta({ ...fields, ...statsOf(content) })
      const sidecar = newSidecar(meta)
      await repository().saveFile(sidecar, content)
      measure(repository(), [meta.id])
      replaceFile(meta)
      set(state => ({ opened: { ...state.opened, [meta.id]: { content, sidecar } } }))
      return meta
    },

    saveContent: async (id, content, patch = {}) => {
      const sidecar = await sidecarOf(id)
      const next: FileSidecar = { ...sidecar, meta: { ...sidecar.meta, ...patch, ...statsOf(content), updated: stamp() } }
      const saved = await repository().saveFile(next, content)
      measure(repository(), [id])
      const merged = await repository().readContent(id).catch(() => content)
      replaceFile(saved.meta)
      set(state => ({ opened: { ...state.opened, [id]: { content: merged, sidecar: saved } } }))
    },

    updateFile: async (id, patch) => {
      const sidecar = await sidecarOf(id)
      await saveSidecarOnly({ ...sidecar, meta: { ...sidecar.meta, ...patch, updated: stamp() } })
    },

    updateSidecar: async (id, change) => {
      const sidecar = await sidecarOf(id)
      const next = change(sidecar)
      return saveSidecarOnly({ ...next, meta: { ...next.meta, updated: stamp() } })
    },

    moveFiles: async (ids, folderId) => {
      for (const id of ids) await get().updateFile(id, { folderId })
    },

    trashFiles: async ids => {
      for (const id of ids) await get().updateFile(id, { deletedAt: nowIso() })
    },

    restoreFile: async id => {
      const meta = get().files.find(file => file.id === id)
      const folder = get().folders.find(item => item.id === meta?.folderId)
      await get().updateFile(id, { deletedAt: null, folderId: folder && !folder.deletedAt ? meta!.folderId : null })
    },

    deleteFileForever: async id => {
      const meta = get().files.find(file => file.id === id)
      if (meta?.origin?.storage === 'drive' && meta.origin.storedFileId) await repository().removeSource(meta.origin.storedFileId).catch(() => undefined)
      await repository().removeFile(id)
      set(state => {
        const opened = { ...state.opened }
        delete opened[id]
        const sizes = { ...state.sizes }
        delete sizes[id]
        return { files: state.files.filter(file => file.id !== id), opened, sizes }
      })
    },

    createFolder: async fields => {
      const folder = newFolderMeta(fields)
      await repository().saveFolder(folder)
      replaceFolder(folder)
      return folder
    },

    updateFolder: async (id, patch) => {
      const folder = get().folders.find(item => item.id === id)
      if (!folder) return
      const next = { ...folder, ...patch, updated: stamp() }
      await repository().saveFolder(next)
      replaceFolder(next)
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
      await saveIndex({ ...index, settings: { ...index.settings, ...patch }, updated: stamp() })
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
      const attempt: Attempt = { ...fields, id: newId(), createdAt: nowIso(), deviceId: currentDevice().id }
      await get().updateSidecar(id, sidecar => ({
        ...sidecar,
        attempts: [...sidecar.attempts, attempt],
        meta: { ...sidecar.meta, mastery: masteryOf(attempt.correct, attempt.total), lastReviewedAt: attempt.createdAt },
      }))
    },

    saveHighlight: async (id, highlight) => {
      await get().updateSidecar(id, sidecar => ({
        ...sidecar,
        highlights: sidecar.highlights.some(item => item.id === highlight.id)
          ? sidecar.highlights.map(item => (item.id === highlight.id ? highlight : item))
          : [...sidecar.highlights, highlight],
      }))
    },

    removeHighlight: async (id, highlightId) => {
      await get().updateSidecar(id, sidecar => ({ ...sidecar, highlights: sidecar.highlights.filter(item => item.id !== highlightId) }))
    },

    markOpened: id => {
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
