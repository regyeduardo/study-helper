import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { FileSidecar, SharedFile, SharedItem } from '@/types/domain'
import { defaultIndex, newFolderMeta } from '@/lib/defaults'
import { mapToMermaid } from '@/lib/generation/map-render'
import { buildEntryShareContent, importSharedEntry } from '@/lib/share'
import { choiceCount, choiceOf, defaultChoice, entryShareTree, MEDIA_KEY, toggleChoice } from '@/lib/share-entry'
import { useJobsStore } from '@/stores/jobs'
import { useLibraryStore } from '@/stores/library'

import { CONTENTS, ENTRY_NAME, entryFamily, MAP, memoryRepository, QUESTION, RECORDING, TALK } from './entry-family'

const SHARE_ID = 'EntradaEntradaEntrada1'
const MEDIA_URL = `https://share.test/media/${SHARE_ID}/e`
const SIZE = 1000

let sidecars: FileSidecar[]

const metas = () => sidecars.map(sidecar => sidecar.meta)
const open = async (id: string) => ({ content: CONTENTS[id] ?? '', sidecar: sidecars.find(sidecar => sidecar.meta.id === id)! })
const keys = (chosen: Set<string>) => [...chosen].sort()

function sharedItem(content: Awaited<ReturnType<typeof buildEntryShareContent>>, media = false): SharedItem {
  const files = content.files.map((file): SharedFile => (media && file.meta?.role === 'entrada' ? { ...file, media: { url: MEDIA_URL, mime: 'video/mp4', size: SIZE } } : file))
  return { ...content, files, version: 2, id: SHARE_ID, createdAt: new Date(Date.now() - 3600_000).toISOString(), expiresAt: new Date(Date.now() + 2 * 24 * 3600_000).toISOString(), mediaExpiresAt: new Date(Date.now() + 2 * 24 * 3600_000).toISOString() }
}

beforeEach(() => {
  sidecars = entryFamily()
})

describe('a árvore da janela de compartilhar', () => {
  it('as notas embaixo da mãe, na ordem em que nasceram, cada uma com os seus artefatos; sem o que está na Lixeira', () => {
    const tree = entryShareTree(metas(), 'e')
    expect(tree.map(node => node.file.name)).toEqual(['Ata', 'Aula'])
    expect(tree[0].artifacts.map(item => [item.name, item.kind])).toEqual([
      ['Portal novo', 'mapa'],
      ['Cartões da reunião', 'cartoes'],
    ])
    expect(tree[0].children).toEqual([])
    expect(tree[1].children.map(node => node.file.name)).toEqual(['Explicação: contratos'])
    expect(tree[1].children[0].artifacts.map(item => item.name)).toEqual(['Dúvidas sobre contratos'])
  })

  it('já vem tudo marcado, menos cartões e conversas do Tutor; a mídia só quando há o que mandar', () => {
    const tree = entryShareTree(metas(), 'e')
    expect(keys(defaultChoice(tree, true))).toEqual([MEDIA_KEY, 'ata', 'ata/m1', 'aula', 'exp'].sort())
    expect(keys(defaultChoice(tree, false))).toEqual(['ata', 'ata/m1', 'aula', 'exp'].sort())
  })

  it('desmarcar uma nota desmarca as notas filhas e os artefatos dela', () => {
    const tree = entryShareTree(metas(), 'e')
    const withTalk = toggleChoice(tree, defaultChoice(tree, true), 'exp/t1')
    expect(withTalk.has('exp/t1')).toBe(true)
    expect(keys(toggleChoice(tree, withTalk, 'aula'))).toEqual([MEDIA_KEY, 'ata', 'ata/m1'].sort())
    expect(keys(toggleChoice(tree, withTalk, 'ata'))).toEqual([MEDIA_KEY, 'aula', 'exp', 'exp/t1'].sort())
  })

  it('marcar uma nota filha ou um artefato marca de volta a mãe, até a entrada', () => {
    const tree = entryShareTree(metas(), 'e')
    const none = toggleChoice(tree, toggleChoice(tree, defaultChoice(tree, true), 'aula'), 'ata')
    expect(keys(none)).toEqual([MEDIA_KEY])
    expect(keys(toggleChoice(tree, none, 'exp/t1'))).toEqual([MEDIA_KEY, 'aula', 'exp', 'exp/t1'].sort())
    expect(keys(toggleChoice(tree, none, 'exp'))).toEqual([MEDIA_KEY, 'aula', 'exp'].sort())
    expect(keys(toggleChoice(tree, none, 'ata/c1'))).toEqual([MEDIA_KEY, 'ata', 'ata/c1'].sort())
  })

  it('desmarcar um artefato ou a mídia tira só ele', () => {
    const tree = entryShareTree(metas(), 'e')
    const start = defaultChoice(tree, true)
    expect(keys(toggleChoice(tree, start, 'ata/m1'))).toEqual([MEDIA_KEY, 'ata', 'aula', 'exp'].sort())
    expect(keys(toggleChoice(tree, start, MEDIA_KEY))).toEqual(['ata', 'ata/m1', 'aula', 'exp'].sort())
  })

  it('conta "N de M": a mídia, cada nota e cada artefato; a transcrição vai sempre e não conta', () => {
    const tree = entryShareTree(metas(), 'e')
    expect(choiceCount(tree, defaultChoice(tree, true), true)).toEqual({ chosen: 5, total: 7 })
    expect(choiceCount(tree, defaultChoice(tree, false), false)).toEqual({ chosen: 4, total: 6 })
    expect(choiceCount(tree, toggleChoice(tree, defaultChoice(tree, true), 'aula'), true)).toEqual({ chosen: 3, total: 7 })
  })
})

