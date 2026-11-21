import { beforeEach, describe, expect, it } from 'vitest'

import { useLibraryStore } from '@/stores/library'
import { fileNow, settle, slowLibrary } from '@/test/feedback/slow'

// A click on a star, a move or a delete changes the list at once; the Drive catches up afterwards.

let slow: ReturnType<typeof slowLibrary>

const store = () => useLibraryStore.getState()
const note = async (name: string) => (await store().createFile({ name, type: 'class', status: 'ready', folderId: null }, `# ${name}`)).id

beforeEach(() => {
  slow = slowLibrary()
})

describe('o que o clique muda aparece antes de o Drive responder', () => {
  it('favoritar: a estrela muda na hora, sem esperar a gravação', async () => {
    const id = await note('Limites')
    const release = slow.hold()
    const saving = store().updateFile(id, { favorite: true })
    expect(fileNow(id)?.favorite).toBe(true)
    release()
    await saving
    expect(fileNow(id)?.favorite).toBe(true)
  })

  it('mover: a nota já está na pasta nova antes de a gravação acabar', async () => {
    const folder = await store().createFolder({ name: 'Cálculo' })
    const id = await note('Limites')
    const release = slow.hold()
    const moving = store().moveFiles([id], folder.id)
    expect(fileNow(id)?.folderId).toBe(folder.id)
    release()
    await moving
    expect(slow.sidecars.get(id)?.meta.folderId).toBe(folder.id)
  })

  it('se a gravação falha, a lista volta ao que era (e o erro chega a quem chamou)', async () => {
    const id = await note('Limites')
    const release = slow.hold()
    slow.breakWith(new Error('Drive fora do ar'))
    const saving = store().updateFile(id, { favorite: true })
    const failed = saving.then(
      () => null,
      error => (error as Error).message,
    )
    expect(fileNow(id)?.favorite).toBe(true)
    release()
    expect(await failed).toBe('Drive fora do ar')
    expect(fileNow(id)?.favorite).toBe(false)
  })

  it('pasta: favoritar e renomear aparecem na hora', async () => {
    const folder = await store().createFolder({ name: 'Cálculo' })
    const release = slow.hold()
    const saving = store().updateFolder(folder.id, { favorite: true, name: 'Cálculo I' })
    const now = store().folders.find(item => item.id === folder.id)
    expect(now).toMatchObject({ favorite: true, name: 'Cálculo I' })
    release()
    await saving
  })

  it('apagar vários: todos saem da lista de uma vez, antes da primeira gravação acabar', async () => {
    const ids = [await note('A'), await note('B'), await note('C')]
    const release = slow.hold()
    const trashing = store().trashFiles(ids)
    for (const id of ids) expect(fileNow(id)?.deletedAt).toBeTruthy()
    release()
    await trashing
    for (const id of ids) expect(slow.sidecars.get(id)?.meta.deletedAt).toBeTruthy()
  })

  it('apagar vários e a gravação do segundo falha: só o que não foi gravado volta', async () => {
    const ids = [await note('A'), await note('B')]
    const original = slow.repo.saveFile
    let calls = 0
    slow.repo.saveFile = async (sidecar, content) => {
      if (++calls === 2) throw new Error('sem rede')
      return original(sidecar, content)
    }
    await expect(store().trashFiles(ids)).rejects.toThrow('sem rede')
    await settle()
    expect(fileNow(ids[0])?.deletedAt).toBeTruthy()
    expect(fileNow(ids[1])?.deletedAt).toBeFalsy()
  })

  it('restaurar da lixeira: o item sai da lixeira na hora', async () => {
    const id = await note('Limites')
    await store().trashFiles([id])
    const release = slow.hold()
    const restoring = store().restoreFile(id)
    expect(fileNow(id)?.deletedAt).toBeFalsy()
    release()
    await restoring
  })

  it('apagar de vez: o item some da lista na hora', async () => {
    const id = await note('Limites')
    await store().trashFiles([id])
    const release = slow.hold()
    const removing = store().deleteFileForever(id)
    expect(fileNow(id)).toBeUndefined()
    release()
    await removing
    expect(slow.writes.removeFile).toBe(1)
  })

  it('apagar de vez e o Drive falha: a nota volta para a lixeira', async () => {
    const id = await note('Limites')
    await store().trashFiles([id])
    slow.repo.removeFile = async () => {
      throw new Error('sem rede')
    }
    await expect(store().deleteFileForever(id)).rejects.toThrow('sem rede')
    expect(fileNow(id)?.deletedAt).toBeTruthy()
  })
})
