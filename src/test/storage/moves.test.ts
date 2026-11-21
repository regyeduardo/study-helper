// História 9 (spec 003, FR-054, SC-017): mudar de lugar segue o diário; o item só sai da origem depois de conferido no destino; retomar não perde nem duplica.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import 'fake-indexeddb/auto'

import type { FileMeta, FolderMeta } from '@/types/domain'
import { newFileMeta, newFolderMeta, newSidecar } from '@/lib/defaults'
import { CombinedRepository } from '@/lib/storage/combined-repository'
import { DriveRepository } from '@/lib/storage/drive-repository'
import { LocalRepository } from '@/lib/storage/local-repository'
import { MoveJournal, type MoveRecord, planMoves, retryFailed, runMoves } from '@/lib/storage/moves'
import { FakeDrive, installMemoryStorage, uniqueAccount } from '@/test/storage/fake-drive'

const token = vi.fn(async () => 'tok')

let drive: FakeDrive
let account: string
let repo: CombinedRepository
let journal: MoveJournal

const names = (items: { name: string }[]) => items.map(item => item.name).sort()
const driveNames = () => [...drive.files.values()].map(file => file.name)
const size = () => 10

async function library() {
  const snapshot = await repo.load()
  return { folders: snapshot.folders, files: snapshot.files }
}

async function plan(ids: string[], to: 'drive' | 'local') {
  const records = planMoves(repo, await library(), ids, to, 'lote-1', size)
  for (const record of records) await journal.put(record)
  return records
}

/** Projeto Aurora (Drive) with 3 notes; Contratos inside it with 1 note. */
async function aurora() {
  const folder = newFolderMeta({ name: 'Projeto Aurora' })
  const contratos = newFolderMeta({ name: 'Contratos', parentId: folder.id })
  await repo.saveFolder(folder)
  await repo.saveFolder(contratos)
  const notes: FileMeta[] = []
  for (const name of ['Reunião de kickoff', 'Ata do kickoff', 'Reunião de 13/11']) {
    const meta = newFileMeta({ name, type: 'class', folderId: folder.id })
    await repo.saveFile(newSidecar(meta), `texto de ${name}`)
    notes.push(meta)
  }
  const contrato = newFileMeta({ name: 'Contrato do fornecedor', type: 'class', folderId: contratos.id })
  await repo.saveFile(newSidecar(contrato), 'cláusulas')
  return { folder, contratos, notes, contrato }
}

beforeEach(async () => {
  installMemoryStorage()
  drive = new FakeDrive().install()
  account = uniqueAccount()
  repo = new CombinedRepository(new DriveRepository(account, token, 'drive'), new LocalRepository(`study-helper-local-${account}`, account))
  journal = new MoveJournal(account)
  await repo.load()
})

describe('levar uma pasta do Drive para Local', () => {
  it('leva a pasta, as pastas e as notas de dentro; a contagem é a mesma; nada fica nos dois lugares', async () => {
    const { folder } = await aurora()
    const before = await library()
    await repo.saveFolder({ ...before.folders.find(item => item.id === folder.id)!, place: 'local' })
    const records = await plan([folder.id], 'local')
    // folders first, from the top, so the notes have where to go
    expect(records.slice(0, 2).map(record => `${record.kind}:${record.name}`)).toEqual(['folder:Projeto Aurora', 'folder:Contratos'])
    expect(names(records.slice(2))).toEqual(['Ata do kickoff', 'Contrato do fornecedor', 'Reunião de 13/11', 'Reunião de kickoff'])
    const done = await runMoves(repo, journal, await library())
    expect(done.every(record => record.state === 'feito')).toBe(true)
    const after = await library()
    expect(names(after.files)).toEqual(names(before.files))
    expect(names(after.folders)).toEqual(names(before.folders))
    expect(driveNames().some(name => /Aurora|Contratos|kickoff|fornecedor/.test(name))).toBe(false)
    expect(await repo.readContent(after.files.find(file => file.name === 'Contrato do fornecedor')!.id)).toBe('cláusulas')
    expect(repo.sideOf(folder.id)).toBe('local')
  })

  it('a nota de dentro com escolha própria de ficar no Drive não muda e não se perde com a pasta', async () => {
    const { folder, notes } = await aurora()
    const stays = notes[0]
    await repo.saveFile(newSidecar({ ...stays, place: 'drive' }))
    await repo.saveFolder({ ...folder, place: 'local' })
    await plan([folder.id], 'local')
    const done = await runMoves(repo, journal, await library())
    expect(done.map(record => record.name)).not.toContain(stays.name)
    expect(done.every(record => record.state === 'feito')).toBe(true)
    expect(repo.sideOf(stays.id)).toBe('drive')
    expect(await repo.readContent(stays.id)).toBe(`texto de ${stays.name}`)
    // it sits in the Drive's nearest folder above, and in its real folder in this browser
    const seen = (await library()).files.find(file => file.id === stays.id)!
    expect(seen.folderId).toBe(folder.id)
  })
})

