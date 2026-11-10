import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { FileMeta, FileSidecar, FolderMeta, SourceMeta } from '@/types/domain'
import { defaultIndex, newFileMeta, newFolderMeta, newSidecar } from '@/lib/defaults'
import { badgeOf } from '@/lib/family'
import type { Repository } from '@/lib/storage/repository'
import { useLibraryStore } from '@/stores/library'

// The store part of "Apagar" in a family (T045/T058); the window that shows the tree is a screen of its own.

const VIDEO: SourceMeta = { input: 'file', name: 'kickoff.mp4', sizeBytes: 900, mime: 'video/mp4', storage: 'drive', storedFileId: 'drv-video', expiresAt: null }

function memoryRepository(sidecars: FileSidecar[]) {
  const stored = new Map(sidecars.map(sidecar => [sidecar.meta.id, sidecar]))
  const removeSource = vi.fn(async (_ref: string) => undefined)
  const repo = {
    kind: 'local',
    accountId: 'local',
    readContent: async () => '',
    readSidecar: async (id: string) => stored.get(id)!,
    saveFile: async (sidecar: FileSidecar) => {
      stored.set(sidecar.meta.id, sidecar)
      return sidecar
    },
    removeFile: async (id: string) => void stored.delete(id),
    saveFolder: async () => undefined,
    saveIndex: async () => undefined,
    fileSizes: async () => ({}),
    removeSource,
  } as unknown as Repository
  return { repo, stored, removeSource }
}

const at = (minute: number) => ({ at: `2026-11-07T10:${String(minute).padStart(2, '0')}:00.000Z`, deviceId: 'd1', deviceName: 'Notebook' })

function item(id: string, fields: Partial<FileMeta> = {}): FileSidecar {
  return newSidecar(newFileMeta({ id, name: id, type: 'class', created: at(0), updated: at(0), ...fields }))
}

let memory: ReturnType<typeof memoryRepository>
let atas: FolderMeta
let trabalho: FolderMeta

/**
 * video (entrada, Trabalho) ─┬─ ata (Atas) ── explicacao (Trabalho)
 *                            ├─ aula (Trabalho)
 *                            └─ antiga (already in the Lixeira, deleted alone)
 * solta (no family)
 */
function seed() {
  atas = newFolderMeta({ name: 'Atas' })
  trabalho = newFolderMeta({ name: 'Trabalho' })
  const video = item('video', { role: 'entrada', kept: 'arquivo', type: 'reading', origin: VIDEO, folderId: trabalho.id })
  video.transcript = 'Marina: vamos revisar o cronograma.'
  const sidecars = [
    video,
    item('ata', { type: 'meeting', parentFileId: 'video', folderId: atas.id }),
    item('explicacao', { type: 'explanation', parentFileId: 'ata', folderId: trabalho.id }),
    item('aula', { parentFileId: 'video', folderId: trabalho.id }),
    item('antiga', { parentFileId: 'video', folderId: trabalho.id, deletedAt: '2026-11-01T10:00:00.000Z' }),
    item('solta', { folderId: trabalho.id }),
  ]
  memory = memoryRepository(sidecars)
  useLibraryStore.setState({ repo: memory.repo, accountId: 'local', ready: true, folders: [atas, trabalho], files: sidecars.map(sidecar => sidecar.meta), index: defaultIndex(), opened: {}, openedAt: {}, localMedia: [], sharedView: null, sizes: {} })
}

const library = () => useLibraryStore.getState()
const fileOf = (id: string) => library().files.find(file => file.id === id)!

beforeEach(seed)

describe('"Apagar tudo"', () => {
  it('leva o item e todos os descendentes, em qualquer pasta, para a Lixeira com a marca da raiz', async () => {
    await library().trashFamily('video')
    for (const id of ['video', 'ata', 'explicacao', 'aula']) expect(fileOf(id)).toMatchObject({ trashedWith: 'video', deletedAt: expect.any(String) })
    expect(memory.stored.get('explicacao')!.meta.trashedWith).toBe('video')
    expect(fileOf('solta')).toMatchObject({ deletedAt: null })
    expect(fileOf('solta').trashedWith).toBeUndefined()
  })

  it('não mexe no que já estava na Lixeira, apagado sozinho', async () => {
    await library().trashFamily('video')
    expect(fileOf('antiga')).toMatchObject({ deletedAt: '2026-11-01T10:00:00.000Z' })
    expect(fileOf('antiga').trashedWith).toBeUndefined()
  })

  it('a mídia vai junto para a Lixeira e não é apagada', async () => {
    await library().trashFamily('video')
    expect(memory.removeSource).not.toHaveBeenCalled()
    expect(fileOf('video').origin).toEqual(VIDEO)
  })
})

