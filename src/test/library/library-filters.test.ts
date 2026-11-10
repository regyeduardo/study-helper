import { describe, expect, it } from 'vitest'

import type { ArtifactSummary, FileMeta, FolderMeta, SourceMeta } from '@/types/domain'
import { newFileMeta, newFolderMeta } from '@/lib/defaults'
import { clearFilters, type FilterResult, type FilterSource, filterLibrary, kindOf, type LibraryFilters, NO_FILTERS, placeOf, toggleOption, withoutFilter } from '@/lib/library-filters'

/* ---------- a library like the mock (b-painel-de-filtros.svg) ---------- */

// 2026-11-08 12:00 in São Paulo
const NOW = '2026-11-08T15:00:00Z'
const TZ = 'America/Sao_Paulo'

const stamp = (at: string) => ({ at, deviceId: 'd1', deviceName: 'Teste' })
const art = (id: string, kind: ArtifactSummary['kind']): ArtifactSummary => ({ id, kind, name: id, updatedAt: NOW })

function folder(id: string, name: string, fields: Partial<FolderMeta> = {}): FolderMeta {
  return newFolderMeta({ id, name, ...fields })
}

function item(id: string, created: string, updated: string, fields: Partial<FileMeta> = {}): FileMeta {
  return newFileMeta({ id, name: id, type: 'class', created: stamp(created), updated: stamp(updated), ...fields })
}

function entrada(id: string, origin: SourceMeta, created: string, updated: string, fields: Partial<FileMeta> = {}): FileMeta {
  return item(id, created, updated, { role: 'entrada', kept: 'registro', type: 'reading', origin, ...fields })
}

const video = (name: string, more: Partial<SourceMeta> = {}): SourceMeta => ({ input: 'file', name, mime: 'video/mp4', storage: 'drive', storedFileId: `drv-${name}`, ...more })
const pdf = (name: string, more: Partial<SourceMeta> = {}): SourceMeta => ({ input: 'file', name, mime: 'application/pdf', storage: 'drive', storedFileId: `drv-${name}`, ...more })

const FOLDERS: FolderMeta[] = [
  folder('trabalho', 'Trabalho'),
  folder('aurora', 'Projeto Aurora', { parentId: 'trabalho' }),
  folder('atas', 'Atas', { parentId: 'aurora' }),
  folder('estudos', 'Estudos'),
  folder('velha', 'Velha', { deletedAt: '2026-11-01T10:00:00Z' }),
  folder('dentro-velha', 'Dentro da velha', { parentId: 'velha' }),
]

