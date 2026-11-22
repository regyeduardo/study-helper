// História 9 (spec 003, R16, T029): Local é por conta; o perfil sem login continua em `study-helper-local`; ao entrar, ele pode virar o Local da conta sem enviar nada.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import 'fake-indexeddb/auto'

import { newFileMeta, newFolderMeta, newSidecar } from '@/lib/defaults'
import { CombinedRepository } from '@/lib/storage/combined-repository'
import { LocalRepository } from '@/lib/storage/local-repository'
import { bringLocalToAccount } from '@/lib/storage/transfer'
import { useLibraryStore } from '@/stores/library'
import { FakeDrive, installMemoryStorage, uniqueAccount } from '@/test/storage/fake-drive'

const token = vi.fn(async () => 'tok')
const library = () => useLibraryStore.getState()

let drive: FakeDrive
let account: string

beforeEach(() => {
  installMemoryStorage()
  drive = new FakeDrive().install()
  account = uniqueAccount()
})

describe('Local por conta', () => {
  it('na conta Google, o que fica em Local vai para `study-helper-local-<conta>`', async () => {
    await library().connect(account, token)
    expect(library().repo).toBeInstanceOf(CombinedRepository)
    const rascunhos = await library().createFolder({ name: 'Rascunhos', place: 'local' })
    await library().createFile({ name: 'Ideias soltas', type: 'class', folderId: rascunhos.id }, 'ideias')
    const own = await new LocalRepository(`study-helper-local-${account}`, account).load()
    expect(own.folders.map(folder => folder.name)).toEqual(['Rascunhos'])
    expect(own.files.map(file => file.name)).toEqual(['Ideias soltas'])
    expect([...drive.files.values()].some(file => /Rascunhos|Ideias/.test(file.name))).toBe(false)
  })

  it('o perfil sem login continua em `study-helper-local`, sem Google Drive', async () => {
    await library().connect('local')
    expect(library().repo).toBeInstanceOf(LocalRepository)
    expect(library().repo!.kind).toBe('local')
  })
})

describe('trazer o perfil sem login como Local da conta', () => {
  it('copia pastas e notas para o Local da conta, sem enviar nada ao Drive, e o perfil continua como estava', async () => {
    const profile = new LocalRepository()
    await profile.load()
    const folder = newFolderMeta({ name: 'Física II' })
    await profile.saveFolder(folder)
    const note = newFileMeta({ name: 'Queda livre', type: 'class', folderId: folder.id })
    await profile.saveFile(newSidecar(note), 'g = 9,8')
    const loose = newFileMeta({ name: 'Lembrete', type: 'class', folderId: null })
    await profile.saveFile(newSidecar(loose), 'comprar caderno')
    await library().connect(account, token)
    const sentBefore = drive.files.size
    const seen: { done: number; total: number; current: string }[] = []
    expect(await bringLocalToAccount(update => seen.push(update))).toBe(3)
    // the window counts the copy item by item, with the one in hand
    expect(seen).toEqual([
      { done: 0, total: 3, current: 'Física II' },
      { done: 1, total: 3, current: expect.any(String) },
      { done: 2, total: 3, current: expect.any(String) },
    ])
    expect(drive.files.size).toBe(sentBefore)
    const repo = library().repo as CombinedRepository
    expect(repo.sideOf(folder.id)).toBe('local')
    expect(repo.sideOf(note.id)).toBe('local')
    expect(library().folders.find(item => item.id === folder.id)?.place).toBe('local')
    expect(library().files.find(item => item.id === loose.id)?.place).toBe('local')
    expect(await repo.readContent(note.id)).toBe('g = 9,8')
    // the profile is untouched
    expect((await new LocalRepository().load()).files.map(file => file.name).sort()).toEqual(['Lembrete', 'Queda livre'])
  })
})