describe('restaurar', () => {
  it('qualquer item da família traz todos de volta juntos, sem a marca', async () => {
    await library().trashFamily('video')
    await library().restoreFile('explicacao')
    for (const id of ['video', 'ata', 'explicacao', 'aula']) {
      expect(fileOf(id).deletedAt).toBeNull()
      expect(fileOf(id).trashedWith).toBeUndefined()
    }
    expect(fileOf('ata').folderId).toBe(atas.id)
    expect(fileOf('antiga').deletedAt).toBe('2026-11-01T10:00:00.000Z')
  })

  it('com a pasta apagada, volta para a raiz da biblioteca; quem tem pasta viva fica nela', async () => {
    await library().trashFamily('video')
    useLibraryStore.setState(state => ({ folders: state.folders.map(folder => (folder.id === trabalho.id ? { ...folder, deletedAt: '2026-11-07T11:00:00.000Z' } : folder)) }))
    await library().restoreFile('video')
    expect(fileOf('video').folderId).toBeNull()
    expect(fileOf('aula').folderId).toBeNull()
    expect(fileOf('explicacao').folderId).toBeNull()
    expect(fileOf('ata').folderId).toBe(atas.id)
  })

  it('um item apagado sozinho volta sozinho, como antes', async () => {
    await library().trashFiles(['solta'])
    await library().restoreFile('solta')
    expect(fileOf('solta').deletedAt).toBeNull()
    expect(fileOf('aula').deletedAt).toBeNull()
  })
})

describe('"Apagar só esta"', () => {
  it('as filhas passam para a mãe do item, e só ele vai para a Lixeira', async () => {
    await library().trashOnly('ata')
    expect(fileOf('ata').deletedAt).toBeTruthy()
    expect(fileOf('ata').trashedWith).toBeUndefined()
    expect(fileOf('explicacao')).toMatchObject({ parentFileId: 'video', deletedAt: null, folderId: trabalho.id })
    expect(memory.stored.get('explicacao')!.meta.parentFileId).toBe('video')
  })

  it('numa entrada, que não tem mãe, as notas viram raiz; as netas ficam com a mãe delas', async () => {
    await library().trashOnly('video')
    expect(fileOf('video').deletedAt).toBeTruthy()
    expect(fileOf('aula').parentFileId).toBeNull()
    expect(fileOf('explicacao').parentFileId).toBe('ata')
  })

  it('a Ata nunca perde a entrada: fica apontando para ela na Lixeira, com o selo de mãe apagada', async () => {
    await library().trashOnly('video')
    expect(fileOf('ata')).toMatchObject({ parentFileId: 'video', deletedAt: null })
    expect(memory.stored.get('ata')!.meta.parentFileId).toBe('video')
    expect(badgeOf(library().files, fileOf('ata'))).toEqual({ mother: fileOf('video'), trashed: true })
  })

  it('restaurar a entrada religa a Ata sozinha', async () => {
    await library().trashOnly('video')
    await library().restoreFile('video')
    expect(fileOf('video').deletedAt).toBeNull()
    expect(fileOf('ata').parentFileId).toBe('video')
    expect(badgeOf(library().files, fileOf('ata'))).toEqual({ mother: fileOf('video'), trashed: false })
  })

  it('apagar a entrada para sempre mantém a Ata, com a mãe apagada', async () => {
    await library().trashOnly('video')
    await library().deleteFileForever('video')
    expect(library().files.some(file => file.id === 'video')).toBe(false)
    expect(fileOf('ata')).toMatchObject({ parentFileId: 'video', deletedAt: null })
    expect(memory.stored.has('ata')).toBe(true)
    expect(badgeOf(library().files, fileOf('ata'))).toEqual({ mother: null, trashed: true })
  })
})

describe('"Apagar só a mídia"', () => {
  it('a entrada fica, marcada como mídia apagada, com a transcrição e as notas', async () => {
    await library().removeMedia('video')
    expect(memory.removeSource).toHaveBeenCalledWith('drv-video')
    expect(fileOf('video')).toMatchObject({ deletedAt: null, role: 'entrada', origin: { name: 'kickoff.mp4', removedAt: expect.any(String) } })
    expect(fileOf('video').origin?.storedFileId).toBeUndefined()
    expect(memory.stored.get('video')!.transcript).toBe('Marina: vamos revisar o cronograma.')
    for (const id of ['ata', 'aula', 'explicacao']) expect(fileOf(id)).toMatchObject({ deletedAt: null })
    expect(fileOf('ata').parentFileId).toBe('video')
  })
})

describe('arquivo guardado que a nota e a entrada dividem (notas que já existiam)', () => {
  it('apagar a nota para sempre não apaga o arquivo da entrada; apagar o último que o usa, sim', async () => {
    const pdf: SourceMeta = { input: 'file', name: 'derivadas.pdf', sizeBytes: 10, mime: 'application/pdf', storage: 'drive', storedFileId: 'drv-pdf', expiresAt: null }
    const entry = item('pdf', { role: 'entrada', kept: 'arquivo', type: 'reading', origin: pdf })
    const nota = item('derivadas', { parentFileId: 'pdf', origin: pdf })
    memory = memoryRepository([entry, nota])
    useLibraryStore.setState({ repo: memory.repo, files: [entry.meta, nota.meta] })
    await library().deleteFileForever('derivadas')
    expect(memory.removeSource).not.toHaveBeenCalled()
    await library().deleteFileForever('pdf')
    expect(memory.removeSource).toHaveBeenCalledWith('drv-pdf')
  })
})