describe('o que vai no link de uma entrada', () => {
  it('a entrada com a transcrição, e as notas escolhidas com a mãe de cada uma; sem pasta nem o Drive de quem compartilha', async () => {
    const tree = entryShareTree(metas(), 'e')
    const content = await buildEntryShareContent('e', metas(), open, choiceOf(tree, defaultChoice(tree, true)))
    expect(content).toMatchObject({ kind: 'entrada', title: ENTRY_NAME, folders: [] })
    expect(content.files.map(file => file.name)).toEqual([ENTRY_NAME, 'Ata', 'Aula', 'Explicação: contratos'])
    expect(content.files.every(file => file.folderId === null && !file.meta?.folderId)).toBe(true)
    const [entry, ata, , exp] = content.files
    expect(entry.recording).toEqual(RECORDING)
    expect(entry.transcript).toContain('portal novo')
    expect(entry.meta).toMatchObject({ role: 'entrada', kept: 'arquivo', parentFileId: null, origin: { input: 'file', name: 'planejamento.mp4', mime: 'video/mp4', durationSeconds: 68 * 60, storage: 'none' } })
    expect(entry.meta?.origin).not.toHaveProperty('storedFileId')
    expect(ata.meta?.parentFileId).toBe('e')
    expect(exp.meta?.parentFileId).toBe('aula')
    expect(ata.artifacts).toEqual([{ id: MAP.id, kind: 'mapa', name: MAP.name, diagram: MAP.diagram, mermaid: mapToMermaid(MAP.diagram) }])
    expect(exp.artifacts).toBeUndefined()
    expect(ata.questions).toEqual([QUESTION])
    expect(ata.content).toBe(CONTENTS.ata)
    expect(JSON.stringify(content)).not.toMatch(/Reuniões da Ana|drv-da-ana|Nota apagada|Pergunta do mapa|Cartões da reunião|Dúvidas sobre contratos/)
  })

  it('só o escolhido: a nota desmarcada e as filhas dela não vão; a mídia desmarcada deixa a entrada como "Só o registro"', async () => {
    const tree = entryShareTree(metas(), 'e')
    const chosen = toggleChoice(tree, toggleChoice(tree, toggleChoice(tree, defaultChoice(tree, true), 'aula'), MEDIA_KEY), 'ata/c1')
    const content = await buildEntryShareContent('e', metas(), open, choiceOf(tree, chosen))
    expect(content.files.map(file => file.name)).toEqual([ENTRY_NAME, 'Ata'])
    expect(content.files[0].meta?.kept).toBe('registro')
    expect(content.files[1].artifacts?.map(item => item.name)).toEqual(['Portal novo', 'Cartões da reunião'])
    expect(JSON.stringify(content)).not.toMatch(/Explicação|Aula|Dúvidas sobre contratos/)
  })

  it('sem nenhuma nota marcada, vai só a entrada, com a transcrição', async () => {
    const tree = entryShareTree(metas(), 'e')
    const chosen = toggleChoice(tree, toggleChoice(tree, defaultChoice(tree, true), 'aula'), 'ata')
    const content = await buildEntryShareContent('e', metas(), open, choiceOf(tree, chosen))
    expect(content.files.map(file => file.name)).toEqual([ENTRY_NAME])
    expect(content.files[0].recording).toEqual(RECORDING)
  })
})

