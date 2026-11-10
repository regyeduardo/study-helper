import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import 'fake-indexeddb/auto'

import type { FileMeta, FileSidecar, Snapshot, SourceMeta } from '@/types/domain'
import { newFileMeta, newFolderMeta, newSidecar } from '@/lib/defaults'
import { isNote } from '@/lib/family'
import { BACKUP_ID, migrateEntries } from '@/lib/entry-migration'
import { DriveRepository } from '@/lib/storage/drive-repository'
import { LocalRepository } from '@/lib/storage/local-repository'
import type { Repository } from '@/lib/storage/repository'
import { useLibraryStore } from '@/stores/library'
import { FakeDrive, installMemoryStorage, readBlob, uniqueAccount } from '@/test/storage/fake-drive'

const token = vi.fn(async () => 'tok')

const LINK: SourceMeta = { input: 'url', name: 'Limites, por Khan', url: 'https://exemplo.com/limites', storage: 'none' }
const PDF: SourceMeta = { input: 'file', name: 'derivadas.pdf', sizeBytes: 2048, mime: 'application/pdf', storage: 'drive', storedFileId: 'drv-pdf', expiresAt: null }
const RECORDED: SourceMeta = { input: 'recording', name: 'Reunião 14-10-2026.webm', sizeBytes: 900, mime: 'audio/webm', durationSeconds: 60, storage: 'drive', storedFileId: 'drv-rec', expiresAt: null }
const PASTED: SourceMeta = { input: 'text', name: 'texto colado', sizeBytes: 120, mime: 'text/plain', storage: 'none' }
const TOPIC: SourceMeta = { input: 'topic', name: 'Teorema do valor médio', storage: 'none' }

const at = (day: number) => ({ at: `2026-10-${String(day).padStart(2, '0')}T10:00:00.000Z`, deviceId: 'd1', deviceName: 'Notebook · Chrome' })

function note(name: string, fields: Partial<FileMeta> = {}): FileSidecar {
  return newSidecar(newFileMeta({ name, type: 'class', created: at(1), updated: at(1), ...fields }))
}

async function localRepo(): Promise<LocalRepository> {
  const repo = new LocalRepository(`study-helper-local-test-${crypto.randomUUID()}`)
  await repo.load()
  return repo
}

async function seed(repo: Repository, sidecars: FileSidecar[]): Promise<Snapshot> {
  for (const sidecar of sidecars) await repo.saveFile(sidecar, `# ${sidecar.meta.name}`)
  return repo.load()
}

/** Every call the migration makes to the repository, in order. */
function watched(repo: Repository) {
  const calls: string[] = []
  for (const name of ['putSource', 'saveFile', 'saveIndex', 'removeFile', 'removeSource'] as const) {
    const real = (repo[name] as (...args: unknown[]) => Promise<unknown>).bind(repo)
    ;(repo as unknown as Record<string, unknown>)[name] = async (...args: unknown[]) => {
      calls.push(name === 'saveFile' ? `saveFile:${(args[0] as FileSidecar).meta.id}` : name)
      return real(...args)
    }
  }
  return calls
}

const entradas = (files: FileMeta[]) => files.filter(file => file.role === 'entrada')
const byId = (files: FileMeta[], id: string) => files.find(file => file.id === id)!