describe('parar no meio e retomar', () => {
  it('fechar a aba depois de copiar uma nota: ao abrir de novo, continua de onde parou, sem duplicar', async () => {
    const { folder } = await aurora()
    await repo.saveFolder({ ...folder, place: 'local' })
    await plan([folder.id], 'local')
    let steps = 0
    await runMoves(repo, journal, await library(), { stopAfter: (record: MoveRecord) => record.kind === 'file' && record.state === 'conferido' && ++steps === 2 })
    const middle = await journal.all()
    expect(middle.some(record => record.state === 'conferido')).toBe(true)
    // the library open in the middle shows each note once
    const halfway = await library()
    expect(new Set(halfway.files.map(file => file.id)).size).toBe(halfway.files.length)
    expect(halfway.files).toHaveLength(4)
    // reopening: a new repository and journal on the same browser and Drive
    repo = new CombinedRepository(new DriveRepository(account, token, 'drive'), new LocalRepository(`study-helper-local-${account}`, account))
    journal = new MoveJournal(account)
    const { showingOf } = await import('@/lib/storage/moves')
    repo.setShowing(showingOf(await journal.all()))
    await repo.load()
    const done = await runMoves(repo, journal, await library())
    expect(done.every(record => record.state === 'feito')).toBe(true)
    const after = await library()
    expect(after.files).toHaveLength(4)
    expect(driveNames().some(name => /kickoff|13_11|13\/11|fornecedor/.test(name))).toBe(false)
  })
})

describe('quando falha', () => {
  it('a nota fica inteira na origem, com o motivo; "Tentar de novo" termina a mudança', async () => {
    const meta = newFileMeta({ name: 'Plano 2027', type: 'class', folderId: null })
    await repo.saveFile(newSidecar(meta), 'plano')
    const write = vi.spyOn(repo.local, 'saveFile').mockRejectedValueOnce(new Error('Sem espaço neste navegador.'))
    await plan([meta.id], 'local')
    const failed = await runMoves(repo, journal, await library())
    expect(failed[0]).toMatchObject({ state: 'falhou', reason: 'Sem espaço neste navegador.' })
    expect(repo.sideOf(meta.id)).toBe('drive')
    expect(await repo.readContent(meta.id)).toBe('plano')
    write.mockRestore()
    await retryFailed(journal)
    const done = await runMoves(repo, journal, await library())
    expect(done[0].state).toBe('feito')
    expect(repo.sideOf(meta.id)).toBe('local')
    expect(await repo.readContent(meta.id)).toBe('plano')
  })

  it('uma pasta do Drive que ainda tem algo dentro nunca é apagada', async () => {
    const { folder, contratos } = await aurora()
    await repo.saveFolder({ ...folder, place: 'local' })
    const records = await plan([folder.id], 'local')
    // the Contratos note fails: its folder and the folder above keep their Drive copies
    const contratoId = records.find(record => record.name === 'Contrato do fornecedor')!.id
    const real = repo.local.saveFile.bind(repo.local)
    vi.spyOn(repo.local, 'saveFile').mockImplementation(async (sidecar, content) => {
      if (sidecar.meta.id === contratoId) throw new Error('falhou de propósito')
      return real(sidecar, content)
    })
    const done = await runMoves(repo, journal, await library())
    expect(done.find(record => record.id === contratos.id)?.state).toBe('falhou')
    expect(done.find(record => record.id === folder.id)?.state).toBe('falhou')
    expect(await repo.readContent(contratoId)).toBe('cláusulas')
    expect(driveNames()).toContain('Contratos')
  })
})

describe('Sincronizar: de Local para o Google Drive', () => {
  it('a pasta em Local e as notas dela vão para o Drive e deixam de estar só neste navegador', async () => {
    const rascunhos: FolderMeta = newFolderMeta({ name: 'Rascunhos', place: 'local' })
    await repo.saveFolder(rascunhos)
    const ideia = newFileMeta({ name: 'Ideias soltas', type: 'class', folderId: rascunhos.id })
    await repo.saveFile(newSidecar(ideia), 'ideias')
    await repo.saveFolder({ ...rascunhos, place: 'drive' })
    await plan([rascunhos.id], 'drive')
    const done = await runMoves(repo, journal, await library())
    expect(done.every(record => record.state === 'feito')).toBe(true)
    expect(repo.sideOf(rascunhos.id)).toBe('drive')
    expect(repo.sideOf(ideia.id)).toBe('drive')
    expect(driveNames()).toEqual(expect.arrayContaining(['Rascunhos', 'Ideias soltas.md']))
    expect((await repo.local.load()).files).toHaveLength(0)
    // another device sees them
    const other = new CombinedRepository(new DriveRepository(account, token, 'drive'), new LocalRepository(`study-helper-local-${account}-b`, account))
    expect(names((await other.load()).files)).toEqual(['Ideias soltas'])
  })
})