describe('importar o link de uma entrada', () => {
  let memory: ReturnType<typeof memoryRepository>

  beforeEach(() => {
    memory = memoryRepository()
    useLibraryStore.setState({ repo: memory.repo, accountId: 'local', ready: true, folders: [newFolderMeta({ id: 'destino', name: 'Da família' })], files: [], index: defaultIndex(), opened: {}, openedAt: {}, localMedia: [], sharedView: null })
    useJobsStore.setState({ jobs: [], live: {}, proposals: [] })
  })

  afterEach(() => vi.unstubAllGlobals())

  const actions = () => {
    const library = useLibraryStore.getState()
    return { createFolder: library.createFolder, createFile: library.createFile, updateSidecar: library.updateSidecar }
  }

  async function item(chosen = (tree: ReturnType<typeof entryShareTree>) => defaultChoice(tree, true)) {
    const tree = entryShareTree(metas(), 'e')
    return sharedItem(await buildEntryShareContent('e', metas(), open, choiceOf(tree, chosen(tree))))
  }

  const importNow = async (shared: SharedItem, folderId: string | null = 'destino') => importSharedEntry(shared, {}, actions(), { folderId, existing: useLibraryStore.getState().files })

  it('recria 100% do escolhido na pasta escolhida, com a mesma hierarquia e os artefatos dentro das notas', async () => {
    const result = await importNow(await item())
    const files = useLibraryStore.getState().files
    expect(files).toHaveLength(4)
    const entry = files.find(file => file.id === result.fileId)!
    expect(entry).toMatchObject({ name: ENTRY_NAME, role: 'entrada', kept: 'registro', parentFileId: null, folderId: 'destino', sharedFrom: SHARE_ID })
    expect(entry.origin).toMatchObject({ input: 'file', name: 'planejamento.mp4', mime: 'video/mp4', storage: 'none' })
    const byName = (name: string) => files.find(file => file.name === name)!
    expect(byName('Ata')).toMatchObject({ parentFileId: entry.id, folderId: 'destino', type: 'meeting' })
    expect(byName('Aula')).toMatchObject({ parentFileId: entry.id, folderId: 'destino' })
    expect(byName('Explicação: contratos')).toMatchObject({ parentFileId: byName('Aula').id, folderId: 'destino', type: 'explanation' })
    const ata = await useLibraryStore.getState().openFile(byName('Ata').id)
    expect(ata.content).toBe(CONTENTS.ata)
    expect(ata.sidecar.questions).toEqual([QUESTION])
    expect(ata.sidecar.artifacts).toEqual([expect.objectContaining({ id: MAP.id, kind: 'mapa', name: 'Portal novo', diagram: MAP.diagram, chat: [], versions: [] })])
    expect(byName('Ata').artifacts?.map(summary => summary.name)).toEqual(['Portal novo'])
    const opened = await useLibraryStore.getState().openFile(entry.id)
    expect(opened.sidecar.recording).toEqual(RECORDING)
  })

  it('nada que ficou de fora aparece', async () => {
    await importNow(await item(tree => toggleChoice(tree, defaultChoice(tree, true), 'aula')))
    expect(useLibraryStore.getState().files.map(file => file.name).sort()).toEqual([ENTRY_NAME, 'Ata'].sort())
  })

  it('importar de novo cria outra cópia, sem mexer na que existe: "(cópia 1)", "(cópia 2)" só no nome da entrada', async () => {
    const shared = await item()
    const first = await importNow(shared)
    const second = await importNow(shared)
    const third = await importNow(shared)
    const files = useLibraryStore.getState().files
    expect(files.find(file => file.id === first.fileId)!.name).toBe(ENTRY_NAME)
    expect(files.find(file => file.id === second.fileId)!.name).toBe(`${ENTRY_NAME} (cópia 1)`)
    expect(files.find(file => file.id === third.fileId)!.name).toBe(`${ENTRY_NAME} (cópia 2)`)
    expect(files.filter(file => file.name === 'Ata').map(file => file.parentFileId).sort()).toEqual([first.fileId, second.fileId, third.fileId].sort())
    expect(files).toHaveLength(12)
  })

  it('outra entrada com o mesmo nome, que não veio deste link, não vira cópia', async () => {
    await useLibraryStore.getState().createFile({ name: ENTRY_NAME, type: 'meeting', role: 'entrada' }, '')
    const result = await importNow(await item())
    expect(useLibraryStore.getState().files.find(file => file.id === result.fileId)!.name).toBe(ENTRY_NAME)
  })

  it('a mídia do link fica neste navegador, ligada à entrada nova, que guarda o arquivo', async () => {
    const written = new Map<string, BlobPart[]>()
    const handle = (name: string) => ({
      getFile: async () => ({ text: async () => (written.get(name) ?? []).map(String).join('') }),
      createWritable: async () => {
        const parts: BlobPart[] = []
        return { write: async (data: BlobPart) => void parts.push(data), close: async () => void written.set(name, parts) }
      },
    })
    Object.defineProperty(navigator, 'storage', { configurable: true, value: { getDirectory: async () => ({ getFileHandle: async (name: string) => handle(name), removeEntry: async () => undefined }) } })
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string) => (String(input) === MEDIA_URL ? new Response(new Uint8Array(SIZE), { headers: { 'Content-Length': String(SIZE), 'Content-Type': 'video/mp4' } }) : new Response('', { status: 404 }))),
    )
    const tree = entryShareTree(metas(), 'e')
    const shared = sharedItem(await buildEntryShareContent('e', metas(), open, choiceOf(tree, defaultChoice(tree, true))), true)
    const track = vi.fn(() => ({ update: vi.fn(), done: vi.fn(), fail: vi.fn() }))
    const result = await importSharedEntry(shared, {}, actions(), { folderId: 'destino', existing: [], media: { place: 'browser', repo: memory.repo, track } })
    const entry = useLibraryStore.getState().files.find(file => file.id === result.fileId)!
    expect(entry.kept).toBe('arquivo')
    expect(entry.origin).toMatchObject({ input: 'file', name: 'planejamento.mp4', mime: 'video/mp4', storage: 'none' })
    await vi.waitFor(() => expect(useLibraryStore.getState().localMedia.map(media => media.fileIds)).toEqual([[entry.id]]))
    expect(track).toHaveBeenCalledWith(`Guardar a mídia: ${ENTRY_NAME}`)
    expect(memory.putSource).not.toHaveBeenCalled()
  })

  it('no Google Drive, a mídia vai para o Drive de quem importa', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new Uint8Array(SIZE), { headers: { 'Content-Length': String(SIZE) } })))
    const tree = entryShareTree(metas(), 'e')
    const shared = sharedItem(await buildEntryShareContent('e', metas(), open, choiceOf(tree, defaultChoice(tree, true))), true)
    const track = vi.fn(() => ({ update: vi.fn(), done: vi.fn(), fail: vi.fn() }))
    const result = await importSharedEntry(shared, {}, actions(), { folderId: null, existing: [], media: { place: 'drive', repo: memory.repo, track } })
    const entry = useLibraryStore.getState().files.find(file => file.id === result.fileId)!
    expect(memory.putSource).toHaveBeenCalledWith(entry.id, expect.any(File), 'planejamento.mp4')
    expect(entry).toMatchObject({ folderId: null, kept: 'arquivo', origin: { storage: 'drive', storedFileId: 'drive-nova' } })
  })
})
