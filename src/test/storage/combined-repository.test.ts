// História 9 (spec 003, R16): Google Drive e Local numa árvore só; cada gravação vai para o lugar do item; Local não sai do navegador.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import 'fake-indexeddb/auto'

import type { FolderMeta } from '@/types/domain'
import { newFileMeta, newFolderMeta, newSidecar } from '@/lib/defaults'
import { CombinedRepository } from '@/lib/storage/combined-repository'
import { DriveRepository } from '@/lib/storage/drive-repository'
import { LocalRepository } from '@/lib/storage/local-repository'
import { FakeDrive, installMemoryStorage, uniqueAccount } from '@/test/storage/fake-drive'

const token = vi.fn(async () => 'tok')

let drive: FakeDrive
let account: string

/** One device: the account's Drive plus this browser's Local of the account. */
function device(name = 'a') {
  const driveRepo = new DriveRepository(account, token, 'drive')
  const local = new LocalRepository(`study-helper-local-${account}-${name}`, account)
  return { repo: new CombinedRepository(driveRepo, local), driveRepo, local }
}

const folder = (fields: Partial<FolderMeta> & { name: string }) => newFolderMeta(fields)
const driveNames = () => [...drive.files.values()].map(file => file.name)

beforeEach(() => {
  installMemoryStorage()
  drive = new FakeDrive().install()
  account = uniqueAccount()
})

describe('uma árvore só', () => {
  it('pastas e notas do Drive e de Local aparecem juntas; o índice é o do Drive', async () => {
    const { repo, local } = device()
    await repo.load()
    const faculdade = folder({ name: 'Faculdade' })
    const rascunhos = folder({ name: 'Rascunhos', place: 'local' })
    await repo.saveFolder(faculdade)
    await repo.saveFolder(rascunhos)
    await repo.saveFile(newSidecar(newFileMeta({ name: 'Lista 3', type: 'class', folderId: faculdade.id })), 'lista')
    await repo.saveFile(newSidecar(newFileMeta({ name: 'Ideias soltas', type: 'class', folderId: rascunhos.id })), 'ideias')
    const snapshot = await repo.load()
    expect(snapshot.folders.map(item => item.name).sort()).toEqual(['Faculdade', 'Rascunhos'])
    expect(snapshot.files.map(item => item.name).sort()).toEqual(['Ideias soltas', 'Lista 3'])
    expect(repo.sideOf(rascunhos.id)).toBe('local')
    expect((await local.load()).files.map(item => item.name)).toEqual(['Ideias soltas'])
  })

  it('o que está em Local nunca vai para o Drive: nem a pasta, nem a nota, nem o texto', async () => {
    const { repo } = device()
    await repo.load()
    const rascunhos = folder({ name: 'Rascunhos secretos', place: 'local' })
    await repo.saveFolder(rascunhos)
    const ideia = newFileMeta({ name: 'Ideia do TCC', type: 'class', folderId: rascunhos.id })
    await repo.saveFile(newSidecar(ideia), 'texto só daqui')
    expect(driveNames().some(name => name.includes('Rascunhos secretos') || name.includes('Ideia do TCC'))).toBe(false)
    expect(await repo.readContent(ideia.id)).toBe('texto só daqui')
  })

  it('outro aparelho na mesma conta vê o que está no Drive e não vê o que está em Local', async () => {
    const a = device('a')
    await a.repo.load()
    await a.repo.saveFolder(folder({ name: 'Faculdade' }))
    await a.repo.saveFolder(folder({ name: 'Rascunhos', place: 'local' }))
    const b = device('b')
    expect((await b.repo.load()).folders.map(item => item.name)).toEqual(['Faculdade'])
  })
})

