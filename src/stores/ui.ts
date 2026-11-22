import { create } from 'zustand'

import type { AtaModelId, AtaPart, AtaStepModels, Attempt, FileType, MediaAnalysis, ShareKind, SourceStorage, StoredQuestion } from '@/types/domain'
import type { LitterboxTime } from '@/controllers/hosting.controller'
import { isNarrowScreen } from '@/hooks/use-is-narrow'
import { clearFilters as withFiltersCleared, type LibraryFilters, NO_FILTERS } from '@/lib/library-filters'
import type { Agent, KeepLevel, NoteAgent } from '@/stores/jobs'

/** What a generation window was filled with: "Tentar de novo" after a failure brings it back as it was. */
export interface GenerationPrefill {
  /** The model picked (absent: the default comes preselected). */
  model?: string
  videoWrites?: boolean
  instruction?: string
  analyze?: MediaAnalysis
  /** "Salvar em": the folder picked (absent: the one the window offers). */
  folderId?: string | null
  /** Gerar de novo: over the note made before, or a new note. */
  replace?: boolean
  /** "Gerar desta entrada": what to make. */
  goal?: NoteAgent | 'transcribe'
  parts?: AtaPart[]
  ataModel?: AtaModelId | null
  steps?: AtaStepModels
}

/** Everything "Novo conteúdo" was filled with, the file included. */
export interface NewContentForm {
  tab: 'link' | 'file' | 'text' | 'topic'
  agent: Agent
  url: string
  text: string
  topic: string
  file: File | null
  isMedia: boolean
  keep: KeepLevel | null
  storage: SourceStorage | null
  litterboxTime: LitterboxTime
  name: string
  description: string
  prompt: string
  folderId: string | null
  ataParts: AtaPart[]
  ataModel: AtaModelId | null
  /** The models picked, by use (absent: the default). */
  models: { aula?: string; explicacao?: string; ata?: string; transcricao?: string; videoWrites?: boolean }
  analyze?: MediaAnalysis
  steps?: AtaStepModels
}

export type Overlay =
  | { kind: 'palette' }
  | { kind: 'new'; folderId?: string | null; prefill?: NewContentForm }
  | { kind: 'record' }
  | { kind: 'media' }
  /** `focusId`: in Armazenamento, "Locais" opens with that folder or note in view. */
  | { kind: 'settings'; tab?: SettingsTab; focusId?: string }
  | { kind: 'exam'; fileId: string }
  | { kind: 'cards'; fileId: string; deckId?: string }
  | { kind: 'mindmap'; fileId: string; artifactId?: string }
  /** `conversationId`: that conversation; `null`: a new one; absent: the last one. */
  | { kind: 'tutor'; fileId: string; conversationId?: string | null }
  /** Chat da mídia: the transcript and the notes born of the entrada. */
  | { kind: 'chat'; fileId: string }
  /** "+ Novo" of a map or a deck; `again`: the one made before ("Gerar de novo"); `prefill`: the window as it was when that generation failed. */
  | { kind: 'generate-artifact'; fileId: string; artifact: 'mapa' | 'cartoes'; again?: string; prefill?: GenerationPrefill }
  | { kind: 'ata-parts'; fileId: string; again?: string; prefill?: GenerationPrefill }
  | { kind: 'generate'; fileId: string; agent: NoteAgent; redo?: boolean; again?: string; prefill?: GenerationPrefill }
  /** "Gerar desta entrada": what makes sense for its kind and for what it keeps. */
  | { kind: 'generate-entry'; fileId: string; prefill?: GenerationPrefill }
  | { kind: 'transcribe'; fileId: string; prefill?: GenerationPrefill }
  /** "Gerar agora", "Tentar de novo" and "Refazer" of a note kept to write (`fileId`), or every lesson still to write in a course folder (`folderId`); `go`: open the note once it starts. */
  | { kind: 'pending'; fileId?: string; folderId?: string; go?: boolean; prefill?: GenerationPrefill }
  | { kind: 'folder-exam'; folderId: string | null; fileIds?: string[] }
  | { kind: 'account'; x?: number; y?: number }
  | { kind: 'new-folder'; parentId: string | null }
  | { kind: 'rename'; target: 'file' | 'folder'; id: string }
  | { kind: 'move'; fileIds: string[]; folderIds: string[] }
  | { kind: 'confirm'; title: string; text: string; ok: string; danger?: boolean; onConfirm: () => void | Promise<void>; alt?: { label: string; onConfirm: () => void | Promise<void> } }
  /** "Apagar" with the family tree when the item has descendants; `fileIds`: a whole selection, by the same choice. */
  | { kind: 'delete-family'; fileId: string; fileIds?: string[] }
  | { kind: 'explain'; fileId: string; excerpt: string }
  /** "Gerar a partir disto": a link or a passage selected in a note; `prefill`: the window as it was when that generation failed. */
  | { kind: 'from-selection'; fileId: string; excerpt: string; prefill?: GenerationPrefill }
  | { kind: 'order'; folderId: string }
  | { kind: 'activity' }
  | { kind: 'import' }
  | { kind: 'send-local' }
  | { kind: 'sync-local'; ids?: string[] }
  | { kind: 'storage-limit' }
  | { kind: 'share'; target: ShareKind; id: string }
  | { kind: 'shared-exam'; title: string; questions: StoredQuestion[]; onRecord: (fields: Omit<Attempt, 'id' | 'createdAt' | 'deviceId'>) => void }

