import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { waitFor } from '@testing-library/react'

// "Novo conteúdo" of a link, a text or a topic: no entrada; the note keeps where it came from as metadata (`source`).
// A YouTube link, a file, a media and a recording still become an entrada.

import type { FileMeta, Snapshot } from '@/types/domain'
import { defaultIndex, newFileMeta } from '@/lib/defaults'
import { migrateEntries } from '@/lib/entry-migration'
import { type NewContentRequest, useJobsStore } from '@/stores/jobs'
import { entradas, fileOf, files, memoryLibrary, PAGE_TITLE, PAGE_URL, ready, YOUTUBE_URL } from '@/test/source-meta/fixture'

function request(fields: Partial<NewContentRequest> = {}): NewContentRequest {
  return { agent: 'lesson', input: { kind: 'link', url: PAGE_URL }, name: '', description: '', folderId: 'biologia', prompt: '', storage: 'none', litterboxTime: '72h' as NewContentRequest['litterboxTime'], ...fields }
}

let library: ReturnType<typeof memoryLibrary>

beforeEach(() => {
  library = memoryLibrary()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('link, texto e tema ficam só na nota', () => {
  it('um link não vira entrada: a nota guarda o link e o título da página', async () => {
    const note = await ready(await useJobsStore.getState().startNewContent(request()))
    expect(entradas()).toHaveLength(0)
    expect(files()).toHaveLength(1)
    expect(note).toMatchObject({ type: 'class', parentFileId: null, folderId: 'biologia', origin: { input: 'url', url: PAGE_URL, name: PAGE_TITLE }, source: { kind: 'link', url: PAGE_URL, title: PAGE_TITLE } })
    expect(note.role).toBeUndefined()
    expect(Date.parse(note.source!.at)).not.toBeNaN()
  })

  it('um texto colado fica inteiro na nota, sem entrada', async () => {
    const note = await ready(await useJobsStore.getState().startNewContent(request({ input: { kind: 'text', text: 'Fotossíntese\n\nA planta usa luz.' } })))
    expect(entradas()).toHaveLength(0)
    expect(note).toMatchObject({ parentFileId: null, source: { kind: 'text', text: 'Fotossíntese\n\nA planta usa luz.', title: 'Fotossíntese' } })
  })

  it('um tema vira explicação, e o tema fica na nota', async () => {
    const note = await ready(await useJobsStore.getState().startNewContent(request({ input: { kind: 'topic', topic: 'Juros compostos' } })))
    expect(entradas()).toHaveLength(0)
    expect(note).toMatchObject({ type: 'explanation', parentFileId: null, source: { kind: 'topic', text: 'Juros compostos' } })
  })

  it('"Só guardar para ler" de um texto também: a leitura guarda o texto como fonte', async () => {
    const id = await useJobsStore.getState().startNewContent(request({ agent: 'reading', input: { kind: 'text', text: 'Lista de compras\n\nPão e leite.' } }))
    const note = await ready(id)
    expect(entradas()).toHaveLength(0)
    expect(note).toMatchObject({ type: 'reading', source: { kind: 'text', text: 'Lista de compras\n\nPão e leite.' } })
  })

  it('a Ata de um link também guarda o link na nota, sem entrada (a FR-055 vale só para mídia e gravação)', async () => {
    const id = await useJobsStore.getState().startNewContent(request({ agent: 'meeting', keep: 'registro' }))
    await waitFor(() => expect(fileOf(id!)?.status).not.toBe('generating'))
    expect(entradas()).toHaveLength(0)
    expect(fileOf(id!)).toMatchObject({ type: 'meeting', parentFileId: null, source: { kind: 'link', url: PAGE_URL } })
  })

  it('uma entrada antiga do mesmo link fica como está e não ganha a nota nova', async () => {
    const old = newFileMeta({ id: 'antiga', name: PAGE_TITLE, role: 'entrada', kept: 'registro', type: 'reading', origin: { input: 'url', name: PAGE_TITLE, url: PAGE_URL, storage: 'none' } })
    library = memoryLibrary({ files: [old] })
    const note = await ready(await useJobsStore.getState().startNewContent(request()))
    expect(entradas()).toEqual([old])
    expect(note.parentFileId).toBeNull()
  })
})

describe('o resto continua virando entrada', () => {
  it('um link do YouTube vira entrada, e a nota nasce dela', async () => {
    const note = await ready(await useJobsStore.getState().startNewContent(request({ input: { kind: 'link', url: YOUTUBE_URL }, analyze: 'transcricao' })))
    const [entry] = entradas()
    expect(entry).toMatchObject({ origin: { input: 'youtube', url: YOUTUBE_URL } })
    expect(note.parentFileId).toBe(entry.id)
    expect(note.source).toBeUndefined()
  })
})

describe('dados antigos', () => {
  it('a migração de entradas não mexe numa nota que guarda a fonte em si', async () => {
    const note: FileMeta = newFileMeta({ id: 'n', name: 'Aula', type: 'class', origin: { input: 'url', name: PAGE_TITLE, url: PAGE_URL, storage: 'none' }, source: { kind: 'link', url: PAGE_URL, title: PAGE_TITLE, at: '2026-11-14T10:00:00.000Z' } })
    library = memoryLibrary({ files: [note] })
    const index = { ...defaultIndex() }
    delete index.entriesMigratedAt
    const snapshot: Snapshot = { folders: [], files: [note], index }
    const migrated = await migrateEntries(library.repo, snapshot)
    expect(migrated.files).toEqual([note])
  })
})
