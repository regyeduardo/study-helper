import { create } from 'zustand'

import type { FileType } from '@/types/domain'
import { isNarrowScreen } from '@/hooks/use-is-narrow'

export type Overlay =
  | { kind: 'palette' }
  | { kind: 'new'; folderId?: string | null }
  | { kind: 'record' }
  | { kind: 'settings'; tab?: SettingsTab }
  | { kind: 'exam'; fileId: string }
  | { kind: 'folder-exam'; folderId: string | null; fileIds?: string[] }
  | { kind: 'account' }
  | { kind: 'new-folder'; parentId: string | null }
  | { kind: 'rename'; target: 'file' | 'folder'; id: string }
  | { kind: 'move'; fileIds: string[]; folderIds: string[] }
  | { kind: 'confirm'; title: string; text: string; ok: string; danger?: boolean; onConfirm: () => void | Promise<void> }
  | { kind: 'explain'; fileId: string; excerpt: string }
  | { kind: 'order'; folderId: string }
  | { kind: 'activity' }
  | { kind: 'import' }
  | { kind: 'send-local' }
  | { kind: 'storage-limit' }

export type SettingsTab = 'appearance' | 'ai' | 'transcription' | 'storage' | 'devices' | 'general'

export type SortKey = 'recent' | 'title' | 'mastery'
export type GroupKey = 'none' | 'type' | 'folder'
export type InspectorTab = 'toc' | 'notes' | 'info'

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

interface UiState {
  overlay: Overlay | null
  menu: ItemMenu | null
  toasts: Toast[]
  selection: Set<string>
  query: string
  types: Set<FileType>
  lowMastery: boolean
  tag: string | null
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
  reorder: boolean
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
  clearFilters(): void
  setSort(sort: SortKey): void
  setGroup(group: GroupKey): void
  set(patch: Partial<Pick<UiState, 'leftOpen' | 'rightOpen' | 'drawer' | 'inspectorTab' | 'peekId' | 'columnsPane' | 'columnsSheet' | 'focusPop' | 'reorder'>>): void
}

let toastSeq = 0
const TOAST_MS = 2600

export const useUiStore = create<UiState>((set, get) => ({
  overlay: null,
  menu: null,
  toasts: [],
  selection: new Set(),
  query: '',
  types: new Set(),
  lowMastery: false,
  tag: null,
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
  reorder: false,

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
  setTag: tag => set({ tag: tag && get().tag !== tag ? tag : null }),
  clearFilters: () => set({ types: new Set(), lowMastery: false, tag: null, query: '' }),
  setSort: sort => set({ sort }),
  setGroup: group => set({ group }),
  set: patch => set(patch),
}))
