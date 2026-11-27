// Spec 007 (T047, medida do celular de 26/11): num aparelho novo, o limite do Drive salvo logo ao abrir voltava vazio uns segundos
// depois, e a pergunta "Quanto o app pode usar do seu Drive?" abria de novo. Uma sincronização que leu o índice antes de o "Salvar"
// terminar o entregava depois, e o índice velho tomava o lugar do salvo (a proteção só valia com a gravação ainda em andamento).
// Agora o índice de uma leitura que começou antes de uma gravação deste aparelho terminar é o gravado; uma leitura que começa depois
// traz o que está guardado, inclusive o que outro aparelho mudou.
import 'fake-indexeddb/auto'
import { describe, expect, it } from 'vitest'

import type { LibraryIndex } from '@/types/domain'
import { CombinedRepository } from '@/lib/storage/combined-repository'
import { LocalRepository } from '@/lib/storage/local-repository'

const LIMIT = 5 * 1024 ** 3

function library() {
  const drive = new LocalRepository(`teste-drive-${crypto.randomUUID()}`, 'conta')
  const combined = new CombinedRepository(drive, new LocalRepository(`teste-local-${crypto.randomUUID()}`, 'conta'))
  return { drive, combined }
}

const withLimit = (index: LibraryIndex, bytes: number): LibraryIndex => ({ ...index, settings: { ...index.settings, storageLimitBytes: bytes } })

/** The Drive's next pull reads at once and answers only when `open` is called. */
function heldPull(drive: LocalRepository): () => void {
  let open!: () => void
  const gate = new Promise<void>(resolve => (open = resolve))
  const read = drive.pullChanges.bind(drive)
  drive.pullChanges = async () => {
    const changes = await read()
    await gate
    return changes
  }
  return open
}

describe('o índice salvo neste aparelho e a sincronização que já estava no ar', () => {
  it('a sincronização que leu antes de salvar entrega o índice salvo, não o de antes', async () => {
    const { drive, combined } = library()
    const opened = await combined.load()
    expect(opened.index.settings.storageLimitBytes).toBeNull()
    const open = heldPull(drive)
    const pulling = combined.pullChanges()
    await new Promise(resolve => setTimeout(resolve, 20))
    await combined.saveIndex(withLimit(opened.index, LIMIT))
    open()
    expect((await pulling).snapshot.index.settings.storageLimitBytes).toBe(LIMIT)
  })

  it('a carga que leu antes de salvar também', async () => {
    const { drive, combined } = library()
    const opened = await combined.load()
    let open!: () => void
    const gate = new Promise<void>(resolve => (open = resolve))
    const read = drive.load.bind(drive)
    drive.load = async () => {
      const snapshot = await read()
      await gate
      return snapshot
    }
    const loading = combined.load()
    await new Promise(resolve => setTimeout(resolve, 20))
    await combined.saveIndex(withLimit(opened.index, LIMIT))
    open()
    expect((await loading).index.settings.storageLimitBytes).toBe(LIMIT)
  })

  it('a sincronização que começa depois de salvar traz o que está guardado, inclusive o que outro aparelho mudou', async () => {
    const { drive, combined } = library()
    const opened = await combined.load()
    await combined.saveIndex(withLimit(opened.index, LIMIT))
    // another device changed the limit after this one saved
    await drive.saveIndex(withLimit(opened.index, 2 * LIMIT))
    expect((await combined.pullChanges()).snapshot.index.settings.storageLimitBytes).toBe(2 * LIMIT)
  })
})
