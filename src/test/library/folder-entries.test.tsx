// Biblioteca > pasta > "Entradas:": as notas agrupadas pela entrada de onde nasceram, ou a entrada como uma linha normal (só na navegação da pasta).
// O padrão continua o de FR-073: "Não mostrar", a pasta só com as notas.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'

import type { FileMeta, SourceMeta } from '@/types/domain'
import { entryOfNote, folderEntriesOf, groupNotesByEntry } from '@/lib/folder-entries'
import { useViewRoute } from '@/hooks/use-view-route'
import { ReaderWorkspace } from '@/pages/workspace/container/reader'
import type { Repository } from '@/lib/storage/repository'
import { useLibraryStore } from '@/stores/library'
import { useUiStore } from '@/stores/ui'
import { FILES, seedLibrary } from '@/test/library/explorer-fixture'

const COLADO: SourceMeta = { input: 'text', name: 'texto colado', storage: 'none' }
const PDF: SourceMeta = { input: 'file', name: 'limites.pdf', mime: 'application/pdf', storage: 'drive', storedFileId: 'drv' }
const VIDEO: SourceMeta = { input: 'file', name: 'segunda.mp4', mime: 'video/mp4', storage: 'none' }
const at = (iso: string) => ({ at: iso, deviceId: 'local', deviceName: 'Este computador' })

const note = (id: string, name: string, folderId: string | null, extra: Partial<FileMeta> = {}): FileMeta => ({ ...FILES[3], id, name, folderId, tags: [], mastery: null, ...extra })
const entrada = (id: string, name: string, folderId: string | null, origin: SourceMeta, extra: Partial<FileMeta> = {}): FileMeta => note(id, name, folderId, { role: 'entrada', kept: 'registro', origin, ...extra })

/**
 * Cálculo I: um texto colado com a sua Ata; um PDF que mora em Física II com a sua Aula aqui e um Resumo nascido dessa Aula (nota de nota);
 * um vídeo sem notas; uma entrada na Lixeira com uma nota; uma nota de mãe que não existe mais; uma nota filha de outra nota sem entrada.
 */
const EXTRA = [
  entrada('colado', 'texto colado', 'calc', COLADO, { created: at('2026-10-20T10:00:00Z') }),
  note('ata-colado', 'Ata do texto colado', 'calc', { type: 'meeting', parentFileId: 'colado' }),
  entrada('pdf', 'limites.pdf', 'fis', PDF, { created: at('2026-10-10T10:00:00Z') }),
  note('aula-pdf', 'Aula do PDF de limites', 'calc', { type: 'class', parentFileId: 'pdf' }),
  note('resumo', 'Resumo da aula', 'calc', { type: 'explanation', parentFileId: 'aula-pdf', created: at('2026-10-15T10:00:00Z') }),
  entrada('so-video', 'Reunião de segunda', 'calc', VIDEO, { tags: ['reuniao'], created: at('2026-10-30T10:00:00Z') }),
  entrada('apagada', 'Entrada apagada', 'calc', VIDEO, { deletedAt: '2026-11-01T10:00:00Z' }),
  note('orfa', 'Nota órfã', 'calc', { parentFileId: 'apagada' }),
  note('sem-mae', 'Nota sem mãe', 'calc', { parentFileId: 'nao-existe-mais' }),
  note('filha', 'Exercícios resolvidos de limites', 'calc', { type: 'explanation', parentFileId: 'limites' }),
]

const SEM_ENTRADA = ['derivadas-video', 'derivadas', 'filha', 'limites', 'monitoria', 'orfa', 'sem-mae']
/** Subpastas de Cálculo I, na frente de tudo. */
const SUBPASTAS = ['integ', 'exer']

let saveIndex: ReturnType<typeof vi.fn>

