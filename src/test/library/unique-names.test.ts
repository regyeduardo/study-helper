// FR-021 (spec 005, 25/11): "no mesmo diretório não pode existir nem pasta de nome igual nem arquivo". Na mesma pasta (a Biblioteca
// também) não há duas pastas nem duas notas com o mesmo nome; maiúsculas e espaços nas pontas não diferenciam; a Lixeira não conta. O que
// a pessoa faz (criar, renomear, mover, importar) é bloqueado dizendo qual; o que o próprio app faz nunca falha por nome: a pasta que ele
// cria pelo nome é a que já existe, e a nota que ele nomeia ganha " (2)".
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import 'fake-indexeddb/auto'

import type { FileMeta, FolderMeta, SharedFile, SharedFolder, SharedItem } from '@/types/domain'
import { moveItems } from '@/components/library/use-file-actions'
import { newFileMeta, newFolderMeta, newSidecar } from '@/lib/defaults'
import { freeName, moveConflict, nameKey, NameTakenError } from '@/lib/names'
import type { Blocker } from '@/lib/blocking'
import { importConflict, importSharedEntry, importSharedItem } from '@/lib/share'
import { LocalRepository } from '@/lib/storage/local-repository'
import { useLibraryStore } from '@/stores/library'
import { installMemoryStorage } from '@/test/storage/fake-drive'

let repo: LocalRepository
let vp6: FolderMeta
let hm: FolderMeta
let outra: FolderMeta

const note = (name: string, folderId: string | null, fields: Partial<FileMeta> = {}) => newFileMeta({ name, type: 'reading', folderId, ...fields })

async function seed(files: FileMeta[], folders: FolderMeta[] = []) {
  for (const folder of [vp6, hm, outra, ...folders]) await repo.saveFolder(folder)
  for (const file of files) await repo.saveFile(newSidecar(file), '')
  useLibraryStore.setState({ repo, sharedView: null, ready: true, folders: [vp6, hm, outra, ...folders], files, opened: {}, openedAt: {}, sizes: {} })
}

const library = () => useLibraryStore.getState()
const stored = async () => repo.load()
const namesIn = (folderId: string | null) =>
  library()
    .files.filter(file => file.folderId === folderId && !file.deletedAt)
    .map(file => file.name)
    .sort()
const foldersIn = (parentId: string | null) =>
  library()
    .folders.filter(folder => folder.parentId === parentId && !folder.deletedAt)
    .map(folder => folder.name)
    .sort()

const blocker = (): Blocker => ({ cancelled: false, progress: vi.fn() }) as unknown as Blocker

