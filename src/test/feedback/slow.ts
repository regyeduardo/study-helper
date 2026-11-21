import { vi } from 'vitest'

import { defaultIndex } from '@/lib/defaults'
import type { Repository } from '@/lib/storage/repository'
import { useJobsStore } from '@/stores/jobs'
import { useLibraryStore } from '@/stores/library'
import { useUiStore } from '@/stores/ui'
import type { FileSidecar, FolderMeta } from '@/types/domain'

/** A promise the test settles by hand: the slow thing (network, Drive) the click is waiting for. */
export interface Deferred<T = void> {
  promise: Promise<T>
  resolve(value: T): void
  reject(error: unknown): void
}

export function deferred<T = void>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((done, fail) => {
    resolve = done
    reject = fail
  })
  return { promise, resolve, reject }
}

/** A library whose every read and write waits for `hold()` to be released: a Drive on a bad day. */
export function slowLibrary() {
  const sidecars = new Map<string, FileSidecar>()
  const contents = new Map<string, string>()
  const folders = new Map<string, FolderMeta>()
  let gate: Deferred | null = null
  let failure: Error | null = null
  const wait = async () => {
    if (gate) await gate.promise
    if (failure) throw failure
  }
  const writes = { saveFile: 0, saveFolder: 0, removeFile: 0 }
  const repo = {
    kind: 'local',
    accountId: 'local',
    readContent: vi.fn(async (id: string) => {
      await wait()
      return contents.get(id) ?? ''
    }),
    readSidecar: vi.fn(async (id: string) => {
      await wait()
      return sidecars.get(id)!
    }),
    saveFile: vi.fn(async (sidecar: FileSidecar, content?: string) => {
      writes.saveFile++
      await wait()
      sidecars.set(sidecar.meta.id, sidecar)
      if (content !== undefined) contents.set(sidecar.meta.id, content)
      return sidecar
    }),
    saveFolder: vi.fn(async (folder: FolderMeta) => {
      writes.saveFolder++
      await wait()
      folders.set(folder.id, folder)
    }),
    removeFile: vi.fn(async (id: string) => {
      writes.removeFile++
      await wait()
      sidecars.delete(id)
      contents.delete(id)
    }),
    removeFolder: vi.fn(async () => undefined),
    removeSource: vi.fn(async () => undefined),
    saveIndex: async () => undefined,
    fileSizes: async () => ({}),
  } as unknown as Repository
  useLibraryStore.setState({ repo, accountId: 'local', ready: true, folders: [], files: [], index: defaultIndex(), opened: {}, openedAt: {}, sizes: {}, localMedia: [], sharedView: null })
  useJobsStore.setState({ jobs: [], live: {}, proposals: [] })
  useUiStore.setState({ overlay: null, menu: null, toasts: [], selection: new Set() })
  return {
    repo,
    sidecars,
    contents,
    writes,
    /** From now on the library answers only after `release()`. */
    hold() {
      gate = deferred()
      return () => {
        const open = gate
        gate = null
        open?.resolve()
      }
    },
    /** From now on the library fails with this error (after `release()`, when held). */
    breakWith(error: Error) {
      failure = error
    },
  }
}

export const jobsNow = () => useJobsStore.getState().jobs
export const running = () => jobsNow().filter(job => job.status === 'running')
export const toastsNow = () => useUiStore.getState().toasts.map(toast => toast.text)
export const fileNow = (id: string) => useLibraryStore.getState().files.find(file => file.id === id)

/** Lets the pending promises of the store settle (a few turns of the microtask queue). */
export const settle = async () => {
  for (let turn = 0; turn < 20; turn++) await Promise.resolve()
  await new Promise(resolve => setTimeout(resolve, 0))
}