const FILES: FileMeta[] = [
  entrada('kickoff', video('kickoff.mp4'), '2026-11-03T17:20:00Z', '2026-11-08T12:12:00Z', { kept: 'arquivo', folderId: 'aurora' }),
  item('ata', '2026-11-03T18:02:00Z', '2026-11-08T11:40:00Z', { type: 'meeting', parentFileId: 'kickoff', folderId: 'atas', tags: ['contrato', 'cronograma'], artifacts: [art('m1', 'mapa')] }),
  entrada('aula3', { input: 'recording', name: 'aula3.webm', mime: 'audio/webm', storage: 'none' }, '2026-11-07T11:30:00Z', '2026-11-07T11:30:00Z', { kept: 'arquivo', folderId: 'aurora' }),
  item('ideias', '2026-11-01T13:00:00Z', '2026-11-06T13:00:00Z', { folderId: 'aurora', tags: ['cronograma'] }),
  entrada('planejamento', video('planejamento.mp4', { storedFileId: undefined, removedAt: '2026-11-05T10:00:00Z' }), '2026-10-20T13:00:00Z', '2026-11-05T13:00:00Z', { folderId: 'atas' }),
  item('ata-plan', '2026-10-20T14:00:00Z', '2026-10-21T14:00:00Z', { type: 'meeting', parentFileId: 'planejamento', folderId: 'estudos' }),
  entrada('curso', video('curso.mp4'), '2026-08-15T13:00:00Z', '2026-11-02T21:30:00Z', { kept: 'arquivo', folderId: 'aurora' }),
  item('aula-curso', '2026-08-15T14:00:00Z', '2026-08-16T14:00:00Z', { parentFileId: 'curso', folderId: 'estudos' }),
  item('explicacao', '2026-09-01T14:00:00Z', '2026-09-01T14:00:00Z', { type: 'explanation', parentFileId: 'aula-curso', folderId: 'estudos', artifacts: [art('c1', 'cartoes')] }),
  entrada('contrato', pdf('contrato.pdf'), '2026-10-28T12:15:00Z', '2026-10-28T14:47:00Z', { kept: 'arquivo', folderId: 'aurora', tags: ['contrato'] }),
  item('resumo-contrato', '2026-10-28T15:00:00Z', '2026-10-29T15:00:00Z', { type: 'reading', parentFileId: 'contrato', folderId: 'aurora', artifacts: [art('t1', 'tutor')] }),
  entrada('link', { input: 'url', name: 'Artigo', url: 'https://exemplo.com/artigo', storage: 'none' }, '2026-10-10T12:00:00Z', '2026-10-10T12:00:00Z', { folderId: 'estudos' }),
  entrada('tema', { input: 'topic', name: 'Juros compostos', storage: 'none' }, '2026-09-01T12:00:00Z', '2026-09-01T12:00:00Z'),
  // 23:30 of the 7th in São Paulo, already the 8th in UTC
  entrada('texto', { input: 'text', name: 'texto colado', mime: 'text/plain', sizeBytes: 120, storage: 'none' }, '2026-11-08T02:30:00Z', '2026-11-08T02:30:00Z', { folderId: 'estudos' }),
  entrada('temp', pdf('apostila.pdf', { storage: 'litterbox', storedFileId: undefined, storedUrl: 'https://litter.example/a.pdf', expiresAt: '2026-11-10T00:00:00Z' }), '2026-11-06T12:00:00Z', '2026-11-06T12:00:00Z', { kept: 'arquivo', folderId: 'estudos' }),
  entrada('vencido', video('palestra.mp4', { storage: 'tmpfiles', storedFileId: undefined, storedUrl: 'https://tmp.example/p.mp4', expiresAt: '2026-11-01T00:00:00Z' }), '2026-10-15T12:00:00Z', '2026-10-15T12:00:00Z', { kept: 'arquivo', folderId: 'estudos' }),
  item('ata-apagada', '2026-10-15T13:00:00Z', '2026-10-15T13:00:00Z', { type: 'meeting', parentFileId: 'vencido', folderId: 'estudos', deletedAt: '2026-11-01T10:00:00Z' }),
  entrada('youtube', { input: 'youtube', name: 'Reunião aberta', url: 'https://youtube.com/watch?v=1', storage: 'none' }, '2026-10-12T12:00:00Z', '2026-10-12T12:00:00Z', { folderId: 'trabalho' }),
  item('ata-youtube', '2026-10-12T13:00:00Z', '2026-10-12T13:00:00Z', { type: 'meeting', parentFileId: 'youtube', folderId: 'trabalho' }),
  entrada('planilha', { input: 'file', name: 'gastos.xls', mime: 'application/vnd.ms-excel', storage: 'drive', storedFileId: 'drv-gastos' }, '2026-07-01T12:00:00Z', '2026-07-01T12:00:00Z', { kept: 'arquivo', folderId: 'estudos' }),
  // the Lixeira: never counts
  entrada('lixo', video('antigo.mp4'), '2026-10-05T12:00:00Z', '2026-10-05T12:00:00Z', { folderId: 'aurora', deletedAt: '2026-11-07T10:00:00Z', trashedWith: 'lixo' }),
  item('ata-lixo', '2026-10-05T13:00:00Z', '2026-10-05T13:00:00Z', { type: 'meeting', parentFileId: 'lixo', folderId: 'aurora', deletedAt: '2026-11-07T10:00:00Z', trashedWith: 'lixo' }),
  item('na-velha', '2026-11-08T12:00:00Z', '2026-11-08T12:00:00Z', { type: 'explanation', parentFileId: 'tema', folderId: 'dentro-velha', tags: ['segredo'] }),
]