beforeEach(() => {
  seedLibrary()
  saveIndex = vi.fn(async () => undefined)
  useLibraryStore.setState(state => ({
    files: [...state.files, ...EXTRA],
    repo: { ...state.repo, saveIndex, saveFolder: async () => undefined } as unknown as Repository,
  }))
  useUiStore.setState({ selection: new Set(), query: '', tag: null, lowMastery: false, overlay: null, drag: null })
})

afterEach(() => {
  vi.restoreAllMocks()
})

function chosen(mode: 'hide' | 'group' | 'item' | 'invalido') {
  useLibraryStore.setState(state => ({ index: { ...state.index, settings: { ...state.index.settings, folderEntries: mode as never } } }))
}

function Workspace() {
  return <ReaderWorkspace route={useViewRoute()} />
}

function Where() {
  return <output aria-label="Endereço">{useLocation().pathname}</output>
}

function renderFolder(path = '/biblioteca/calc') {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/entrada/:entryId" element={<Where />} />
        <Route path="/biblioteca/:folderId?" element={<Workspace />} />
        <Route path="*" element={<Workspace />} />
      </Routes>
    </MemoryRouter>,
  )
}

const table = () => screen.getByRole('table', { name: 'Notas e pastas' })
const bodyRows = () => [...table().querySelectorAll<HTMLElement>('tbody tr')]
/** Pastas e notas pelo id; cada cabeçalho de grupo por "grupo:<entrada>" ou "grupo:sem-entrada"; a entrada, quando é uma linha normal, pelo seu id. */
const keys = () => bodyRows().map(row => row.dataset.folderId ?? row.dataset.fileId ?? `grupo:${row.dataset.entryGroup}`)
const noteKeys = () => keys().filter(key => !SUBPASTAS.includes(key))
const header = (name: string) => within(table()).getByRole('row', { name })
const select = () => screen.getByRole('combobox', { name: 'Entradas' })
const choose = (mode: 'hide' | 'group' | 'item') => fireEvent.change(select(), { target: { value: mode } })
const group = (name: string) => screen.getByRole('group', { name })
const toolbar = () => screen.getByRole('toolbar', { name: 'Seleção' })
const selected = () => [...useUiStore.getState().selection].sort()

function narrowScreen() {
  vi.spyOn(window, 'matchMedia').mockImplementation(
    query =>
      ({ matches: /max-width/.test(query), media: query, onchange: null, addListener: () => undefined, removeListener: () => undefined, addEventListener: () => undefined, removeEventListener: () => undefined, dispatchEvent: () => false }) as MediaQueryList,
  )
}

describe('o controle "Entradas:" na pasta', () => {
  it('fica na linha de ferramentas da pasta com as três escolhas, e começa em "Não mostrar"', () => {
    renderFolder()
    expect(select()).toHaveValue('hide')
    expect(within(select()).getAllByRole('option').map(option => option.textContent)).toEqual(['Não mostrar', 'Agrupar as notas', 'Como item'])
    expect(screen.getByText('Entradas:')).toBeInTheDocument()
  })

  it('em "Não mostrar" a pasta é a de sempre: só as notas, uma por linha, sem cabeçalhos nem entradas', () => {
    renderFolder()
    expect(keys()).toEqual([...SUBPASTAS, 'ata-colado', 'aula-pdf', 'derivadas-video', 'derivadas', 'filha', 'limites', 'monitoria', 'orfa', 'sem-mae', 'resumo'])
    expect(screen.queryByRole('row', { name: 'texto colado' })).toBeNull()
    expect(screen.queryByRole('row', { name: 'Sem entrada' })).toBeNull()
  })

  it('a escolha vai para as configurações da biblioteca e para o índice guardado, e a pasta muda na hora', async () => {
    renderFolder()
    choose('group')
    expect(useLibraryStore.getState().index.settings.folderEntries).toBe('group')
    await waitFor(() => expect(saveIndex).toHaveBeenCalled())
    expect(saveIndex.mock.calls.at(-1)![0].settings.folderEntries).toBe('group')
    expect(select()).toHaveValue('group')
    expect(header('texto colado')).toBeInTheDocument()
  })

  it('lembra a escolha: com "Como item" guardado a pasta abre assim, e um valor que não existe volta ao padrão', () => {
    chosen('item')
    const first = renderFolder()
    expect(select()).toHaveValue('item')
    expect(noteKeys()).toContain('colado')
    first.unmount()
    chosen('invalido')
    renderFolder()
    expect(select()).toHaveValue('hide')
    expect(noteKeys()).not.toContain('colado')
  })

  it('no celular o controle continua na linha de ferramentas da pasta, sem o rótulo ao lado: cada escolha diz "Entradas:"', () => {
    narrowScreen()
    renderFolder()
    expect(within(select()).getAllByRole('option').map(option => option.textContent)).toEqual(['Entradas: Não mostrar', 'Entradas: Agrupar as notas', 'Entradas: Como item'])
    expect(screen.queryByText('Entradas:')).toBeNull()
    choose('group')
    expect(header('Sem entrada')).toBeInTheDocument()
  })

  it('a raiz e as outras pastas também têm o controle', () => {
    renderFolder('/biblioteca/fis')
    expect(select()).toBeInTheDocument()
  })
})

