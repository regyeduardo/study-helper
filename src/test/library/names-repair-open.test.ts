// Spec 005, FR-022 (T052): o que vive só neste navegador (o perfil Local) tem as repetições de antes da regra desfeitas uma vez, ao abrir,
// com uma cópia antes (pastas e notas, sem o conteúdo) guardada neste navegador. Sem a cópia, nada muda.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import 'fake-indexeddb/auto'

import type { FileMeta, FolderMeta } from '@/types/domain'
import { newFileMeta, newFolderMeta, newSidecar } from '@/lib/defaults'
import { LocalRepository } from '@/lib/storage/local-repository'
import { useLibraryStore } from '@/stores/library'
import { useUiStore } from '@/stores/ui'
import { installMemoryStorage } from '@/test/storage/fake-drive'

const at = (iso: string) => ({ at: iso, deviceId: 'd', deviceName: 'Notebook' })
let repo: LocalRepository
let copies: Map<string, string>

/** The folder of this browser (where Mídias keeps its files), in memory. */
function installBrowserFolder(refuse = false) {
  copies = new Map()
  const folder = {
    getFileHandle: async (name: string) => ({
      createWritable: async () => {
        if (refuse) throw new DOMException('cheio', 'QuotaExceededError')
        let text = ''
        return { write: async (data: string) => void (text += data), close: async () => void copies.set(name, text) }
      },
    }),
  }
  Object.defineProperty(navigator, 'storage', { configurable: true, value: { getDirectory: async () => folder } })
}

async function seed(folders: FolderMeta[], files: FileMeta[]) {
  for (const folder of folders) await repo.saveFolder(folder)
  for (const file of files) await repo.saveFile(newSidecar(file), '')
  useLibraryStore.setState({ repo, accountId: 'local', sharedView: null, ready: true, folders, files, opened: {}, openedAt: {}, sizes: {} })
}

const vp6 = () => newFolderMeta({ id: 'vp6', name: 'VP6', created: at('2026-11-01T10:00:00Z'), updated: at('2026-11-01T10:00:00Z') })
const hm = (id: string, created: string) => newFolderMeta({ id, name: 'HM', parentId: 'vp6', created: at(created), updated: at(created) })
const note = (id: string, name: string, folderId: string, created: string) => newFileMeta({ id, name, type: 'class', folderId, created: at(created), updated: at(created) })
const library = () => useLibraryStore.getState()

beforeEach(async () => {
  installMemoryStorage()
  localStorage.clear()
  repo = new LocalRepository(`study-helper-local-test-${crypto.randomUUID()}`)
  await repo.load()
  useUiStore.setState({ toasts: [] })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('as repetições deste navegador, ao abrir', () => {
  it('junta as pastas e numera a nota mais nova, guarda a cópia antes e avisa; abrir de novo não faz de novo', async () => {
    installBrowserFolder()
    await seed([vp6(), hm('hm-a', '2026-11-02T10:00:00Z'), hm('hm-b', '2026-11-03T10:00:00Z')], [note('r-a', 'Resumo', 'hm-a', '2026-11-02T12:00:00Z'), note('r-b', 'resumo', 'hm-b', '2026-11-03T12:00:00Z')])
    expect(await library().repairNames()).toBe(2)
    const [copy] = [...copies.values()]
    expect(JSON.parse(copy)).toMatchObject({ folders: expect.arrayContaining([expect.objectContaining({ id: 'hm-b', name: 'HM', deletedAt: null })]), files: expect.arrayContaining([expect.objectContaining({ id: 'r-b', folderId: 'hm-b' })]) })
    expect(library().folders.find(folder => folder.id === 'hm-b')?.deletedAt).toBeTruthy()
    expect(library().files.find(file => file.id === 'r-b')).toMatchObject({ folderId: 'hm-a', name: 'resumo (2)' })
    expect((await repo.readSidecar('r-b')).meta).toMatchObject({ folderId: 'hm-a', name: 'resumo (2)' })
    expect(useUiStore.getState().toasts.at(-1)?.text).toBe('Juntei 1 pasta repetida e pus número em 1 nota de mesmo nome. Uma cópia de antes ficou neste navegador.')
    expect(await library().repairNames()).toBe(0)
  })

  it('sem conseguir guardar a cópia, nada muda', async () => {
    installBrowserFolder(true)
    await seed([vp6(), hm('hm-a', '2026-11-02T10:00:00Z'), hm('hm-b', '2026-11-03T10:00:00Z')], [])
    expect(await library().repairNames()).toBe(0)
    expect(library().folders.find(folder => folder.id === 'hm-b')?.deletedAt).toBeNull()
  })
})