const SOURCE: FilterSource = { files: FILES, folders: FOLDERS, localMedia: ['aula3'], library: 'drive', now: NOW, timeZone: TZ }

const run = (filters: Partial<LibraryFilters> = {}, source: Partial<FilterSource> = {}): FilterResult => filterLibrary({ ...SOURCE, ...source }, { ...NO_FILTERS, ...filters })
const ids = (result: FilterResult) => result.items.map(file => file.id)
const counts = (options: { id: string | null; count: number }[]) => Object.fromEntries(options.map(option => [String(option.id), option.count]))

/* ---------- T066 ---------- */

describe('sem filtro', () => {
  it('mostra tudo o que está vivo, na ordem recebida, e o total não conta a Lixeira', () => {
    const result = run()
    expect(result.total).toBe(19)
    expect(result.shown).toBe(19)
    expect(result.summary).toBe('19 de 19')
    expect(result.active).toEqual([])
    expect(ids(result)).not.toContain('lixo')
    expect(ids(result)).not.toContain('ata-lixo')
    expect(ids(result)).not.toContain('ata-apagada')
    expect(ids(result)).not.toContain('na-velha')
    expect(ids(result).slice(0, 3)).toEqual(['kickoff', 'ata', 'aula3'])
  })
})

describe('Tipo', () => {
  it('cada entrada tem o seu tipo pela fonte; o que não é entrada é Nota', () => {
    expect(counts(run().facets.kinds)).toEqual({ video: 5, audio: 1, pdf: 2, link: 1, texto: 1, tema: 1, arquivo: 1, nota: 7 })
    expect(run().facets.kinds.map(option => option.label)).toEqual(['Vídeo', 'Áudio', 'PDF', 'Link', 'Texto', 'Tema', 'Outro arquivo', 'Nota'])
  })

  it('um link do YouTube é vídeo', () => {
    expect(kindOf(FILES.find(file => file.id === 'youtube')!)).toBe('video')
  })

  it('dentro do grupo, qualquer uma das opções marcadas basta', () => {
    expect(ids(run({ kinds: ['pdf'] }))).toEqual(['contrato', 'temp'])
    expect(ids(run({ kinds: ['link', 'tema'] }))).toEqual(['link', 'tema'])
  })
})

describe('O que gerou', () => {
  it('vem da família inteira: notas de qualquer geração e os artefatos dela e do próprio item', () => {
    expect(counts(run().facets.generated)).toEqual({ ata: 3, aula: 1, explicacao: 2, leitura: 1, mapa: 2, cartoes: 3, tutor: 2, nada: 10 })
    expect(run().facets.generated.map(option => option.label)).toEqual(['Ata', 'Aula', 'Explicação', 'Leitura', 'Mapa', 'Cartões', 'Conversa do Tutor', 'Nada ainda'])
    expect(ids(run({ generated: ['cartoes'] }))).toEqual(['curso', 'aula-curso', 'explicacao'])
  })

  it('o que está na Lixeira não conta como gerado: nota apagada ou nota numa pasta apagada', () => {
    expect(ids(run({ generated: ['ata'] }))).toEqual(['kickoff', 'planejamento', 'youtube'])
    expect(ids(run({ generated: ['nada'] }))).toContain('vencido')
    expect(ids(run({ generated: ['nada'] }))).toContain('tema')
  })
})