describe('"Agrupar as notas"', () => {
  beforeEach(() => chosen('group'))

  it('cada entrada vira um cabeçalho com as suas notas; as sem entrada vão depois, em "Sem entrada"', () => {
    renderFolder()
    expect(keys()).toEqual([...SUBPASTAS, 'grupo:pdf', 'aula-pdf', 'resumo', 'grupo:colado', 'ata-colado', 'grupo:none', ...SEM_ENTRADA])
  })

  it('uma nota nascida de outra nota fica na entrada do alto da família, e a mãe apagada ou que sumiu deixa a nota sem entrada', () => {
    renderFolder()
    const inPdf = keys().slice(keys().indexOf('grupo:pdf') + 1, keys().indexOf('grupo:colado'))
    expect(inPdf).toEqual(['aula-pdf', 'resumo'])
    expect(keys().slice(keys().indexOf('grupo:none'))).toEqual(expect.arrayContaining(['filha', 'orfa', 'sem-mae']))
  })

  it('o cabeçalho tem o ícone, o nome, o tipo e quantas notas há; a entrada de outra pasta diz onde mora', () => {
    renderFolder()
    const pdf = header('limites.pdf')
    expect(pdf).toHaveTextContent('limites.pdf')
    expect(pdf).toHaveTextContent('PDF')
    expect(pdf).toHaveTextContent('2 notas')
    expect(pdf).toHaveTextContent('Física II')
    expect(pdf.querySelector('svg')).not.toBeNull()
    expect(header('texto colado')).toHaveTextContent('Texto colado')
    expect(header('texto colado')).toHaveTextContent('1 nota')
    expect(header('texto colado')).not.toHaveTextContent('1 notas')
    expect(header('texto colado')).not.toHaveTextContent('Física II')
    expect(header('Sem entrada')).toHaveTextContent('7 notas')
  })

  it('o cabeçalho abre a página da entrada, pelo nome e pela linha; "Sem entrada" não leva a lugar nenhum', () => {
    renderFolder()
    expect(within(header('texto colado')).getByRole('link', { name: 'texto colado' })).toHaveAttribute('href', '/entrada/colado')
    expect(within(header('Sem entrada')).queryByRole('link')).toBeNull()
    fireEvent.click(header('limites.pdf'))
    expect(screen.getByLabelText('Endereço')).toHaveTextContent('/entrada/pdf')
  })

  it('o cabeçalho recolhe e abre as notas dele, sem abrir a entrada', () => {
    renderFolder()
    const toggle = () => within(header('limites.pdf')).getByRole('button', { name: /notas de limites\.pdf/ })
    expect(toggle()).toHaveAttribute('aria-expanded', 'true')
    fireEvent.click(toggle())
    expect(toggle()).toHaveAttribute('aria-expanded', 'false')
    expect(keys()).toEqual([...SUBPASTAS, 'grupo:pdf', 'grupo:colado', 'ata-colado', 'grupo:none', ...SEM_ENTRADA])
    expect(screen.queryByLabelText('Endereço')).toBeNull()
    fireEvent.click(toggle())
    expect(keys()).toContain('resumo')
    // "Sem entrada" também recolhe
    fireEvent.click(within(header('Sem entrada')).getByRole('button', { name: /notas sem entrada/ }))
    expect(keys()).toEqual([...SUBPASTAS, 'grupo:pdf', 'aula-pdf', 'resumo', 'grupo:colado', 'ata-colado', 'grupo:none'])
  })

  it('a ordem vale por grupo: os grupos pela entrada e as notas de cada um pela mesma coluna', () => {
    renderFolder()
    // Nome, de novo: do fim para o começo, "Sem entrada" continua por último
    fireEvent.click(within(table()).getByRole('button', { name: 'Nome' }))
    expect(keys()).toEqual([...SUBPASTAS, 'grupo:colado', 'ata-colado', 'grupo:pdf', 'resumo', 'aula-pdf', 'grupo:none', ...[...SEM_ENTRADA].reverse()])
    // Criado, mais novo primeiro: a entrada de 20/10 antes a de 10/10; dentro do PDF, o Resumo (15/10) antes da Aula (10/10)
    fireEvent.click(within(table()).getByRole('button', { name: 'Criado' }))
    const order = keys()
    expect(order.indexOf('grupo:colado')).toBeLessThan(order.indexOf('grupo:pdf'))
    expect(order.indexOf('resumo')).toBeLessThan(order.indexOf('aula-pdf'))
    expect(order.indexOf('grupo:none')).toBeGreaterThan(order.indexOf('aula-pdf'))
  })

  it('a nota debaixo do cabeçalho da própria entrada não repete "de: ..."; a nascida de outra nota continua dizendo de quem', () => {
    renderFolder()
    const row = (name: string) => within(table()).getByRole('row', { name })
    expect(within(row('Ata do texto colado')).queryByRole('link', { name: /^de:/ })).toBeNull()
    expect(within(row('Resumo da aula')).getByRole('link', { name: 'de: Aula do PDF de limites' })).toBeInTheDocument()
    expect(within(row('Exercícios resolvidos de limites')).getByRole('link', { name: 'de: Limites laterais e continuidade' })).toBeInTheDocument()
    expect(within(row('Nota órfã')).getByText(/mãe apagada/)).toBeInTheDocument()
  })

  it('as subpastas continuam na frente de tudo', () => {
    renderFolder()
    expect(keys().slice(0, 2)).toEqual(SUBPASTAS)
  })

  it('marcar uma nota do grupo funciona, e a caixa do cabeçalho marca as notas dele (não a entrada)', () => {
    renderFolder()
    fireEvent.click(within(table()).getByRole('checkbox', { name: 'Marcar Ata do texto colado' }))
    expect(selected()).toEqual(['ata-colado'])
    expect(toolbar()).toHaveTextContent('1 selecionado')
    fireEvent.click(within(header('limites.pdf')).getByRole('checkbox', { name: 'Marcar as notas de limites.pdf' }))
    expect(selected()).toEqual(['ata-colado', 'aula-pdf', 'resumo'])
    // todas marcadas: a caixa está marcada e um clique tira as do grupo
    expect(within(header('limites.pdf')).getByRole('checkbox', { name: 'Marcar as notas de limites.pdf' })).toBeChecked()
    fireEvent.click(within(header('limites.pdf')).getByRole('checkbox', { name: 'Marcar as notas de limites.pdf' }))
    expect(selected()).toEqual(['ata-colado'])
    // parte marcada: meio marcada
    fireEvent.click(within(table()).getByRole('checkbox', { name: 'Marcar Resumo da aula' }))
    expect((within(header('limites.pdf')).getByRole('checkbox', { name: 'Marcar as notas de limites.pdf' }) as HTMLInputElement).indeterminate).toBe(true)
  })

  it('"Marcar todos" marca as pastas e as notas, e o que fica recolhido sai da seleção', () => {
    renderFolder()
    fireEvent.click(within(table()).getByRole('checkbox', { name: 'Marcar todos' }))
    expect(selected()).toEqual([...SUBPASTAS, 'ata-colado', 'aula-pdf', 'resumo', ...SEM_ENTRADA].sort())
    fireEvent.click(within(header('limites.pdf')).getByRole('button', { name: /notas de limites\.pdf/ }))
    expect(selected()).not.toContain('aula-pdf')
    expect(selected()).not.toContain('resumo')
    expect(selected()).toContain('ata-colado')
  })

  it('arrastar e as opções funcionam nas notas do grupo e no cabeçalho da entrada', () => {
    renderFolder()
    expect(within(table()).getByRole('row', { name: 'Resumo da aula' })).toHaveAttribute('draggable', 'true')
    expect(within(header('texto colado')).getByRole('button', { name: 'Opções de texto colado' })).toBeInTheDocument()
    expect(header('texto colado')).toHaveAttribute('draggable', 'true')
  })

  it('os filtros valem: um grupo sem nota que passe some, e o que sobra continua agrupado', () => {
    renderFolder()
    fireEvent.click(within(group('Tipo')).getByRole('checkbox', { name: /^Ata\b/ }))
    expect(keys()).toEqual(['grupo:colado', 'ata-colado'])
    fireEvent.click(screen.getByRole('button', { name: 'Limpar tudo' }))
    expect(keys()).toContain('grupo:pdf')
  })

  it('o filtro de Etiqueta também vale, e o grupo fica só com a nota que a tem', () => {
    useLibraryStore.setState(state => ({ files: state.files.map(file => (file.id === 'resumo' ? { ...file, tags: ['revisar'] } : file)) }))
    renderFolder()
    fireEvent.click(within(group('Etiqueta')).getByRole('checkbox', { name: /^revisar\b/ }))
    expect(keys()).toEqual(['grupo:pdf', 'resumo'])
  })

  it('numa busca as notas voltam em lista, sem cabeçalhos, e o controle some', async () => {
    renderFolder()
    fireEvent.change(screen.getByRole('searchbox', { name: 'Buscar' }), { target: { value: 'texto colado' } })
    const found = await screen.findByRole('table', { name: 'Resultados da busca' })
    expect(found.querySelectorAll('[data-entry-group]')).toHaveLength(0)
    expect(screen.queryByRole('combobox', { name: 'Entradas' })).toBeNull()
    fireEvent.change(screen.getByRole('searchbox', { name: 'Buscar' }), { target: { value: '' } })
    await waitFor(() => expect(screen.queryByRole('table', { name: 'Resultados da busca' })).toBeNull())
    expect(select()).toHaveValue('group')
  })

  it('numa pasta sem nenhuma nota com entrada, o grupo "Sem entrada" junta todas; a entrada que mora ali sem notas ali não vira cabeçalho', () => {
    renderFolder('/biblioteca/fis')
    expect(keys()).toEqual(['grupo:none', 'ondas'])
  })

  it('numa pasta só com entradas, sem notas, continua dizendo que não há notas e apontando para "Entradas"', () => {
    useLibraryStore.setState(state => ({ files: [...state.files, entrada('so', 'Gravação', 'exer', VIDEO)] }))
    renderFolder('/biblioteca/exer')
    expect(screen.getByText('Nenhuma nota nesta pasta, só 1 entrada.')).toBeInTheDocument()
  })
})