describe('cada gravação vai para o lugar do item', () => {
  it('nota nova numa pasta em Local nasce em Local; numa pasta do Drive, no Drive', async () => {
    const { repo } = device()
    await repo.load()
    const rascunhos = folder({ name: 'Rascunhos', place: 'local' })
    const faculdade = folder({ name: 'Faculdade' })
    await repo.saveFolder(rascunhos)
    await repo.saveFolder(faculdade)
    const here = newFileMeta({ name: 'Aqui', type: 'class', folderId: rascunhos.id })
    const there = newFileMeta({ name: 'Lá', type: 'class', folderId: faculdade.id })
    await repo.saveFile(newSidecar(here), 'a')
    await repo.saveFile(newSidecar(there), 'b')
    expect(repo.sideOf(here.id)).toBe('local')
    expect(repo.sideOf(there.id)).toBe('drive')
  })

  it('mudar a escolha de um item que já existe não o leva sozinho: ele só muda pelo diário de mudança', async () => {
    const { repo } = device()
    await repo.load()
    const meta = newFileMeta({ name: 'Lista 3', type: 'class', folderId: null })
    await repo.saveFile(newSidecar(meta), 'lista')
    await repo.saveFile(newSidecar({ ...meta, place: 'local' }))
    expect(repo.sideOf(meta.id)).toBe('drive')
  })

  it('o arquivo de uma nota em Local fica neste navegador e abre de novo', async () => {
    const { repo } = device()
    await repo.load()
    const rascunhos = folder({ name: 'Rascunhos', place: 'local' })
    await repo.saveFolder(rascunhos)
    const meta = newFileMeta({ name: 'Contrato', type: 'pdf', folderId: rascunhos.id })
    await repo.saveFile(newSidecar(meta), '')
    const stored = await repo.putSource(meta.id, new Blob(['%PDF'], { type: 'application/pdf' }), 'contrato.pdf')
    expect(driveNames()).not.toContain('contrato.pdf')
    // the blob comes back from this browser (the fake IndexedDB keeps it as a plain copy)
    await expect(repo.getSource(stored.ref)).resolves.toBeTruthy()
  })
})

describe('nota no Drive dentro de pasta em Local', () => {
  it('no Drive fica na pasta do Drive mais próxima acima; neste navegador, na pasta dela', async () => {
    const a = device('a')
    await a.repo.load()
    const trabalho = folder({ name: 'Trabalho' })
    const rascunhos = folder({ name: 'Rascunhos secretos', parentId: trabalho.id, place: 'local' })
    await a.repo.saveFolder(trabalho)
    await a.repo.saveFolder(rascunhos)
    const meta = newFileMeta({ name: 'Plano 2027', type: 'class', folderId: rascunhos.id, place: 'drive' })
    await a.repo.saveFile(newSidecar(meta), 'plano')
    expect(a.repo.sideOf(meta.id)).toBe('drive')
    expect((await a.repo.load()).files.find(item => item.id === meta.id)?.folderId).toBe(rascunhos.id)
    const b = device('b')
    const seen = (await b.repo.load()).files.find(item => item.id === meta.id)!
    expect(seen.folderId).toBe(trabalho.id)
    expect(seen.awayFolderId).toBe(rascunhos.id)
    expect(driveNames().some(name => name.includes('Rascunhos secretos'))).toBe(false)
  })

  it('o mesmo vale para uma pasta do Drive dentro de uma pasta em Local', async () => {
    const a = device('a')
    await a.repo.load()
    const rascunhos = folder({ name: 'Rascunhos', place: 'local' })
    const publico = folder({ name: 'Público', parentId: rascunhos.id, place: 'drive' })
    await a.repo.saveFolder(rascunhos)
    await a.repo.saveFolder(publico)
    expect((await a.repo.load()).folders.find(item => item.id === publico.id)?.parentId).toBe(rascunhos.id)
    const seen = (await device('b').repo.load()).folders.find(item => item.id === publico.id)!
    expect(seen.parentId).toBeNull()
    expect(seen.awayParentId).toBe(rascunhos.id)
  })
})