describe('Período', () => {
  it('pela data de atualização: hoje, últimos 7 e últimos 30 dias, no fuso da pessoa', () => {
    expect(ids(run({ period: 'hoje' }))).toEqual(['kickoff', 'ata'])
    expect(run({ period: '7dias' }).shown).toBe(8)
    expect(run({ period: '30dias' }).shown).toBe(15)
    expect(counts(run().facets.period)).toEqual({ hoje: 2, '7dias': 8, '30dias': 15 })
    expect(run().facets.period.map(option => option.label)).toEqual(['Hoje', 'Últimos 7 dias', 'Últimos 30 dias'])
  })

  it('o dia é o do fuso: 23:30 de ontem em São Paulo não é hoje, mesmo já sendo hoje em UTC', () => {
    expect(ids(run({ period: 'hoje' }))).not.toContain('texto')
    expect(ids(run({ period: 'hoje' }, { timeZone: 'UTC' }))).toEqual(['kickoff', 'ata', 'texto'])
  })

  it('pela data de criação', () => {
    expect(ids(run({ dateField: 'created', period: 'hoje' }))).toEqual([])
    expect(counts(run({ dateField: 'created' }).facets.period)).toEqual({ hoje: 0, '7dias': 5, '30dias': 14 })
  })

  it('escolher datas: de um dia a outro, inclusive, ou só um dos lados', () => {
    const october = run({ dateField: 'created', period: { from: '2026-10-01', to: '2026-10-31' } })
    expect(ids(october)).toEqual(['planejamento', 'ata-plan', 'contrato', 'resumo-contrato', 'link', 'vencido', 'youtube', 'ata-youtube'])
    expect(october.facets.periodCustom).toBe(8)
    expect(ids(run({ dateField: 'created', period: { to: '2026-08-31' } }))).toEqual(['curso', 'aula-curso', 'planilha'])
    expect(ids(run({ dateField: 'created', period: { from: '2026-10-31', to: '2026-10-01' } }))).toEqual(ids(october))
    expect(run().facets.periodCustom).toBeNull()
  })
})

describe('Etiqueta', () => {
  it('qualquer uma das marcadas basta; as opções são as etiquetas do que está vivo, em ordem alfabética', () => {
    expect(ids(run({ tags: ['contrato'] }))).toEqual(['ata', 'contrato'])
    expect(ids(run({ tags: ['contrato', 'cronograma'] }))).toEqual(['ata', 'ideias', 'contrato'])
    expect(run().facets.tags.map(option => [option.id, option.count])).toEqual([
      ['contrato', 2],
      ['cronograma', 2],
    ])
  })
})

describe('Pasta', () => {
  it('com subpastas, o que está na pasta e em qualquer pasta dentro dela', () => {
    expect(ids(run({ folders: ['aurora'] }))).toEqual(['kickoff', 'ata', 'aula3', 'ideias', 'planejamento', 'curso', 'contrato', 'resumo-contrato'])
    expect(run({ folders: ['aurora'] }).facets.withSubfolders).toBe(8)
    expect(run({ folders: ['atas', 'estudos'] }).shown).toBe(10)
  })

  it('sem subpastas, só o que mora nela; a raiz da biblioteca também é uma pasta', () => {
    expect(ids(run({ folders: ['aurora'], subfolders: false }))).toEqual(['kickoff', 'aula3', 'ideias', 'curso', 'contrato', 'resumo-contrato'])
    expect(run({ folders: ['aurora'], subfolders: false }).facets.withSubfolders).toBe(8)
    expect(ids(run({ folders: [null], subfolders: false }))).toEqual(['tema'])
  })

  it('as opções são as pastas vivas, em árvore, com a contagem de cada uma', () => {
    const folders = run().facets.folders
    expect(folders.map(option => [option.id, option.label, option.depth])).toEqual([
      [null, 'Biblioteca', 0],
      ['estudos', 'Estudos', 1],
      ['trabalho', 'Trabalho', 1],
      ['aurora', 'Projeto Aurora', 2],
      ['atas', 'Atas', 3],
    ])
    expect(counts(folders)).toEqual({ null: 19, estudos: 8, trabalho: 10, aurora: 8, atas: 2 })
    expect(run().facets.withSubfolders).toBeNull()
  })
})