beforeEach(async () => {
  installMemoryStorage()
  repo = new LocalRepository(`study-helper-local-test-${crypto.randomUUID()}`)
  await repo.load()
  vp6 = newFolderMeta({ name: 'VP6' })
  hm = newFolderMeta({ name: 'HM', parentId: vp6.id })
  outra = newFolderMeta({ name: 'Outra' })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('o que conta como o mesmo nome', () => {
  it('maiúsculas e espaços nas pontas não diferenciam; acentos sim', () => {
    expect(nameKey(' hm ')).toBe(nameKey('HM'))
    expect(nameKey('Ação')).not.toBe(nameKey('acao'))
  })

  it('o nome livre: " (2)", depois " (3)"; um nome que já tem número segue dele', () => {
    const taken = new Set(['ata', 'ata (2)'])
    const isTaken = (name: string) => taken.has(nameKey(name))
    expect(freeName('Ata', isTaken)).toBe('Ata (3)')
    expect(freeName('Ata (2)', isTaken)).toBe('Ata (3)')
    expect(freeName('Aula', isTaken)).toBe('Aula')
  })
})

describe('pastas', () => {
  it('criar pela pessoa com um nome que já existe ali: bloqueado, dizendo qual, e nada é gravado', async () => {
    await seed([])
    await expect(library().createFolder({ name: ' hm ', parentId: vp6.id }, 'block')).rejects.toThrow('Já existe uma pasta chamada "HM" em VP6.')
    expect(foldersIn(vp6.id)).toEqual(['HM'])
    expect((await stored()).folders.filter(folder => folder.parentId === vp6.id)).toHaveLength(1)
  })

  it('o mesmo nome em outra pasta pode, e a que está na Lixeira não conta', async () => {
    const velha = newFolderMeta({ name: 'Notas', parentId: vp6.id, deletedAt: '2026-11-20T10:00:00.000Z' })
    await seed([], [velha])
    await library().createFolder({ name: 'HM', parentId: outra.id }, 'block')
    await library().createFolder({ name: 'Notas', parentId: vp6.id }, 'block')
    expect(foldersIn(outra.id)).toEqual(['HM'])
    expect(foldersIn(vp6.id)).toEqual(['HM', 'Notas'])
  })

  it('na Biblioteca (a raiz) também', async () => {
    await seed([])
    await expect(library().createFolder({ name: 'vp6', parentId: null }, 'block')).rejects.toThrow('Já existe uma pasta chamada "VP6" na Biblioteca.')
  })

  it('a pasta que o app cria pelo nome é a que já existe', async () => {
    await seed([])
    const folder = await library().createFolder({ name: 'HM', parentId: vp6.id })
    expect(folder.id).toBe(hm.id)
    expect(foldersIn(vp6.id)).toEqual(['HM'])
    expect((await stored()).folders).toHaveLength(3)
  })

  it('uma pasta nova que o app numera (um curso de mesmo nome) ganha " (2)"', async () => {
    await seed([])
    const folder = await library().createFolder({ name: 'HM', parentId: vp6.id }, 'number')
    expect(folder.name).toBe('HM (2)')
    expect(foldersIn(vp6.id)).toEqual(['HM', 'HM (2)'])
  })

  it('renomear para um nome que já existe ali: bloqueado, e o nome fica', async () => {
    const pp = newFolderMeta({ name: 'PP', parentId: vp6.id })
    await seed([], [pp])
    await expect(library().updateFolder(pp.id, { name: 'Hm' }, 'block')).rejects.toThrow('Já existe uma pasta chamada "HM" em VP6.')
    expect(foldersIn(vp6.id)).toEqual(['HM', 'PP'])
    expect((await stored()).folders.find(folder => folder.id === pp.id)?.name).toBe('PP')
  })

  it('renomear a própria pasta só nas maiúsculas pode', async () => {
    await seed([])
    await library().updateFolder(hm.id, { name: 'Hm' }, 'block')
    expect(foldersIn(vp6.id)).toEqual(['Hm'])
  })

  it('voltar da Lixeira para onde já há uma de mesmo nome: volta com " (2)"', async () => {
    const velha = newFolderMeta({ name: 'HM', parentId: vp6.id, deletedAt: '2026-11-20T10:00:00.000Z' })
    await seed([], [velha])
    await library().restoreFolder(velha.id)
    expect(foldersIn(vp6.id)).toEqual(['HM', 'HM (2)'])
  })
})

describe('notas', () => {
  it('a nota que o app cria com um nome que já existe ali ganha " (2)", depois " (3)"', async () => {
    await seed([note('Ata · Reunião', hm.id)])
    const second = await library().createFile({ name: 'Ata · Reunião', type: 'meeting', folderId: hm.id }, '')
    const third = await library().createFile({ name: 'ata · reunião', type: 'meeting', folderId: hm.id }, '')
    expect([second.name, third.name]).toEqual(['Ata · Reunião (2)', 'ata · reunião (3)'])
    expect(namesIn(hm.id)).toEqual(['Ata · Reunião', 'Ata · Reunião (2)', 'ata · reunião (3)'])
  })

  it('criar pela pessoa (importar um arquivo) com um nome que já existe ali: bloqueado, e nada é gravado', async () => {
    await seed([note('Contrato', hm.id)])
    await expect(library().createFile({ name: 'Contrato', type: 'reading', folderId: hm.id }, 'texto', 'block')).rejects.toThrow('Já existe uma nota chamada "Contrato" em HM.')
    expect(namesIn(hm.id)).toEqual(['Contrato'])
    expect((await stored()).files).toHaveLength(1)
  })

  it('uma pasta e uma nota de mesmo nome podem ficar juntas', async () => {
    await seed([])
    await library().createFile({ name: 'HM', type: 'reading', folderId: vp6.id }, '', 'block')
    expect(namesIn(vp6.id)).toEqual(['HM'])
  })

  it('renomear pela pessoa para um nome que já existe ali: bloqueado, e o nome fica', async () => {
    const a = note('Resumo', null)
    const b = note('Aula 1', null)
    await seed([a, b])
    await expect(library().updateFile(b.id, { name: 'RESUMO ' }, 'block')).rejects.toThrow('Já existe uma nota chamada "Resumo" na Biblioteca.')
    expect(namesIn(null)).toEqual(['Aula 1', 'Resumo'])
    expect((await repo.readSidecar(b.id)).meta.name).toBe('Aula 1')
  })

  it('o nome que o app dá a uma nota (o título da geração) ganha " (2)" quando já existe ali', async () => {
    const a = note('Aula: juros', hm.id)
    const b = note('Gerando…', hm.id)
    await seed([a, b])
    await library().updateFile(b.id, { name: 'Aula: juros' })
    await library().saveContent(a.id, 'texto', { name: 'Aula: juros' })
    expect(namesIn(hm.id)).toEqual(['Aula: juros', 'Aula: juros (2)'])
  })

  it('voltar da Lixeira para onde já há uma de mesmo nome: volta com " (2)"', async () => {
    const velha = note('Resumo', hm.id, { deletedAt: '2026-11-20T10:00:00.000Z' })
    await seed([note('Resumo', hm.id), velha])
    await library().restoreFile(velha.id)
    expect(namesIn(hm.id)).toEqual(['Resumo', 'Resumo (2)'])
  })

  it('ir para a Lixeira não confere nome', async () => {
    const a = note('Resumo', hm.id)
    await seed([a, note('Resumo', hm.id, { deletedAt: '2026-11-20T10:00:00.000Z' })])
    await library().trashFiles([a.id])
    expect(namesIn(hm.id)).toEqual([])
  })
})

describe('mover', () => {
  it('uma nota para uma pasta com uma de mesmo nome: bloqueado, dizendo qual, e nada se move', async () => {
    const aqui = note('Resumo', outra.id)
    await seed([aqui, note('resumo', hm.id)])
    await expect(library().moveFiles([aqui.id], hm.id)).rejects.toThrow('Já existe uma nota chamada "resumo" em HM.')
    expect(library().files.find(file => file.id === aqui.id)?.folderId).toBe(outra.id)
    expect((await repo.readSidecar(aqui.id)).meta.folderId).toBe(outra.id)
  })

  it('várias de uma vez: se uma não cabe, nenhuma vai', async () => {
    const livre = note('Aula 1', outra.id)
    const repetida = note('Resumo', outra.id)
    await seed([livre, repetida, note('Resumo', hm.id)])
    await expect(moveItems(blocker(), [livre.id, repetida.id], [], hm.id)).rejects.toThrow('Já existe uma nota chamada "Resumo" em HM.')
    expect(namesIn(hm.id)).toEqual(['Resumo'])
    expect(namesIn(outra.id)).toEqual(['Aula 1', 'Resumo'])
  })

  it('duas de mesmo nome indo para o mesmo lugar: bloqueado', async () => {
    const a = note('Resumo', outra.id)
    const b = note('Resumo', vp6.id)
    await seed([a, b])
    await expect(moveItems(blocker(), [a.id, b.id], [], hm.id)).rejects.toThrow('Duas das notas escolhidas se chamam "Resumo" e não podem ficar juntas em HM.')
    expect(namesIn(hm.id)).toEqual([])
  })

  it('uma pasta para dentro de outra que já tem uma de mesmo nome: bloqueado', async () => {
    const solta = newFolderMeta({ name: 'hm', parentId: outra.id })
    await seed([], [solta])
    await expect(moveItems(blocker(), [], [solta.id], vp6.id)).rejects.toThrow('Já existe uma pasta chamada "HM" em VP6.')
    expect(library().folders.find(folder => folder.id === solta.id)?.parentId).toBe(outra.id)
  })

  it('o que cabe vai, como antes', async () => {
    const a = note('Aula 1', outra.id)
    await seed([a, note('Resumo', hm.id)])
    expect(await moveItems(blocker(), [a.id], [], hm.id)).toBe(1)
    expect(namesIn(hm.id)).toEqual(['Aula 1', 'Resumo'])
  })

  it('a conferência sozinha diz a primeira que não cabe, ou nada', () => {
    const a = note('Resumo', outra.id)
    const b = note('Resumo', hm.id)
    expect(moveConflict([a, b], [vp6, hm, outra], [a.id], [], hm.id)).toBeInstanceOf(NameTakenError)
    expect(moveConflict([a, b], [vp6, hm, outra], [a.id], [], vp6.id)).toBeNull()
  })
})

describe('importar um link', () => {
  const LINK = 'LinkLinkLinkLinkLink1'
  const folder = (id: string, name: string, parentId: string | null = null): SharedFolder => ({ id, name, parentId, position: 0, isCourse: false, description: '' })
  const shared = (kind: SharedItem['kind'], folders: SharedFolder[], files: (Partial<SharedFile> & { name: string })[]): SharedItem => ({
    kind,
    title: 'Link',
    version: 2,
    id: LINK,
    createdAt: '2026-11-25T10:00:00.000Z',
    expiresAt: '2099-11-28T10:00:00.000Z',
    folders,
    files: files.map((file, index) => ({ id: `f${index}`, folderId: null, type: 'reading', position: index, description: '', tags: [], content: '', questions: [], highlights: [], ...file })),
  })
  const actions = () => ({ createFolder: library().createFolder, createFile: library().createFile, updateSidecar: library().updateSidecar })
  const entrada = () => shared('entrada', [], [{ name: 'Reunião', meta: { role: 'entrada' } }, { name: 'Ata · Reunião', meta: { parentFileId: 'f0' } }])

  it('uma entrada para uma pasta onde já há uma nota de mesmo nome: diz qual antes de baixar ou gravar, e nada é criado', async () => {
    await seed([note('reunião', hm.id)])
    expect(importConflict(entrada(), hm.id, library().files, library().folders)?.message).toBe('Já existe uma nota chamada "reunião" em HM.')
    await expect(importSharedEntry(entrada(), {}, actions(), { folderId: hm.id, existing: library().files })).rejects.toThrow('Já existe uma nota chamada "reunião" em HM.')
    expect(namesIn(hm.id)).toEqual(['reunião'])
  })

  it('o mesmo link de novo: a entrada vem como "(cópia 1)" e as notas dela ganham " (2)", sem bloquear', async () => {
    const first = note('Reunião', hm.id, { sharedFrom: LINK })
    await seed([first, note('Ata · Reunião', hm.id, { parentFileId: first.id })])
    expect(importConflict(entrada(), hm.id, library().files, library().folders)).toBeNull()
    await importSharedEntry(entrada(), {}, actions(), { folderId: hm.id, existing: library().files })
    expect(namesIn(hm.id)).toEqual(['Ata · Reunião', 'Ata · Reunião (2)', 'Reunião', 'Reunião (cópia 1)'])
  })

  it('uma pasta com o nome de uma que já está na Biblioteca: diz qual, e nada é criado', async () => {
    await seed([])
    const item = shared('folder', [folder('r', 'vp6')], [{ name: 'Nota', folderId: 'r' }])
    expect(importConflict(item, null, library().files, library().folders)?.message).toBe('Já existe uma pasta chamada "VP6" na Biblioteca.')
    await expect(importSharedItem(item, {}, actions())).rejects.toThrow('Já existe uma pasta chamada "VP6" na Biblioteca.')
    expect(foldersIn(null)).toEqual(['Outra', 'VP6'])
    expect(library().files).toEqual([])
  })

  it('uma nota com o nome de uma que já está na Biblioteca: diz qual, e nada é criado', async () => {
    await seed([note('Resumo', null)])
    const item = shared('file', [], [{ name: 'resumo ' }])
    expect(importConflict(item, null, library().files, library().folders)?.message).toBe('Já existe uma nota chamada "Resumo" na Biblioteca.')
    await expect(importSharedItem(item, {}, actions())).rejects.toThrow('Já existe uma nota chamada "Resumo" na Biblioteca.')
    expect(namesIn(null)).toEqual(['Resumo'])
  })

  it('o que cabe entra como antes; uma pasta repetida dentro do próprio link vira uma só, e a nota repetida ganha " (2)"', async () => {
    await seed([])
    const item = shared('folder', [folder('r', 'Curso'), folder('a', 'Módulo', 'r'), folder('b', 'módulo', 'r')], [
      { name: 'Aula', folderId: 'a' },
      { name: 'Aula', folderId: 'b' },
    ])
    expect(importConflict(item, null, library().files, library().folders)).toBeNull()
    await importSharedItem(item, {}, actions())
    const curso = library().folders.find(item => item.name === 'Curso')!
    expect(foldersIn(curso.id)).toEqual(['Módulo'])
    const modulo = library().folders.find(item => item.parentId === curso.id)!
    expect(namesIn(modulo.id)).toEqual(['Aula', 'Aula (2)'])
  })
})