describe('"Como item"', () => {
  beforeEach(() => chosen('item'))

  it('as entradas da pasta entram como linhas normais entre as notas, na mesma ordem; as de outra pasta ou na Lixeira não', () => {
    renderFolder()
    expect(keys()).toEqual([...SUBPASTAS, 'ata-colado', 'aula-pdf', 'derivadas-video', 'derivadas', 'filha', 'limites', 'monitoria', 'orfa', 'sem-mae', 'resumo', 'so-video', 'colado'])
    expect(screen.queryByRole('row', { name: 'limites.pdf' })).toBeNull()
    expect(screen.queryByRole('row', { name: 'Entrada apagada' })).toBeNull()
    expect(keys().some(key => key.startsWith('grupo:'))).toBe(false)
  })

  it('a entrada que mora numa pasta sem outras notas aparece ali, e a pasta só com entradas deixa de dizer que está sem nada', () => {
    useLibraryStore.setState(state => ({ files: [...state.files, entrada('so', 'Gravação', 'exer', VIDEO)] }))
    renderFolder('/biblioteca/exer')
    expect(keys()).toEqual(['so'])
    expect(screen.queryByText(/Nenhuma nota nesta pasta/)).toBeNull()
  })

  it('a linha da entrada diz que é entrada e o tipo, e abre a página da entrada', () => {
    renderFolder()
    const video = within(table()).getByRole('row', { name: 'Reunião de segunda' })
    expect(video).toHaveTextContent('Entrada · Vídeo')
    expect(within(table()).getByRole('row', { name: 'texto colado' })).toHaveTextContent('Entrada · Texto colado')
    expect(within(video).getByRole('link', { name: 'Reunião de segunda' })).toHaveAttribute('href', '/entrada/so-video')
    fireEvent.click(video)
    expect(screen.getByLabelText('Endereço')).toHaveTextContent('/entrada/so-video')
  })

  it('a nota continua dizendo de onde nasceu, e a entrada diz quantas notas deu', () => {
    renderFolder()
    expect(within(within(table()).getByRole('row', { name: 'Ata do texto colado' })).getByRole('link', { name: 'de: texto colado' })).toHaveAttribute('href', '/arquivo/colado')
    expect(within(table()).getByRole('row', { name: 'texto colado' })).toHaveTextContent('1 nota')
  })

  it('marcar, arrastar e as opções valem para a entrada como para qualquer linha', () => {
    renderFolder()
    fireEvent.click(within(table()).getByRole('checkbox', { name: 'Marcar texto colado' }))
    expect(selected()).toEqual(['colado'])
    const row = within(table()).getByRole('row', { name: 'texto colado' })
    expect(row).toHaveAttribute('draggable', 'true')
    expect(within(row).getByRole('button', { name: 'Opções de texto colado' })).toBeInTheDocument()
    fireEvent.click(within(table()).getByRole('checkbox', { name: 'Marcar todos' }))
    expect(selected()).toContain('so-video')
    expect(selected()).toHaveLength(SUBPASTAS.length + 12)
  })

  it('os filtros valem: o "Tipo" da nota deixa as entradas de fora, e a Etiqueta traz a entrada que a tem', () => {
    renderFolder()
    fireEvent.click(within(group('Tipo')).getByRole('checkbox', { name: /^Ata\b/ }))
    expect(keys()).toEqual(['ata-colado'])
    fireEvent.click(screen.getByRole('button', { name: 'Limpar tudo' }))
    fireEvent.click(within(group('Etiqueta')).getByRole('checkbox', { name: /^reuniao\b/ }))
    expect(keys()).toEqual(['so-video'])
  })

  it('a contagem dos filtros ativos soma as entradas que aparecem: 12 notas e 3 entradas vivas', () => {
    renderFolder()
    fireEvent.click(within(group('Etiqueta')).getByRole('checkbox', { name: /^reuniao\b/ }))
    expect(screen.getByText('1 de 15')).toBeInTheDocument()
    choose('hide')
    // sem a entrada à vista a etiqueta não acha nada, e o total volta a ser só de notas
    expect(screen.getByText('0 de 12')).toBeInTheDocument()
  })

  it('numa busca a lista é a de sempre, sem o controle', async () => {
    renderFolder()
    fireEvent.change(screen.getByRole('searchbox', { name: 'Buscar' }), { target: { value: 'reunião' } })
    await screen.findByRole('table', { name: 'Resultados da busca' })
    expect(screen.queryByRole('combobox', { name: 'Entradas' })).toBeNull()
  })
})