export type SettingsTab = 'appearance' | 'ai' | 'transcription' | 'links' | 'storage' | 'devices' | 'general' | 'others'

export type SortKey = 'recent' | 'title' | 'mastery'
export type GroupKey = 'none' | 'type' | 'folder'
export type InspectorTab = 'mine' | 'toc' | 'notes' | 'info'

export interface ItemMenu {
  kind: 'file' | 'folder'
  id: string
  x: number
  y: number
}

export interface Toast {
  id: number
  text: string
  /** A button in the toast that opens a page of the app: what it says and where it goes. */
  action?: { label: string; to: string }
}

/** What is being dragged to a folder. `over`: the folder under the pointer, `null` being the root; absent, none. */
export interface DragState {
  fileIds: string[]
  folderIds: string[]
  over?: string | null
}

interface UiState {
  overlay: Overlay | null
  menu: ItemMenu | null
  toasts: Toast[]
  /** The checked items: files and, in the table, folders. */
  selection: Set<string>
  drag: DragState | null
  query: string
  types: Set<FileType>
  lowMastery: boolean
  /** The tag of the side bar: also in `filters.tags`, and it looks in the whole library. */
  tag: string | null
  /** The filter panel of the lists (FR-044). */
  filters: LibraryFilters
  filtersCollapsed: boolean
  sort: SortKey
  group: GroupKey
  leftOpen: boolean
  rightOpen: boolean
  drawer: boolean
  inspectorTab: InspectorTab
  peekId: string | null
  columnsPane: 'nav' | 'list' | 'doc'
  columnsSheet: boolean
  focusPop: InspectorTab | null
  handoffFileId: string | null
  reorder: boolean
  panelAsked: boolean
  open(overlay: Overlay): void
  close(): void
  openMenu(menu: ItemMenu | null): void
  toast(text: string, action?: Toast['action']): void
  dismissToast(id: number): void
  toggleSelected(id: string): void
  setSelection(ids: string[]): void
  clearSelection(): void
  setQuery(query: string): void
  toggleType(type: FileType): void
  toggleLowMastery(): void
  setTag(tag: string | null): void
  setFilters(filters: LibraryFilters): void
  clearFilters(): void
  setSort(sort: SortKey): void
  setGroup(group: GroupKey): void
  set(patch: Partial<Pick<UiState, 'leftOpen' | 'rightOpen' | 'drawer' | 'inspectorTab' | 'peekId' | 'columnsPane' | 'columnsSheet' | 'focusPop' | 'reorder' | 'handoffFileId' | 'panelAsked' | 'drag' | 'filtersCollapsed'>>): void
}

let toastSeq = 0
const TOAST_MS = 2600
/** A toast with a button stays long enough to be read and clicked. */
const ACTION_TOAST_MS = 10000

export const useUiStore = create<UiState>(set => ({
  overlay: null,
  menu: null,
  toasts: [],
  selection: new Set(),
  drag: null,
  query: '',
  types: new Set(),
  lowMastery: false,
  tag: null,
  filters: NO_FILTERS,
  filtersCollapsed: false,
  sort: 'recent',
  group: 'none',
  leftOpen: true,
  rightOpen: !isNarrowScreen(),
  drawer: false,
  inspectorTab: 'toc',
  peekId: null,
  columnsPane: 'list',
  columnsSheet: false,
  focusPop: null,
  handoffFileId: null,
  reorder: false,
  panelAsked: false,

  open: overlay => set({ overlay, menu: null }),
  close: () => set({ overlay: null }),
  openMenu: menu => set({ menu }),
  toast: (text, action) => {
    const id = ++toastSeq
    set(state => ({ toasts: [...state.toasts, action ? { id, text, action } : { id, text }] }))
    setTimeout(() => set(state => ({ toasts: state.toasts.filter(toast => toast.id !== id) })), action ? ACTION_TOAST_MS : TOAST_MS)
  },
  dismissToast: id => set(state => ({ toasts: state.toasts.filter(toast => toast.id !== id) })),
  toggleSelected: id =>
    set(state => {
      const selection = new Set(state.selection)
      if (selection.has(id)) selection.delete(id)
      else selection.add(id)
      return { selection }
    }),
  setSelection: ids => set({ selection: new Set(ids) }),
  clearSelection: () => set({ selection: new Set() }),
  setQuery: query => set({ query }),
  toggleType: type =>
    set(state => {
      const types = new Set(state.types)
      if (types.has(type)) types.delete(type)
      else types.add(type)
      return { types }
    }),
  toggleLowMastery: () => set(state => ({ lowMastery: !state.lowMastery })),
  setTag: tag =>
    set(state => {
      const next = tag && state.tag !== tag ? tag : null
      return { tag: next, filters: { ...state.filters, tags: next ? [next] : state.filters.tags.filter(item => item !== state.tag) } }
    }),
  setFilters: filters => set(state => ({ filters, tag: state.tag && filters.tags.includes(state.tag) ? state.tag : null })),
  clearFilters: () => set(state => ({ types: new Set(), lowMastery: false, tag: null, query: '', filters: withFiltersCleared(state.filters) })),
  setSort: sort => set({ sort }),
  setGroup: group => set({ group }),
  set: patch => set(patch),
}))
