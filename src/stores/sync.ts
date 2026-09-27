import { create } from 'zustand'

import type { DeviceRecord } from '@/types/domain'
import { currentDevice } from '@/lib/device'
import { nowIso } from '@/lib/ids'
import { DriveRepository } from '@/lib/storage/drive-repository'
import type { Conflict, StorageUsage } from '@/lib/storage/repository'
import { useLibraryStore } from '@/stores/library'

export const SYNC_INTERVAL_MS = 5 * 60 * 1000
export const ONLINE_WINDOW_MS = 10 * 60 * 1000

export interface PendingConflict {
  id: number
  conflict: Conflict
  resolve(resolved: Conflict): void
}

interface SyncState {
  lastSyncAt: number | null
  busy: boolean
  error: string | null
  devices: DeviceRecord[]
  usage: StorageUsage | null
  conflicts: PendingConflict[]
  conflictsHidden: boolean
  showConflicts(): void
  hideConflicts(): void
  start(): void
  stop(): void
  syncNow(): Promise<void>
  refreshUsage(): Promise<void>
  askConflict(conflict: Conflict): Promise<Conflict>
  settleConflict(id: number, resolved: Conflict): void
  removeThisDevice(): Promise<void>
}

let timer = 0
let conflictSeq = 0

export function isOnline(device: DeviceRecord, now = Date.now()): boolean {
  return now - Date.parse(device.lastSeen) <= ONLINE_WINDOW_MS
}

export const useSyncStore = create<SyncState>((set, get) => ({
  lastSyncAt: null,
  busy: false,
  error: null,
  devices: [],
  usage: null,
  conflicts: [],
  conflictsHidden: false,

  showConflicts: () => set({ conflictsHidden: false }),
  hideConflicts: () => set({ conflictsHidden: true }),

  start: () => {
    window.clearInterval(timer)
    set({ lastSyncAt: null, error: null, devices: [], usage: null })
    const repo = useLibraryStore.getState().repo
    repo?.setConflictResolver(conflict => get().askConflict(conflict))
    if (repo instanceof DriveRepository) {
      void get().syncNow()
      timer = window.setInterval(() => void get().syncNow(), SYNC_INTERVAL_MS)
    } else {
      set({ lastSyncAt: Date.now() })
      void get().refreshUsage()
    }
  },

  stop: () => window.clearInterval(timer),

  syncNow: async () => {
    const repo = useLibraryStore.getState().repo
    if (!repo || get().busy) return
    set({ busy: true, error: null })
    try {
      const { snapshot, changedFileIds } = await repo.pullChanges()
      useLibraryStore.getState().applySnapshot(snapshot, changedFileIds)
      if (repo instanceof DriveRepository) {
        const device = currentDevice()
        await repo.heartbeat({ id: device.id, name: device.name, lastSeen: nowIso(), accountId: repo.accountId })
        set({ devices: await repo.listDevices() })
      }
      set({ lastSyncAt: Date.now() })
      await get().refreshUsage()
    } catch (error) {
      set({ error: error instanceof Error ? error.message : 'A sincronização falhou.' })
    } finally {
      set({ busy: false })
    }
  },

  refreshUsage: async () => {
    const repo = useLibraryStore.getState().repo
    if (!repo) return
    try {
      set({ usage: await repo.usage() })
    } catch {
      return
    }
  },

  askConflict: conflict =>
    new Promise(resolve => {
      const id = ++conflictSeq
      set(state => ({ conflicts: [...state.conflicts, { id, conflict, resolve }], conflictsHidden: false }))
    }),

  settleConflict: (id, resolved) => {
    const pending = get().conflicts.find(item => item.id === id)
    set(state => ({ conflicts: state.conflicts.filter(item => item.id !== id) }))
    pending?.resolve(resolved)
  },

  removeThisDevice: async () => {
    const repo = useLibraryStore.getState().repo
    if (repo instanceof DriveRepository) await repo.removeDevice(currentDevice().id).catch(() => undefined)
  },
}))