describe('Guardado', () => {
  it('Drive, só neste navegador, temporário, só o registro e mídia apagada', () => {
    expect(counts(run().facets.places)).toEqual({ drive: 11, navegador: 1, temporario: 1, registro: 5, apagado: 1 })
    expect(run().facets.places.map(option => option.label)).toEqual(['No meu Drive', 'Só neste navegador', 'Temporário', 'Só o registro', 'Mídia apagada'])
    expect(ids(run({ places: ['navegador'] }))).toEqual(['aula3'])
    expect(ids(run({ places: ['temporario'] }))).toEqual(['temp'])
    expect(ids(run({ places: ['apagado'] }))).toEqual(['planejamento'])
  })

  it('o temporário vencido fica só com o registro', () => {
    expect(ids(run({ places: ['registro'] }))).toEqual(['link', 'tema', 'texto', 'vencido', 'youtube'])
  })

  it('no perfil Local, o que está na biblioteca está neste navegador', () => {
    expect(counts(run({}, { library: 'navegador' }).facets.places)).toEqual({ drive: 0, navegador: 12, temporario: 1, registro: 5, apagado: 1 })
  })

  it('a mídia guardada em Mídias de outro aparelho também está só num navegador', () => {
    const where = { localMedia: new Set<string>(), library: 'drive' as const, now: NOW }
    expect(placeOf(FILES.find(file => file.id === 'aula3')!, where)).toBe('navegador')
    expect(placeOf(FILES.find(file => file.id === 'aula3')!, { ...where, localMedia: new Set(['aula3']) })).toBe('navegador')
    expect(placeOf(FILES.find(file => file.id === 'kickoff')!, where)).toBe('drive')
    // a note whose recording is in this browser only
    expect(placeOf(item('gravada', NOW, NOW), { ...where, localMedia: new Set(['gravada']) })).toBe('navegador')
  })
})

describe('dados incomuns', () => {
  const entry = (origin: SourceMeta | null, fields: Partial<FileMeta> = {}) => entrada('e', origin as SourceMeta, NOW, NOW, fields)
  const where = { localMedia: new Set<string>(), library: 'drive' as const, now: NOW }

  it('o tipo cai no que dá para saber da fonte', () => {
    expect(kindOf(entry(null))).toBe('texto')
    expect(kindOf(entry({ input: 'file', name: 'Prova.PDF', mime: 'application/octet-stream', storage: 'none' }))).toBe('pdf')
    expect(kindOf(entry({ input: 'import', name: 'antigo', storage: 'none' }))).toBe('arquivo')
    expect(kindOf(entry({ input: 'file', name: 'fala.ogg', mime: 'audio/ogg', storage: 'none' }))).toBe('audio')
  })

  it('o temporário sem data para vencer continua temporário; vencido e ainda em Mídias, está neste navegador', () => {
    const hosted = { input: 'file', name: 'a.pdf', mime: 'application/pdf', storage: 'gofile', storedUrl: 'https://gofile.example/a' } as const
    expect(placeOf(entry({ ...hosted, expiresAt: null }), where)).toBe('temporario')
    expect(placeOf(entry({ ...hosted, expiresAt: '2026-11-01T00:00:00Z' }), { ...where, localMedia: new Set(['e']) })).toBe('navegador')
  })

  it('metadados de antes dos artefatos ainda dizem que há mapa e cartões', () => {
    const files = [item('velho', NOW, NOW, { hasMindmap: true }), item('deck', NOW, NOW, { cardDue: ['2026-11-09'] })]
    const result = run({}, { files, folders: [] })
    expect(counts(result.facets.generated)).toMatchObject({ mapa: 1, cartoes: 1, nada: 0 })
  })

  it('a etiqueta marcada que sumiu continua na lista, para poder desmarcar', () => {
    expect(run({ tags: ['sumiu'] }).facets.tags.find(option => option.id === 'sumiu')).toEqual({ id: 'sumiu', label: 'sumiu', count: 0, selected: true })
  })

  it('uma etiqueta repetida no item conta uma vez', () => {
    const files = [item('a', NOW, NOW, { tags: ['x', 'x'] })]
    expect(counts(run({}, { files, folders: [] }).facets.tags)).toEqual({ x: 1 })
  })

  it('a pasta marcada que não existe mais aparece como apagada e não acha nada', () => {
    const result = run({ folders: ['nao-existe'] })
    expect(result.active).toEqual([{ group: 'folders', label: 'Pasta', value: 'pasta apagada e subpastas' }])
    expect(result.shown).toBe(0)
  })

  it('pasta cuja mãe sumiu fica na raiz da árvore', () => {
    const folders = [folder('solta', 'Solta', { parentId: 'nao-existe' })]
    expect(run({}, { files: [], folders }).facets.folders.map(option => [option.id, option.depth])).toEqual([
      [null, 0],
      ['solta', 1],
    ])
  })

  it('não muda o que recebe', () => {
    const filters: LibraryFilters = { ...NO_FILTERS, tags: ['z', 'a'], folders: ['atas'] }
    const before = JSON.stringify([filters, FILES.map(file => file.id)])
    filterLibrary(SOURCE, filters)
    expect(JSON.stringify([filters, FILES.map(file => file.id)])).toBe(before)
  })
})

