// Entrega 4 (spec 003, história 2): a biblioteca guardada no App é a mesma em todos os aparelhos. Mudanças em partes diferentes se
// juntam sozinhas; o mesmo trecho ou campo mudado em dois aparelhos abre a tela de conflitos de hoje (FR-016); apagar, mover e
// restaurar valem em todos, e a família apagada com "Apagar tudo" volta junta (FR-017).
import '@/test/account/storage-shim'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { mockEnv } = vi.hoisted(() => ({ mockEnv: { apiUrl: 'https://api.example.test' } }))
vi.mock('@/lib/env', () => ({ env: mockEnv }))

import type { Artifact, FileSidecar, Highlight } from '@/types/domain'
import { defaultIndex, newFileMeta, newFolderMeta, newSidecar } from '@/lib/defaults'
import { AppRepository } from '@/lib/storage/app-repository'
import type { Conflict } from '@/lib/storage/repository'
import { FakeAppServer } from '@/test/storage/fake-app-server'

let server: FakeAppServer

beforeEach(() => {
  server = new FakeAppServer()
  vi.stubGlobal('fetch', server.fetch)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

const device = () => new AppRepository('acc1')
let clock = Date.parse('2026-11-21T10:00:00Z')
const stamp = (deviceName: string) => ({ at: new Date((clock += 1000)).toISOString(), deviceId: deviceName, deviceName })
/** What the library store does on every save: a new `updated`. */
const touched = (sidecar: FileSidecar, deviceName: string): FileSidecar => ({ ...sidecar, meta: { ...sidecar.meta, updated: stamp(deviceName) } })

const highlight = (id: string, quote: string): Highlight => ({ id, kind: 'highlight', quote, text: '', color: 'yellow', startOffset: null, endOffset: null, createdAt: '2026-11-21T10:00:00Z', updatedAt: '2026-11-21T10:00:00Z' })
const deck = (id: string, front: string): Artifact => ({ id, kind: 'cartoes', name: `Cartões ${id}`, createdAt: '2026-11-21T10:00:00Z', updatedAt: '2026-11-21T10:00:00Z', cards: [{ id: `${id}-1`, front, back: 'verso', box: 1, due: '2026-11-22' }] }) as Artifact

function aula(fields: Partial<FileSidecar> = {}): FileSidecar {
  const meta = newFileMeta({ name: 'Aula 3', type: 'class', sourceExcerpt: 'o trecho de onde veio', folderId: null })
  return { ...newSidecar(meta), ...fields }
}

describe('a mesma biblioteca em todos os aparelhos', () => {
  it('guarda uma nota no App e outro aparelho abre igual, com texto, marcações, prova e artefatos', async () => {
    const a = device()
    await a.load()
    const note = aula({ highlights: [highlight('h1', 'primeira')], questions: [], artifacts: [deck('d1', 'frente')] })
    await a.saveFile(note, '# Aula 3\n\nlinha 1\nlinha 2')

    const b = device()
    const snapshot = await b.load()
    expect(snapshot.files.map(file => file.name)).toEqual(['Aula 3'])
    expect(snapshot.files[0].sourceExcerpt).toBe('o trecho de onde veio')
    expect(await b.readContent(note.meta.id)).toBe('# Aula 3\n\nlinha 1\nlinha 2')
    const sidecar = await b.readSidecar(note.meta.id)
    expect(sidecar.highlights).toEqual(note.highlights)
    expect(sidecar.artifacts).toEqual(note.artifacts)

    // o texto da origem não vai no mapa: fica na parte "source"
    const row = server.rows.get(note.meta.id)!
    expect((row.meta as { sourceExcerpt?: unknown }).sourceExcerpt ?? null).toBeNull()
    expect(server.currentPart(note.meta.id, 'source')?.content).toContain('o trecho de onde veio')
    expect(Object.keys(row.parts).sort()).toEqual(['artifacts/d1', 'highlights', 'source', 'text'])
  })

  it('mudanças em partes diferentes da mesma nota se juntam sozinhas (FR-016)', async () => {
    const a = device()
    await a.load()
    const note = aula()
    await a.saveFile(note, 'linha 1\nlinha 2')
    const b = device()
    await b.load()
    const resolverB = vi.fn(async (conflict: Conflict) => conflict)
    b.setConflictResolver(resolverB)

    await a.saveFile(touched(await a.readSidecar(note.meta.id), 'A'), 'linha 1\nlinha 2\nlinha 3 do A')
    const fromB = await b.readSidecar(note.meta.id)
    await b.saveFile(touched({ ...fromB, highlights: [highlight('h9', 'marcação do B')] }, 'B'))

    const c = device()
    await c.load()
    expect(await c.readContent(note.meta.id)).toBe('linha 1\nlinha 2\nlinha 3 do A')
    expect((await c.readSidecar(note.meta.id)).highlights.map(h => h.id)).toEqual(['h9'])
    expect(resolverB).not.toHaveBeenCalled()
  })

  it('linhas diferentes do texto mudadas nos dois aparelhos se juntam sem perguntar', async () => {
    const a = device()
    await a.load()
    const note = aula()
    await a.saveFile(note, 'um\ndois\ntrês\nquatro\ncinco')
    const b = device()
    await b.load()
    await b.readContent(note.meta.id)
    const resolver = vi.fn(async (conflict: Conflict) => conflict)
    b.setConflictResolver(resolver)
    await a.saveFile(touched(note, 'A'), 'UM do A\ndois\ntrês\nquatro\ncinco')
    await b.saveFile(touched(note, 'B'), 'um\ndois\ntrês\nquatro\nCINCO do B')
    expect(resolver).not.toHaveBeenCalled()
    expect(await device().readContent(note.meta.id)).toBe('UM do A\ndois\ntrês\nquatro\nCINCO do B')
  })

  it('o mesmo trecho mudado nos dois aparelhos abre a tela de conflitos e fica o que a pessoa escolher', async () => {
    const a = device()
    await a.load()
    const note = aula()
    await a.saveFile(note, 'título\nfrase original')
    const b = device()
    await b.load()
    await b.readContent(note.meta.id)
    const resolver = vi.fn(async (conflict: Conflict) => ({ ...conflict, resolved: 'título\nfrase que a pessoa escolheu' }) as Conflict)
    b.setConflictResolver(resolver)

    await a.saveFile(touched(note, 'A'), 'título\nfrase do A')
    await b.saveFile(touched(note, 'B'), 'título\nfrase do B')

    expect(resolver).toHaveBeenCalledTimes(1)
    const conflict = resolver.mock.calls[0][0]
    expect(conflict).toMatchObject({ kind: 'text', fileId: note.meta.id, base: 'título\nfrase original', mine: 'título\nfrase do B', theirs: 'título\nfrase do A' })
    expect(await device().readContent(note.meta.id)).toBe('título\nfrase que a pessoa escolheu')
  })

  it('o mesmo campo mudado nos dois aparelhos: a pessoa escolhe qual fica', async () => {
    const a = device()
    await a.load()
    const note = aula()
    await a.saveFile(note, 'texto')
    const b = device()
    await b.load()
    const resolver = vi.fn(async (conflict: Conflict) => (conflict.kind === 'json' ? { ...conflict, fields: conflict.fields.map(field => ({ ...field, choice: 'theirs' as const })) } : conflict))
    b.setConflictResolver(resolver)

    await a.saveFile(touched({ ...note, meta: { ...note.meta, name: 'Nome do A' } }, 'A'))
    await b.saveFile(touched({ ...note, meta: { ...note.meta, name: 'Nome do B' } }, 'B'))

    expect(resolver).toHaveBeenCalledTimes(1)
    expect(resolver.mock.calls[0][0]).toMatchObject({ kind: 'json', fields: [expect.objectContaining({ path: 'meta.name', mine: 'Nome do B', theirs: 'Nome do A' })] })
    expect((await device().load()).files[0].name).toBe('Nome do A')
  })

  it('a família apagada com "Apagar tudo" vai para a Lixeira e volta junta em outro aparelho (FR-017)', async () => {
    const a = device()
    await a.load()
    const mae = aula()
    const filha = newSidecar(newFileMeta({ name: 'Explicação', type: 'explanation', folderId: null, parentFileId: mae.meta.id }))
    await a.saveFile(mae, 'mãe')
    await a.saveFile(filha, 'filha')
    const b = device()
    await b.load()

    const trashedAt = '2026-11-21T11:00:00Z'
    for (const item of [mae, filha]) await a.saveFile(touched({ ...item, meta: { ...item.meta, deletedAt: trashedAt, trashedWith: mae.meta.id } }, 'A'))
    let pulled = await b.pullChanges()
    expect(pulled.changedFileIds.sort()).toEqual([mae.meta.id, filha.meta.id].sort())
    expect(pulled.snapshot.files.map(file => [file.name, file.deletedAt, file.trashedWith])).toEqual(
      expect.arrayContaining([
        ['Aula 3', trashedAt, mae.meta.id],
        ['Explicação', trashedAt, mae.meta.id],
      ]),
    )

    for (const item of [mae, filha]) await a.saveFile(touched({ ...item, meta: { ...item.meta, deletedAt: null, trashedWith: undefined } }, 'A'))
    pulled = await b.pullChanges()
    expect(pulled.snapshot.files.every(file => file.deletedAt === null && !file.trashedWith)).toBe(true)
    expect(pulled.snapshot.files).toHaveLength(2)
  })

  it('apagar de vez some em todos os aparelhos', async () => {
    const a = device()
    await a.load()
    const note = aula()
    await a.saveFile(note, 'texto')
    const b = device()
    await b.load()
    await a.removeFile(note.meta.id)
    const pulled = await b.pullChanges()
    expect(pulled.snapshot.files).toEqual([])
    expect(pulled.changedFileIds).toEqual([note.meta.id])
  })

  it('apagar um artefato apaga a parte dele no App', async () => {
    const a = device()
    await a.load()
    const note = aula({ artifacts: [deck('d1', 'um'), deck('d2', 'dois')] })
    await a.saveFile(note, 'texto')
    await a.saveFile(touched({ ...note, artifacts: [deck('d1', 'um')] }, 'A'))
    expect(Object.keys(server.rows.get(note.meta.id)!.parts).filter(part => part.startsWith('artifacts/'))).toEqual(['artifacts/d1'])
    expect((await device().readSidecar(note.meta.id)).artifacts?.map(item => item.id)).toEqual(['d1'])
  })

  it('pasta: o nome mudado num aparelho e o favorito no outro ficam os dois', async () => {
    const a = device()
    await a.load()
    const pasta = newFolderMeta({ name: 'Faculdade' })
    await a.saveFolder(pasta)
    const b = device()
    await b.load()
    await a.saveFolder({ ...pasta, name: 'Faculdade 2026' })
    await b.saveFolder({ ...pasta, favorite: true })
    const folders = (await device().load()).folders
    expect(folders).toHaveLength(1)
    expect(folders[0]).toMatchObject({ name: 'Faculdade 2026', favorite: true })
  })

  it('pasta de curso: o material do curso vai numa parte e volta inteiro', async () => {
    const a = device()
    await a.load()
    const curso = newFolderMeta({ name: 'Curso de Go', isCourse: true, courseDescription: 'Do zero ao servidor', courseMaterial: 'Aula 1: tipos\nAula 2: http' })
    await a.saveFolder(curso)
    expect(server.rows.get(curso.id)!.meta).not.toHaveProperty('courseMaterial', 'Aula 1: tipos\nAula 2: http')
    const [folder] = (await device().load()).folders
    expect(folder).toMatchObject({ courseDescription: 'Do zero ao servidor', courseMaterial: 'Aula 1: tipos\nAula 2: http' })
  })

  it('o índice vai para o App sem nenhuma chave de IA', async () => {
    const a = device()
    await a.load()
    const index = defaultIndex()
    index.settings.ai = { ...index.settings.ai, apiKey: 'sk-segredo' }
    index.settings.youtube = { ...index.settings.youtube, geminiApiKey: 'g-segredo' }
    index.tags = ['prova']
    await a.saveIndex(index)
    expect(server.index?.content).not.toContain('segredo')
    expect((await device().load()).index.tags).toEqual(['prova'])
  })

  it('o espaço usado vem da conta: notas e mídia, com o limite de 10 GB', async () => {
    const a = device()
    await a.load()
    await a.saveFile(aula(), 'texto da aula')
    const usage = await a.usage()
    expect(usage.appBytes).toBe(server.notesBytes())
    expect(usage.limitBytes).toBe(10 * 1024 * 1024 * 1024)
  })

  it('a mídia guardada no App abre em outro aparelho', async () => {
    const a = device()
    await a.load()
    const note = aula()
    await a.saveFile(note, 'texto')
    const stored = await a.putSource(note.meta.id, new Blob([new Uint8Array(1024)], { type: 'audio/webm' }), 'audio.webm')
    expect(server.rows.get(note.meta.id)?.media?.status).toBe('stored')
    const blob = await device().getSource(stored.ref)
    expect(blob.size).toBeGreaterThan(0)
  })

  it('a mesma mídia mandada de novo continua o envio que parou, sem recomeçar', async () => {
    const a = new AppRepository('acc1', { wait: async () => {} })
    await a.load()
    const note = aula()
    await a.saveFile(note, 'texto')
    const audio = new File([new Uint8Array(25 * 1024 * 1024)], 'aula.webm', { type: 'audio/webm', lastModified: 1 })
    server.downParts.add(2)
    await expect(a.putSource(note.meta.id, audio, 'aula.webm')).rejects.toThrow()
    server.downParts.clear()
    server.calls = []
    await a.putSource(note.meta.id, audio, 'aula.webm')
    const parts = server.calls.filter(call => call.method === 'PUT' && call.path.includes('/v1/uploads/')).map(call => Number(call.path.split('/').pop()))
    expect(parts).toEqual([2, 3])
    expect(server.rows.get(note.meta.id)?.media?.status).toBe('stored')
  })
})