describe('só na navegação da pasta', () => {
  it('Entradas, Revisar e Favoritos não têm o controle nem mudam de forma', () => {
    chosen('group')
    const view = renderFolder('/entradas')
    expect(screen.queryByRole('combobox', { name: 'Entradas' })).toBeNull()
    expect(document.querySelector('[data-entry-group]')).toBeNull()
    view.unmount()
    renderFolder('/revisar')
    expect(screen.queryByRole('combobox', { name: 'Entradas' })).toBeNull()
    expect(document.querySelector('[data-entry-group]')).toBeNull()
  })

  it('num link compartilhado a pasta fica como é e o controle não aparece', () => {
    chosen('group')
    useLibraryStore.setState({ sharedView: { item: { id: 's', name: 's', folders: [], files: [] }, rootId: null } as never })
    renderFolder()
    expect(screen.queryByRole('combobox', { name: 'Entradas' })).toBeNull()
    expect(document.querySelector('[data-entry-group]')).toBeNull()
  })
})

describe('as regras do agrupamento (função pura)', () => {
  const all = [...FILES, ...EXTRA]
  const byId = (id: string) => all.find(file => file.id === id)!

  it('a entrada do alto da família: direta, por nota de nota, ou nenhuma', () => {
    expect(entryOfNote(all, byId('ata-colado'))?.id).toBe('colado')
    expect(entryOfNote(all, byId('resumo'))?.id).toBe('pdf')
    expect(entryOfNote(all, byId('limites'))).toBeNull()
    expect(entryOfNote(all, byId('filha'))).toBeNull()
    expect(entryOfNote(all, byId('orfa'))).toBeNull()
    expect(entryOfNote(all, byId('sem-mae'))).toBeNull()
  })

  it('um ciclo nos dados termina em "sem entrada"', () => {
    const a = note('a', 'A', 'calc', { parentFileId: 'b' })
    const b = note('b', 'B', 'calc', { parentFileId: 'a' })
    expect(entryOfNote([a, b], a)).toBeNull()
  })

  it('agrupa na ordem recebida, com os grupos na ordem dada e "sem entrada" por último', () => {
    const notes = ['resumo', 'ata-colado', 'limites', 'aula-pdf'].map(byId)
    const groups = groupNotesByEntry(all, notes, entries => [...entries].reverse())
    expect(groups.map(item => item.entry?.id ?? null)).toEqual(['colado', 'pdf', null])
    expect(groups.at(-1)!.notes.map(file => file.id)).toEqual(['limites'])
    expect(groups.find(item => item.entry?.id === 'pdf')!.notes.map(file => file.id)).toEqual(['resumo', 'aula-pdf'])
  })

  it('só os valores que existem valem; o resto é "Não mostrar"', () => {
    expect(folderEntriesOf({ folderEntries: 'group' })).toBe('group')
    expect(folderEntriesOf({ folderEntries: 'item' })).toBe('item')
    expect(folderEntriesOf({ folderEntries: 'hide' })).toBe('hide')
    expect(folderEntriesOf({})).toBe('hide')
    expect(folderEntriesOf({ folderEntries: 'qualquer' as never })).toBe('hide')
  })
})