describe('filtros combinados', () => {
  it('vídeos de outubro que geraram Ata', () => {
    const result = run({ kinds: ['video'], generated: ['ata'], dateField: 'created', period: { from: '2026-10-01', to: '2026-10-31' } })
    expect(ids(result)).toEqual(['planejamento', 'youtube'])
    expect(result.summary).toBe('2 de 19')
  })

  it('a contagem de cada opção leva em conta os outros grupos, não o próprio', () => {
    const result = run({ kinds: ['video'], folders: ['aurora'] })
    expect(ids(result)).toEqual(['kickoff', 'planejamento', 'curso'])
    expect(counts(result.facets.kinds)).toEqual({ video: 3, audio: 1, pdf: 1, link: 0, texto: 0, tema: 0, arquivo: 0, nota: 3 })
    expect(counts(result.facets.folders)).toEqual({ null: 5, estudos: 1, trabalho: 4, aurora: 3, atas: 1 })
    expect(counts(result.facets.generated)).toEqual({ ata: 2, aula: 1, explicacao: 1, leitura: 0, mapa: 1, cartoes: 1, tutor: 0, nada: 0 })
    expect(counts(result.facets.places)).toEqual({ drive: 2, navegador: 0, temporario: 0, registro: 0, apagado: 1 })
    expect(counts(result.facets.period)).toEqual({ hoje: 1, '7dias': 3, '30dias': 3 })
    expect(result.scopes).toEqual({ tudo: 3, entradas: 3, notas: 0 })
    expect(result.facets.kinds.filter(option => option.selected).map(option => option.id)).toEqual(['video'])
    expect(result.facets.folders.filter(option => option.selected).map(option => option.id)).toEqual(['aurora'])
  })

  it('a busca restringe o que aparece e as contagens, mas não o total', () => {
    const result = run({ kinds: ['video'] }, { only: new Set(['kickoff', 'ata', 'link']) })
    expect(ids(result)).toEqual(['kickoff'])
    expect(counts(result.facets.kinds)).toMatchObject({ video: 1, link: 1, nota: 1, pdf: 0 })
    expect(result.total).toBe(19)
  })
})