beforeEach(() => {
  installMemoryStorage()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('a cópia é gravada antes de tudo', () => {
  it('um JSON de todos os metadados, pelo repositório, antes de qualquer mudança', async () => {
    const repo = await localRepo()
    const folder = newFolderMeta({ name: 'Cálculo' })
    await repo.saveFolder(folder)
    const before = await seed(repo, [note('Aula de limites', { origin: LINK, folderId: folder.id })])
    const calls = watched(repo)
    const putSource = vi.spyOn(repo, 'putSource')
    await migrateEntries(repo, before)
    expect(calls[0]).toBe('putSource')
    expect(calls.slice(1).every(call => call !== 'putSource')).toBe(true)
    const [fileId, blob, name] = putSource.mock.calls[0] as unknown as Parameters<Repository['putSource']>
    expect(fileId).toBe(BACKUP_ID)
    expect(name).toMatch(/\.json$/)
    const copy = JSON.parse(await readBlob(blob)) as Snapshot
    expect(copy.files).toEqual(before.files)
    expect(copy.folders).toEqual(before.folders)
    expect(copy.index).toEqual(before.index)
  })

  it('sem a cópia, nada muda', async () => {
    const repo = await localRepo()
    const before = await seed(repo, [note('Aula de limites', { origin: LINK })])
    repo.putSource = async () => {
      throw new Error('Passou do limite de armazenamento do app')
    }
    const calls = watched(repo)
    await expect(migrateEntries(repo, before)).rejects.toThrow('limite')
    expect(calls.filter(call => call !== 'putSource')).toEqual([])
    expect((await repo.load()).files).toEqual(before.files)
  })
})

describe('nota de gravação', () => {
  it('vira a própria entrada, com o mesmo id: a transcrição fica nela e a Ata continua ligada', async () => {
    const repo = await localRepo()
    const recording = note('Reunião de kickoff', { type: 'reading', origin: RECORDED })
    recording.transcript = 'Ana: vamos lançar em maio.'
    recording.recording = { blocks: [{ speaker: 'ana', start: 0, end: 3, text: 'vamos lançar em maio.' }], speakers: [{ id: 'ana', name: 'Ana', suggested: false }], marks: [] }
    const ata = note('Ata: Reunião de kickoff', { type: 'meeting', parentFileId: recording.meta.id, origin: { input: 'text', name: 'Reunião de kickoff', storage: 'none' } })
    const result = await migrateEntries(repo, await seed(repo, [recording, ata]))

    expect(entradas(result.files).map(file => file.id)).toEqual([recording.meta.id])
    expect(byId(result.files, recording.meta.id)).toMatchObject({ role: 'entrada', kept: 'arquivo', origin: RECORDED, name: 'Reunião de kickoff', updated: at(1) })
    expect(byId(result.files, ata.meta.id).parentFileId).toBe(recording.meta.id)
    const stored = await repo.readSidecar(recording.meta.id)
    expect(stored.transcript).toBe('Ana: vamos lançar em maio.')
    expect(stored.recording).toEqual(recording.recording)
    expect(await repo.readContent(recording.meta.id)).toBe('# Reunião de kickoff')
  })

  it('a mídia guardada só no navegador conta como arquivo guardado; sem nada guardado, fica só o registro', async () => {
    const repo = await localRepo()
    const inBrowser = note('Gravada aqui', { type: 'reading', origin: { ...RECORDED, storage: 'none', storedFileId: undefined } })
    const gone = note('Mídia apagada', { type: 'reading', origin: { ...RECORDED, name: 'outra.webm', storage: 'none', storedFileId: undefined, removedAt: '2026-10-20T10:00:00Z' } })
    const result = await migrateEntries(repo, await seed(repo, [inBrowser, gone]), { localMedia: [inBrowser.meta.id] })
    expect(byId(result.files, inBrowser.meta.id)).toMatchObject({ role: 'entrada', kept: 'arquivo' })
    expect(byId(result.files, gone.meta.id)).toMatchObject({ role: 'entrada', kept: 'registro' })
  })

  it('uma Aula feita de um vídeo, com transcrição e mídia guardada, continua NOTA embaixo de uma entrada nova, sem perder nada', async () => {
    const repo = await localRepo()
    const video: SourceMeta = { input: 'file', name: 'aula.mp4', sizeBytes: 5000, mime: 'video/mp4', durationSeconds: 600, storage: 'drive', storedFileId: 'drv-video', expiresAt: null }
    const lesson = note('Aula do vídeo', { type: 'class', origin: video, folderId: 'calculo', questionCount: 3, artifacts: [{ id: 'm1', kind: 'mapa', name: 'Limites', updatedAt: at(2).at }] })
    lesson.transcript = 'Professor: hoje, limites.'
    lesson.recording = { blocks: [{ speaker: 'p', start: 0, end: 4, text: 'hoje, limites.' }], speakers: [{ id: 'p', name: 'Professor', suggested: false }], marks: [] }
    const before = await seed(repo, [lesson])
    const result = await migrateEntries(repo, before, { localMedia: [lesson.meta.id] })

    const [entry] = entradas(result.files)
    expect(entry.id).not.toBe(lesson.meta.id)
    expect(entry).toMatchObject({ role: 'entrada', kept: 'arquivo', name: 'aula.mp4', folderId: 'calculo', parentFileId: null, origin: video })
    const entrySidecar = await repo.readSidecar(entry.id)
    expect(entrySidecar.transcript).toBe('Professor: hoje, limites.')
    expect(entrySidecar.recording).toEqual(lesson.recording)
    expect(await repo.readContent(entry.id)).toBe('Professor: hoje, limites.')

    const after = byId(result.files, lesson.meta.id)
    expect(after.role).toBeUndefined()
    expect(isNote(after)).toBe(true)
    expect(after).toEqual({ ...byId(before.files, lesson.meta.id), parentFileId: entry.id })
    const kept = await repo.readSidecar(lesson.meta.id)
    expect(kept.transcript).toBe('Professor: hoje, limites.')
    expect(kept.recording).toEqual(lesson.recording)
    expect(await repo.readContent(lesson.meta.id)).toBe('# Aula do vídeo')
  })

  it('a nota de reunião antiga, com a Ata dentro, é a própria gravação: vira a entrada, com a Ata dentro', async () => {
    const repo = await localRepo()
    const meeting = note('Reunião de março', { type: 'meeting', origin: RECORDED })
    meeting.transcript = 'Ana: vamos lançar em maio.'
    const result = await migrateEntries(repo, await seed(repo, [meeting]))
    expect(entradas(result.files).map(file => file.id)).toEqual([meeting.meta.id])
    expect(await repo.readContent(meeting.meta.id)).toBe('# Reunião de março')
  })

  it('uma nota de vídeo cujo texto é a própria transcrição vira a entrada; uma Leitura com texto próprio do mesmo vídeo fica embaixo dela', async () => {
    const repo = await localRepo()
    const video: SourceMeta = { input: 'file', name: 'palestra.mp4', sizeBytes: 7000, mime: 'video/mp4', storage: 'none' }
    const transcribed = note('Palestra', { type: 'reading', origin: video })
    transcribed.transcript = 'Palestrante: bom dia.'
    const reading = note('Leitura da palestra', { type: 'reading', origin: video, created: at(4) })
    await seed(repo, [transcribed, reading])
    await repo.saveFile(transcribed, 'Palestrante: bom dia.')
    const result = await migrateEntries(repo, await repo.load())
    expect(entradas(result.files).map(file => file.id)).toEqual([transcribed.meta.id])
    expect(byId(result.files, reading.meta.id)).toMatchObject({ parentFileId: transcribed.meta.id })
    expect(isNote(byId(result.files, reading.meta.id))).toBe(true)
  })

  it('uma nota feita de um vídeo, sem o vídeo nem a transcrição, continua nota, embaixo de uma entrada só com o registro', async () => {
    const repo = await localRepo()
    const lesson = note('Aula do vídeo', { type: 'class', origin: { input: 'file', name: 'aula.mp4', sizeBytes: 5000, mime: 'video/mp4', storage: 'none' } })
    const result = await migrateEntries(repo, await seed(repo, [lesson]))
    const [entry] = entradas(result.files)
    expect(entry).toMatchObject({ name: 'aula.mp4', kept: 'registro' })
    expect(byId(result.files, lesson.meta.id)).toMatchObject({ parentFileId: entry.id, origin: lesson.meta.origin })
    expect(byId(result.files, lesson.meta.id).role).toBeUndefined()
  })
})

describe('notas da mesma fonte ficam na mesma entrada', () => {
  it('uma entrada por fonte, na pasta da nota mais antiga, com a origem e o nível do que foi guardado', async () => {
    const repo = await localRepo()
    const aula = note('Aula de limites', { origin: LINK, folderId: 'calculo', created: at(2) })
    const explicacao = note('Explicação de limites', { type: 'explanation', origin: LINK, folderId: 'revisao', created: at(5) })
    const derivadas = note('Derivadas', { origin: PDF, folderId: 'calculo' })
    const colado = note('Resumo colado', { origin: PASTED })
    const tema = note('Valor médio', { type: 'explanation', origin: TOPIC })
    const result = await migrateEntries(repo, await seed(repo, [aula, explicacao, derivadas, colado, tema]))

    const found = entradas(result.files)
    expect(found).toHaveLength(4)
    const link = found.find(file => file.origin?.url === LINK.url)!
    expect(link).toMatchObject({ name: LINK.name, folderId: 'calculo', kept: 'registro', origin: LINK, type: 'reading', parentFileId: null, created: at(2) })
    expect(byId(result.files, aula.meta.id).parentFileId).toBe(link.id)
    expect(byId(result.files, explicacao.meta.id).parentFileId).toBe(link.id)
    expect(found.find(file => file.origin?.input === 'file')).toMatchObject({ kept: 'arquivo', origin: PDF, name: 'derivadas.pdf' })
    expect(found.find(file => file.origin?.input === 'text')).toMatchObject({ kept: 'registro', name: 'texto colado' })
    expect(found.find(file => file.origin?.input === 'topic')).toMatchObject({ kept: 'registro', name: TOPIC.name })
    // the entradas are in the repository, not only in the answer
    expect(entradas((await repo.load()).files).map(file => file.id).sort()).toEqual(found.map(file => file.id).sort())
  })
})

describe('o que fica de fora', () => {
  it('import, shared, nota sem fonte, nota filha e nota na Lixeira não ganham entrada', async () => {
    const repo = await localRepo()
    const imported = note('Importada', { origin: { input: 'import', name: 'notas.zip', storage: 'none' } })
    const shared = note('Compartilhada', { origin: { input: 'shared', name: 'link', storage: 'none' } })
    const written = note('Escrita direto')
    const mother = note('Mãe', { origin: LINK })
    const child = note('Filha', { parentFileId: mother.meta.id, origin: { input: 'text', name: 'Mãe', storage: 'none' } })
    const diagnosis = note('Diagnóstico', { origin: { input: 'text', name: 'diagnóstico da prova da pasta', storage: 'none' } })
    const trashed = note('Na Lixeira', { origin: { ...LINK, url: 'https://exemplo.com/outro' }, deletedAt: '2026-10-30T10:00:00Z' })
    const before = await seed(repo, [imported, shared, written, mother, child, diagnosis, trashed])
    const result = await migrateEntries(repo, before)
    expect(entradas(result.files)).toHaveLength(1)
    for (const left of [imported, shared, written, child, diagnosis, trashed]) expect(byId(result.files, left.meta.id)).toEqual(byId(before.files, left.meta.id))
  })

  it('o origin da nota nunca é apagado', async () => {
    const repo = await localRepo()
    const aula = note('Aula de limites', { origin: LINK })
    const derivadas = note('Derivadas', { origin: PDF })
    const result = await migrateEntries(repo, await seed(repo, [aula, derivadas]))
    expect(byId(result.files, aula.meta.id).origin).toEqual(LINK)
    expect((await repo.readSidecar(derivadas.meta.id)).meta.origin).toEqual(PDF)
  })
})

describe('repetir não duplica', () => {
  it('entriesMigratedAt impede repetir: a segunda vez não grava nada', async () => {
    const repo = await localRepo()
    const first = await migrateEntries(repo, await seed(repo, [note('Aula de limites', { origin: LINK })]))
    expect(first.index.entriesMigratedAt).toBeTruthy()
    expect((await repo.load()).index.entriesMigratedAt).toBe(first.index.entriesMigratedAt)
    const calls = watched(repo)
    const again = await migrateEntries(repo, await repo.load())
    expect(calls).toEqual([])
    expect(entradas(again.files)).toHaveLength(1)
  })

  it('uma biblioteca sem nada a mudar só marca a migração, sem cópia', async () => {
    const repo = await localRepo()
    const calls = watched(repo)
    const result = await migrateEntries(repo, await seed(repo, []))
    expect(calls).toEqual(['saveIndex'])
    expect(result.index.entriesMigratedAt).toBeTruthy()
  })

  it('refazer depois de uma falha no meio encontra as mesmas entradas pelo id', async () => {
    const repo = await localRepo()
    const aula = note('Aula de limites', { origin: LINK })
    const explicacao = note('Explicação de limites', { origin: LINK, created: at(3) })
    const derivadas = note('Derivadas', { origin: PDF })
    const before = await seed(repo, [aula, explicacao, derivadas])
    const save = repo.saveFile.bind(repo)
    let saves = 0
    repo.saveFile = async (sidecar, content) => {
      if (++saves === 3) throw new Error('sem rede')
      return save(sidecar, content)
    }
    await expect(migrateEntries(repo, before)).rejects.toThrow('sem rede')
    expect((await repo.load()).index.entriesMigratedAt).toBeUndefined()

    repo.saveFile = save
    const result = await migrateEntries(repo, await repo.load())
    const found = entradas(result.files)
    expect(found).toHaveLength(2)
    expect(new Set(result.files.map(file => file.id)).size).toBe(result.files.length)
    for (const id of [aula.meta.id, explicacao.meta.id]) expect(byId(result.files, id).parentFileId).toBe(found.find(file => file.origin?.url === LINK.url)!.id)
    expect(entradas((await repo.load()).files)).toHaveLength(2)
  })
})

async function driveRepo(account: string): Promise<DriveRepository> {
  const repo = new DriveRepository(account, token)
  await repo.load()
  return repo
}

describe('dois aparelhos', () => {
  it('migrando ao mesmo tempo, não duplicam nenhuma entrada', async () => {
    new FakeDrive().install()
    const first = await driveRepo(uniqueAccount('a'))
    const aula = note('Aula de limites', { origin: LINK })
    const explicacao = note('Explicação de limites', { origin: LINK })
    const derivadas = note('Derivadas', { origin: PDF })
    for (const sidecar of [aula, explicacao, derivadas]) await first.saveFile(sidecar, 'x')
    const a = await driveRepo(uniqueAccount('a'))
    const b = await driveRepo(uniqueAccount('b'))
    const seenByA = await a.load()
    const seenByB = await b.load()
    await migrateEntries(a, seenByA)
    await migrateEntries(b, seenByB)

    const files = (await driveRepo(uniqueAccount('c'))).load().then(snapshot => snapshot.files)
    const all = await files
    expect(entradas(all)).toHaveLength(2)
    expect(new Set(all.map(file => file.id)).size).toBe(all.length)
    const link = entradas(all).find(file => file.origin?.url === LINK.url)!
    expect(byId(all, aula.meta.id).parentFileId).toBe(link.id)
    expect(byId(all, explicacao.meta.id).parentFileId).toBe(link.id)
  })

  it('o outro aparelho, gravando o índice depois, não apaga a marca da migração', async () => {
    new FakeDrive().install()
    const account = uniqueAccount('a')
    const a = await driveRepo(account)
    await a.saveFile(note('Aula de limites', { origin: LINK }), 'x')
    const b = await driveRepo(uniqueAccount('b'))
    const stale = await b.load()
    const done = await migrateEntries(a, await a.load())
    await b.saveIndex({ ...stale.index, tags: ['cálculo'] })
    const index = (await (await driveRepo(uniqueAccount('c'))).load()).index
    expect(index.entriesMigratedAt).toBe(done.index.entriesMigratedAt)
    expect(index.tags).toEqual(['cálculo'])
  })
})

describe('a biblioteca migra ao abrir', () => {
  it('connect grava as entradas e mostra a família já ligada', async () => {
    new FakeDrive().install()
    const account = uniqueAccount('loja')
    const aula = note('Aula de limites', { origin: LINK })
    await (await driveRepo(account)).saveFile(aula, 'x')
    await useLibraryStore.getState().connect(account, token)
    const { files, index } = useLibraryStore.getState()
    const [entry] = entradas(files)
    expect(entry).toMatchObject({ origin: LINK, kept: 'registro' })
    expect(byId(files, aula.meta.id).parentFileId).toBe(entry.id)
    expect(index.entriesMigratedAt).toBeTruthy()
  })

  it('uma falha na migração não impede a biblioteca de abrir', async () => {
    new FakeDrive().install()
    const account = uniqueAccount('loja')
    await (await driveRepo(account)).saveFile(note('Aula de limites', { origin: LINK }), 'x')
    vi.spyOn(DriveRepository.prototype, 'putSource').mockRejectedValue(new Error('sem rede'))
    await useLibraryStore.getState().connect(account, token)
    const state = useLibraryStore.getState()
    expect(state.ready).toBe(true)
    expect(state.loadError).toBeNull()
    expect(state.files).toHaveLength(1)
    expect(entradas(state.files)).toEqual([])
    expect(state.index.entriesMigratedAt).toBeUndefined()
    vi.restoreAllMocks()
  })
})
