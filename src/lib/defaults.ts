import type { FileMeta, FileSidecar, FileType, FolderMeta, LibraryIndex, Settings } from '@/types/domain'
import { stamp } from '@/lib/device'
import { newId } from '@/lib/ids'

export const DEFAULT_STORAGE_LIMIT_BYTES = 1024 * 1024 * 1024

export function defaultSettings(): Settings {
  return {
    ai: { provider: 'ovh', baseUrl: '', apiKey: '', model: '' },
    transcription: { engine: 'whisper', groqApiKey: '', language: 'pt', separateSpeakers: true },
    youtube: { reader: 'youtube-transcript', geminiApiKey: '' },
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'America/Sao_Paulo',
    githubToken: '',
    layout: 'reader',
    storageLimitBytes: null,
    examOneAtATime: false,
  }
}

export function defaultIndex(): LibraryIndex {
  return { version: 1, settings: defaultSettings(), tags: [], activities: [], updated: stamp() }
}

export function newFileMeta(fields: Partial<FileMeta> & { name: string; type: FileType }): FileMeta {
  const created = stamp()
  return {
    id: newId(),
    folderId: null,
    description: '',
    status: 'ready',
    position: 0,
    favorite: false,
    tags: [],
    parentFileId: null,
    sourceExcerpt: null,
    pendingExcerpt: null,
    origin: null,
    generation: null,
    created,
    updated: created,
    deletedAt: null,
    words: 0,
    readingMinutes: 0,
    mastery: null,
    lastReviewedAt: null,
    questionCount: 0,
    ...fields,
  }
}

export function newSidecar(meta: FileMeta): FileSidecar {
  return { meta, questions: [], attempts: [], highlights: [] }
}

export function newFolderMeta(fields: Partial<FolderMeta> & { name: string }): FolderMeta {
  const created = stamp()
  return {
    id: newId(),
    parentId: null,
    position: 0,
    description: '',
    isCourse: false,
    courseOrigin: null,
    courseDescription: null,
    courseMaterial: null,
    created,
    updated: created,
    deletedAt: null,
    ...fields,
  }
}