describe('Tudo, Entradas ou Notas', () => {
  it('separa as entradas das notas, e cada aba conta com os filtros ativos', () => {
    expect(run({ scope: 'notas' }).shown).toBe(7)
    expect(run({ scope: 'entradas' }).shown).toBe(12)
    expect(run({ scope: 'notas' }).scopes).toEqual({ tudo: 19, entradas: 12, notas: 7 })
    expect(counts(run({ scope: 'notas' }).facets.kinds)).toMatchObject({ nota: 7, video: 0 })
    expect(run({ scope: 'notas', tags: ['contrato'] }).scopes).toEqual({ tudo: 2, entradas: 1, notas: 1 })
  })
})

describe('filtros ativos', () => {
  const mock: Partial<LibraryFilters> = { kinds: ['nota', 'video', 'pdf', 'audio'], period: '30dias', folders: ['aurora'] }

  it('ficam à vista com o nome do grupo e os valores, como no desenho: "8 de 19"', () => {
    const result = run(mock)
    expect(result.summary).toBe('8 de 19')
    expect(result.active).toEqual([
      { group: 'kinds', label: 'Tipo', value: 'vídeo, áudio, PDF, nota' },
      { group: 'period', label: 'Atualizado', value: '30 dias' },
      { group: 'folders', label: 'Pasta', value: 'Projeto Aurora e subpastas' },
    ])
  })

  it('cada grupo diz o que está marcado em português', () => {
    const result = run({ generated: ['ata', 'nada'], tags: ['cronograma', 'contrato'], places: ['navegador', 'drive'], dateField: 'created', period: { from: '2026-10-01', to: '2026-10-31' }, folders: ['atas', null], subfolders: false })
    expect(result.active).toEqual([
      { group: 'generated', label: 'O que gerou', value: 'ata, nada ainda' },
      { group: 'period', label: 'Criado', value: '01/10/2026 a 31/10/2026' },
      { group: 'tags', label: 'Etiqueta', value: 'contrato, cronograma' },
      { group: 'folders', label: 'Pasta', value: 'Atas, Biblioteca' },
      { group: 'places', label: 'Guardado', value: 'no meu Drive, só neste navegador' },
    ])
    expect(run({ period: { from: '2026-10-01' } }).active[0].value).toBe('desde 01/10/2026')
    expect(run({ period: { to: '2026-10-31' } }).active[0].value).toBe('até 31/10/2026')
    expect(run({ period: 'hoje' }).active[0].value).toBe('hoje')
    expect(run({ period: {} }).active).toEqual([])
  })

  it('tirar um grupo deixa os outros', () => {
    const filters = { ...NO_FILTERS, ...mock, subfolders: false }
    expect(withoutFilter(filters, 'period')).toEqual({ ...filters, period: null })
    expect(withoutFilter(filters, 'folders')).toEqual({ ...filters, folders: [], subfolders: true })
    expect(withoutFilter(filters, 'kinds')).toEqual({ ...filters, kinds: [] })
    expect(filters.period).toBe('30dias')
  })

  it('"Limpar tudo" tira todos os filtros e mantém a aba e a data escolhida', () => {
    const filters: LibraryFilters = { ...NO_FILTERS, ...mock, scope: 'entradas', dateField: 'created', tags: ['contrato'], places: ['drive'], generated: ['ata'] }
    expect(clearFilters(filters)).toEqual({ ...NO_FILTERS, scope: 'entradas', dateField: 'created' })
    expect(run(clearFilters(filters)).active).toEqual([])
  })

  it('marcar e desmarcar uma opção', () => {
    const one = toggleOption(NO_FILTERS, 'kinds', 'video')
    expect(one.kinds).toEqual(['video'])
    expect(toggleOption(one, 'kinds', 'video').kinds).toEqual([])
    expect(toggleOption(NO_FILTERS, 'folders', null).folders).toEqual([null])
    expect(NO_FILTERS.kinds).toEqual([])
  })
})
