import { create } from 'zustand'

import type { Attempt, FileType, ShareKind, StoredQuestion } from '@/types/domain'
import { isNarrowScreen } from '@/hooks/use-is-narrow'
import { clearFilters as withFiltersCleared, type LibraryFilters, NO_FILTERS } from '@/lib/library-filters'

export type Overlay =
  | { kind: 'palette' }
  | { kind: 'new'; folderId?: string | null }
  | { kind: 'record' }
  | { kind: 'media' }
  | { kind: 'settings'; tab?: SettingsTab }
  | { kind: 'exam'; fileId: string }
  | { kind: 'cards'; fileId: string; deckId?: string }
  | { kind: 'mindmap'; fileId: string; artifactId?: string }
  /** `conversationId`: that conversation; `null`: a new one; absent: the last one. */
  | { kind: 'tutor'; fileId: string; conversationId?: string | null }
  /** "+ Novo" of a map or a deck; `again`: the one made before ("Gerar de novo"). */
  | { kind: 'generate-artifact'; fileId: string; artifact: 'mapa' | 'cartoes'; again?: string }
  | { kind: 'ata-parts'; fileId: string; again?: string }
  | { kind: 'generate'; fileId: string; agent: 'meeting' | 'lesson'; redo?: boolean; again?: string }
  /** "Gerar desta entrada": what makes sense for its kind and for what it keeps. */
  | { kind: 'generate-entry'; fileId: string }
  | { kind: 'transcribe'; fileId: string }
  | { kind: 'folder-exam'; folderId: string | null; fileIds?: string[] }
  | { kind: 'account'; x?: number; y?: number }
  | { kind: 'new-folder'; parentId: string | null }
  | { kind: 'rename'; target: 'file' | 'folder'; id: string }
  | { kind: 'move'; fileIds: string[]; folderIds: string[] }
  | { kind: 'confirm'; title: string; text: string; ok: string; danger?: boolean; onConfirm: () => void | Promise<void>; alt?: { label: string; onConfirm: () => void | Promise<void> } }
  /** "Apagar" with the family tree when the item has descendants; `fileIds`: a whole selection, by the same choice. */
  | { kind: 'delete-family'; fileId: string; fileIds?: string[] }
  | { kind: 'explain'; fileId: string; excerpt: string }
  | { kind: 'order'; folderId: string }
  | { kind: 'activity' }
  | { kind: 'import' }
  | { kind: 'send-local' }
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
  toast(text: string): void
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
  toast: text => {
    const id = ++toastSeq
    set(state => ({ toasts: [...state.toasts, { id, text }] }))
    setTimeout(() => set(state => ({ toasts: state.toasts.filter(toast => toast.id !== id) })), TOAST_MS)
  },
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
