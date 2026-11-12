import { useState } from 'react'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { FilterPanel, type FilterPanelProps } from '@/components/library/FilterPanel'
import { newFileMeta } from '@/lib/defaults'
import { filterLibrary, GROUP_LABELS, NO_FILTERS, toggleOption, type FacetOption, type Facets, type FolderOption, type LibraryFilters } from '@/lib/library-filters'

const opt = <Id,>(id: Id, label: string, count: number, selected = false): FacetOption<Id> => ({ id, label, count, selected })
const folder = (id: string | null, label: string, depth: number, count = 1, selected = false): FolderOption => ({ ...opt(id, label, count, selected), depth })

const LONG = 'Curso completo de gestão de projetos, módulos 1 a 12, com os exercícios resolvidos'

const BASE: Facets = {
  noteKinds: [],
  kinds: [opt('video', 'Vídeo', 3), opt('audio', 'Áudio', 1), opt('pdf', 'PDF', 1), opt('link', 'Link', 2), opt('texto', 'Texto', 1), opt('tema', 'Tema', 0), opt('arquivo', 'Outro arquivo', 0), opt('nota', 'Nota', 2)],
  generated: [opt('ata', 'Ata', 2), opt('aula', 'Aula', 1), opt('explicacao', 'Explicação', 1), opt('leitura', 'Leitura', 0), opt('mapa', 'Mapa', 2), opt('cartoes', 'Cartões', 2), opt('tutor', 'Conversa do Tutor', 0), opt('nada', 'Nada ainda', 1)],
  period: [opt('hoje', 'Hoje', 4), opt('7dias', 'Últimos 7 dias', 7), opt('30dias', 'Últimos 30 dias', 8)],
  periodCustom: null,
  tags: [opt('contrato', 'contrato', 1), opt('cronograma', 'cronograma', 1), opt('derivadas', 'derivadas', 3)],
  folders: [folder(null, 'Biblioteca', 0, 8), folder('trab', 'Trabalho', 1, 6), folder('aurora', 'Projeto Aurora', 2, 4), folder('calc', 'Cálculo', 1, 5)],
  withSubfolders: null,
  places: [opt('drive', 'No meu Drive', 5), opt('navegador', 'Só neste navegador', 1), opt('temporario', 'Temporário', 0), opt('registro', 'Só o registro', 0), opt('apagado', 'Mídia apagada', 1)],
}

function facetsFor(filters: LibraryFilters, extra: Partial<Facets> = {}): Facets {
  const mark = <Id,>(list: FacetOption<Id>[], chosen: readonly Id[]) => list.map(item => ({ ...item, selected: chosen.includes(item.id) }))
  return {
    ...BASE,
    kinds: mark(BASE.kinds, filters.kinds),
    generated: mark(BASE.generated, filters.generated),
    period: mark(BASE.period, typeof filters.period === 'string' ? [filters.period] : []),
    tags: mark(BASE.tags, filters.tags),
    folders: BASE.folders.map(item => ({ ...item, selected: filters.folders.includes(item.id) })),
    withSubfolders: filters.folders.length ? 8 : null,
    places: mark(BASE.places, filters.places),
    ...extra,
  }
}

function renderPanel(filters: LibraryFilters = NO_FILTERS, props: Partial<FilterPanelProps> = {}, extra: Partial<Facets> = {}) {
  const onChange = vi.fn()
  const view = render(<FilterPanel filters={filters} facets={facetsFor(filters, extra)} onChange={onChange} {...props} />)
  return { onChange, ...view }
}

const group = (name: string) => screen.getByRole('group', { name })
const option = (name: string) => screen.getByRole('checkbox', { name: new RegExp(`^${name}\\b`) })
const radio = (name: string) => screen.getByRole('radio', { name: new RegExp(`^${name}`) })
const rowOf = (input: HTMLElement) => input.closest('label') as HTMLElement

describe('os grupos e as contagens à vista (FR-045)', () => {
  it('mostra os seis grupos, na ordem do desenho, sem abrir nada', () => {
    renderPanel()
    expect(screen.getByRole('complementary', { name: 'Filtros' })).toBeInTheDocument()
    expect(screen.getAllByRole('group').map(item => within(item).getAllByRole('button')[0].textContent)).toEqual(['Tipo', 'O que gerou', 'Período', 'Etiqueta', 'Pasta', 'Guardado'])
    // the folder's "Tipo" is the type of the note (FR-073), with the same name
    expect(Object.values(GROUP_LABELS)).toEqual(['Tipo', 'Tipo', 'O que gerou', 'Período', 'Etiqueta', 'Pasta', 'Guardado'])
  })

  it.each([
    ['Tipo', 'Vídeo', 3],
    ['Tipo', 'Nota', 2],
    ['Tipo', 'Outro arquivo', 0],
    ['O que gerou', 'Ata', 2],
    ['O que gerou', 'Conversa do Tutor', 0],
    ['Etiqueta', 'derivadas', 3],
    ['Pasta', 'Biblioteca', 8],
    ['Pasta', 'Projeto Aurora', 4],
    ['Guardado', 'No meu Drive', 5],
    ['Guardado', 'Temporário', 0],
  ])('%s: "%s" com %i', (name, label, count) => {
    renderPanel()
    const input = within(group(name)).getByRole('checkbox', { name: new RegExp(`^${label}\\b`) })
    expect(rowOf(input)).toHaveTextContent(new RegExp(`^${label}\\s*${count}$`))
  })

  it('Período mostra a contagem de cada atalho, e nenhum número em "Escolher datas…" sem datas', () => {
    renderPanel()
    expect(rowOf(radio('Hoje'))).toHaveTextContent(/^Hoje\s*4$/)
    expect(rowOf(radio('Últimos 7 dias'))).toHaveTextContent(/^Últimos 7 dias\s*7$/)
    expect(rowOf(radio('Últimos 30 dias'))).toHaveTextContent(/^Últimos 30 dias\s*8$/)
    expect(rowOf(radio('Escolher datas…'))).toHaveTextContent(/^Escolher datas…$/)
  })

  it('o nome acessível começa pela opção e diz a contagem', () => {
    renderPanel()
    expect(screen.getByRole('checkbox', { name: /^Nota\b/ })).toBeInTheDocument()
    expect(screen.getByRole('checkbox', { name: /^derivadas\b/ })).toBeInTheDocument()
    expect(screen.getByRole('checkbox', { name: 'Vídeo, 3 itens' })).toBeInTheDocument()
    expect(screen.getByRole('checkbox', { name: 'Áudio, 1 item' })).toBeInTheDocument()
    expect(screen.getByRole('radio', { name: 'Hoje, 4 itens' })).toBeInTheDocument()
  })

  it('opção sem nenhum item fica à vista e apagada, a não ser que esteja marcada', () => {
    renderPanel({ ...NO_FILTERS, kinds: ['arquivo'] })
    expect(option('Tema')).toBeEnabled()
    expect(option('Tema').closest('.fp-row')).toHaveClass('fp-zero')
    expect(option('Outro arquivo').closest('.fp-row')).not.toHaveClass('fp-zero')
    expect(option('Vídeo').closest('.fp-row')).not.toHaveClass('fp-zero')
  })

  it('a opção marcada aparece marcada, as outras não', () => {
    renderPanel({ ...NO_FILTERS, kinds: ['video'], generated: ['ata'], tags: ['derivadas'], folders: ['calc'], places: ['apagado'] })
    for (const name of ['Vídeo', 'Ata', 'derivadas', 'Cálculo', 'Mídia apagada']) expect(option(name)).toBeChecked()
    for (const name of ['Áudio', 'Aula', 'contrato', 'Trabalho', 'No meu Drive']) expect(option(name)).not.toBeChecked()
  })
})

describe('marcar e desmarcar (FR-044)', () => {
  it.each([
    ['kinds', 'Nota', 'nota'],
    ['generated', 'Mapa', 'mapa'],
    ['tags', 'contrato', 'contrato'],
    ['folders', 'Biblioteca', null],
    ['folders', 'Cálculo', 'calc'],
    ['places', 'Só o registro', 'registro'],
  ] as const)('%s: clicar em "%s" troca só aquela opção', (key, label, id) => {
    const start: LibraryFilters = { ...NO_FILTERS, kinds: ['pdf'] }
    const { onChange } = renderPanel(start)
    fireEvent.click(option(label))
    expect(onChange).toHaveBeenCalledTimes(1)
    expect(onChange).toHaveBeenCalledWith(toggleOption(start, key, id as never))
  })

  it('desmarca o que estava marcado', () => {
    const start: LibraryFilters = { ...NO_FILTERS, kinds: ['pdf', 'nota'] }
    const { onChange } = renderPanel(start)
    fireEvent.click(option('PDF'))
    expect(onChange).toHaveBeenCalledWith({ ...start, kinds: ['nota'] })
  })

  it('"só este" deixa apenas aquela opção no grupo, sem mexer nos outros grupos', () => {
    const start: LibraryFilters = { ...NO_FILTERS, kinds: ['video', 'audio'], tags: ['contrato'] }
    const { onChange } = renderPanel(start)
    fireEvent.click(screen.getByRole('button', { name: 'só este: PDF' }))
    expect(onChange).toHaveBeenCalledWith({ ...start, kinds: ['pdf'] })
  })

  it('"só este" some quando a opção já é a única marcada', () => {
    renderPanel({ ...NO_FILTERS, kinds: ['pdf'] })
    expect(screen.queryByRole('button', { name: 'só este: PDF' })).toBeNull()
    expect(screen.getByRole('button', { name: 'só este: Vídeo' })).toBeInTheDocument()
  })
})

describe('Período', () => {
  it('a chave Atualizado/Criado mostra a escolhida e troca o campo da data', () => {
    const start: LibraryFilters = { ...NO_FILTERS, period: '30dias' }
    const { onChange } = renderPanel(start)
    const chave = within(screen.getByRole('radiogroup', { name: 'Data do período' }))
    expect(chave.getByRole('radio', { name: 'Atualizado' })).toBeChecked()
    expect(chave.getByRole('radio', { name: 'Criado' })).not.toBeChecked()
    fireEvent.click(chave.getByRole('radio', { name: 'Criado' }))
    expect(onChange).toHaveBeenCalledWith({ ...start, dateField: 'created' })
  })

  it('a chave acompanha o estado', () => {
    renderPanel({ ...NO_FILTERS, dateField: 'created' })
    expect(screen.getByRole('radio', { name: 'Criado' })).toBeChecked()
    expect(screen.getByRole('radio', { name: 'Atualizado' })).not.toBeChecked()
  })

  it('escolhe um atalho, marca só ele e troca por outro', () => {
    const { onChange } = renderPanel({ ...NO_FILTERS, period: '7dias' })
    expect(radio('Últimos 7 dias')).toBeChecked()
    expect(radio('Hoje')).not.toBeChecked()
    fireEvent.click(radio('Últimos 30 dias'))
    expect(onChange).toHaveBeenCalledWith({ ...NO_FILTERS, period: '30dias' })
  })

  it('clicar no atalho já marcado tira o período', () => {
    const { onChange } = renderPanel({ ...NO_FILTERS, period: '7dias' })
    fireEvent.click(radio('Últimos 7 dias'))
    expect(onChange).toHaveBeenCalledWith({ ...NO_FILTERS, period: null })
  })

  it('"Escolher datas…" abre os campos, e cada campo muda o seu lado', () => {
    const start: LibraryFilters = { ...NO_FILTERS, period: { to: '2026-10-31' } }
    const { onChange } = renderPanel(start, {}, { periodCustom: 5 })
    expect(radio('Escolher datas…')).toBeChecked()
    expect(rowOf(radio('Escolher datas…'))).toHaveTextContent(/^Escolher datas…\s*5$/)
    expect(screen.getByLabelText('De')).toHaveValue('')
    expect(screen.getByLabelText('Até')).toHaveValue('31/10/2026')
    fireEvent.change(screen.getByLabelText('De'), { target: { value: '2026-10-01' } })
    expect(onChange).toHaveBeenLastCalledWith({ ...start, period: { from: '2026-10-01', to: '2026-10-31' } })
    fireEvent.change(screen.getByLabelText('Até'), { target: { value: '' } })
    expect(onChange).toHaveBeenLastCalledWith({ ...start, period: { to: undefined } })
  })

  it('sem "Escolher datas…" marcado os campos não aparecem; ao marcar, começa sem dias', () => {
    const { onChange } = renderPanel()
    expect(screen.queryByLabelText('De')).toBeNull()
    fireEvent.click(radio('Escolher datas…'))
    expect(onChange).toHaveBeenCalledWith({ ...NO_FILTERS, period: {} })
  })

  it('"Escolher datas…" marcado, clicar de novo tira o período', () => {
    const { onChange } = renderPanel({ ...NO_FILTERS, period: {} })
    expect(screen.getByLabelText('De')).toBeInTheDocument()
    fireEvent.click(radio('Escolher datas…'))
    expect(onChange).toHaveBeenCalledWith({ ...NO_FILTERS, period: null })
  })
})

describe('o resumo do que está ativo', () => {
  it('"3 ativos" conta grupos, não opções', () => {
    renderPanel({ ...NO_FILTERS, kinds: ['video', 'nota'], period: '30dias', folders: ['aurora'] })
    expect(screen.getByText('3 ativos')).toBeInTheDocument()
  })

  it('singular e nada quando não há filtro; período sem dias não conta', () => {
    const { rerender, onChange } = renderPanel({ ...NO_FILTERS, tags: ['contrato'] })
    expect(screen.getByText('1 ativo')).toBeInTheDocument()
    const empty = { ...NO_FILTERS, period: {} }
    rerender(<FilterPanel filters={empty} facets={facetsFor(empty)} onChange={onChange} />)
    expect(screen.queryByText(/ativo/)).toBeNull()
  })

  it('período com datas conta como um', () => {
    renderPanel({ ...NO_FILTERS, period: { from: '2026-10-01' } }, {}, { periodCustom: 5 })
    expect(screen.getByText('1 ativo')).toBeInTheDocument()
  })

  it('cada grupo mostra quantas opções tem marcadas, como no desenho', () => {
    renderPanel({ ...NO_FILTERS, kinds: ['video', 'audio', 'pdf', 'nota'], period: 'hoje' })
    expect(group('Tipo').querySelector('.fp-num')).toHaveTextContent('4')
    expect(group('Período').querySelector('.fp-num')).toHaveTextContent('1')
    expect(group('O que gerou').querySelector('.fp-num')).toBeNull()
  })
})

describe('Pasta', () => {
  it('o recuo segue a profundidade, com teto', () => {
    const deep = folder('fundo', 'Muito fundo', 30)
    renderPanel(NO_FILTERS, {}, { folders: [...BASE.folders, deep] })
    const depthOf = (name: string) => rowOf(option(name)).style.getPropertyValue('--fp-depth')
    expect(depthOf('Biblioteca')).toBe('')
    expect(depthOf('Trabalho')).toBe('1')
    expect(depthOf('Projeto Aurora')).toBe('2')
    expect(Number(depthOf('Muito fundo'))).toBeLessThanOrEqual(5)
  })

  it('"Com subpastas" só aparece com pasta escolhida, com a contagem, e troca a opção', () => {
    const start: LibraryFilters = { ...NO_FILTERS, folders: ['aurora'] }
    const { onChange } = renderPanel(start)
    const box = within(group('Pasta')).getByRole('checkbox', { name: /^Com subpastas\b/ })
    expect(box).toBeChecked()
    expect(rowOf(box)).toHaveTextContent(/^Com subpastas\s*8$/)
    fireEvent.click(box)
    expect(onChange).toHaveBeenCalledWith({ ...start, subfolders: false })
  })

  it('sem pasta escolhida não há "Com subpastas"', () => {
    renderPanel()
    expect(screen.queryByRole('checkbox', { name: /^Com subpastas\b/ })).toBeNull()
  })

  it('o título do grupo mostra a pasta escolhida; com várias, quantas', () => {
    const { rerender, onChange } = renderPanel({ ...NO_FILTERS, folders: ['aurora'] })
    expect(group('Pasta').querySelector('.fp-sum')).toHaveTextContent('Projeto Aurora')
    const two: LibraryFilters = { ...NO_FILTERS, folders: ['aurora', 'calc'] }
    rerender(<FilterPanel filters={two} facets={facetsFor(two)} onChange={onChange} />)
    expect(group('Pasta').querySelector('.fp-sum')).toHaveTextContent('2 pastas')
  })
})

describe('listas longas e nomes longos', () => {
  const css = readFileSync(path.resolve(__dirname, '../../styles/filter-panel.css'), 'utf8')
  const rule = (selector: string) => {
    const at = css.indexOf(`${selector}{`)
    return at < 0 ? '' : css.slice(at, css.indexOf('}', at))
  }
  const manyTags = Array.from({ length: 14 }, (_, index) => opt(`etiqueta-${index + 1}`, `etiqueta-${index + 1}`, 1, index === 11))
  const tagBoxes = () => within(group('Etiqueta')).getAllByRole('checkbox')

  it('Etiqueta mostra as primeiras e a marcada; "Ver as 14" abre todas e "Ver menos" fecha', () => {
    renderPanel({ ...NO_FILTERS, tags: ['etiqueta-12'] }, {}, { tags: manyTags })
    expect(tagBoxes()).toHaveLength(6)
    expect(option('etiqueta-12')).toBeChecked()
    fireEvent.click(within(group('Etiqueta')).getByRole('button', { name: 'Ver as 14' }))
    expect(tagBoxes()).toHaveLength(14)
    fireEvent.click(within(group('Etiqueta')).getByRole('button', { name: 'Ver menos' }))
    expect(tagBoxes()).toHaveLength(6)
  })

  it('Pasta longa também tem "Ver as", e lista curta não tem', () => {
    const folders = [folder(null, 'Biblioteca', 0), ...Array.from({ length: 8 }, (_, index) => folder(`p${index}`, `Pasta ${index}`, 1))]
    renderPanel(NO_FILTERS, {}, { folders })
    expect(within(group('Pasta')).getByRole('button', { name: 'Ver as 9' })).toBeInTheDocument()
    expect(within(group('Etiqueta')).queryByRole('button', { name: /^Ver as/ })).toBeNull()
  })

  it('Tipo mostra tudo, mesmo com mais de cinco opções', () => {
    renderPanel()
    expect(within(group('Tipo')).getAllByRole('checkbox')).toHaveLength(BASE.kinds.length)
  })

  it('nome longo corta com reticências e o nome inteiro fica no title', () => {
    renderPanel(NO_FILTERS, {}, { folders: [folder('longa', LONG, 1)] })
    expect(screen.getByText(LONG)).toHaveAttribute('title', LONG)
    expect(rule('.fp-name')).toContain('text-overflow:ellipsis')
    expect(rule('.fp-name')).toContain('min-width:0')
  })

  it('o painel tem 220 px', () => {
    expect(rule('.fp')).toContain('width:220px')
  })
})

describe('recolher', () => {
  it('um grupo fecha e abre, sem afetar os outros; fechado, segue mostrando quantos tem marcados', () => {
    renderPanel({ ...NO_FILTERS, kinds: ['video'] })
    fireEvent.click(screen.getByRole('button', { name: 'Tipo', expanded: true }))
    expect(within(group('Tipo')).queryAllByRole('checkbox')).toEqual([])
    expect(group('Tipo').querySelector('.fp-num')).toHaveTextContent('1')
    expect(option('Ata')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Tipo', expanded: false }))
    expect(option('Vídeo')).toBeChecked()
  })

  it('o painel recolhe por um botão', () => {
    const onCollapsedChange = vi.fn()
    renderPanel(NO_FILTERS, { collapsed: false, onCollapsedChange })
    fireEvent.click(screen.getByRole('button', { name: 'Recolher os filtros', expanded: true }))
    expect(onCollapsedChange).toHaveBeenCalledWith(true)
  })

  it('recolhido, não mostra as opções, e diz quantos estão ativos; o botão volta a abrir', () => {
    const onCollapsedChange = vi.fn()
    renderPanel({ ...NO_FILTERS, kinds: ['video'], tags: ['contrato'] }, { collapsed: true, onCollapsedChange })
    expect(screen.queryAllByRole('checkbox')).toEqual([])
    expect(screen.getByRole('complementary', { name: 'Filtros' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Mostrar os filtros, 2 ativos', expanded: false }))
    expect(onCollapsedChange).toHaveBeenCalledWith(false)
  })

  it('recolhido e sem filtro, o botão só diz "Mostrar os filtros"', () => {
    renderPanel(NO_FILTERS, { collapsed: true })
    expect(screen.getByRole('button', { name: 'Mostrar os filtros' })).toBeInTheDocument()
  })
})

describe('no celular, gaveta', () => {
  it('fechada, não mostra nada', () => {
    renderPanel(NO_FILTERS, { drawer: true, open: false })
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(screen.queryAllByRole('checkbox')).toEqual([])
  })

  it('aberta, é um diálogo com nome, com os mesmos grupos, opções e resumo', () => {
    const start: LibraryFilters = { ...NO_FILTERS, kinds: ['video'] }
    const { onChange } = renderPanel(start, { drawer: true, open: true, onClose: vi.fn() })
    const drawer = screen.getByRole('dialog', { name: 'Filtros' })
    expect(drawer).toHaveAttribute('aria-modal', 'true')
    expect(within(drawer).getAllByRole('group')).toHaveLength(6)
    expect(within(drawer).getByText('1 ativo')).toBeInTheDocument()
    fireEvent.click(within(drawer).getByRole('checkbox', { name: /^Nota\b/ }))
    expect(onChange).toHaveBeenCalledWith({ ...start, kinds: ['video', 'nota'] })
  })

  it('fecha pelo X, pelo Esc e tocando fora; tocar dentro não fecha', () => {
    const onClose = vi.fn()
    renderPanel(NO_FILTERS, { drawer: true, open: true, onClose })
    const drawer = screen.getByRole('dialog', { name: 'Filtros' })
    expect(screen.queryByRole('button', { name: 'Recolher os filtros' })).toBeNull()

    fireEvent.click(within(drawer).getByRole('button', { name: 'Fechar os filtros' }))
    expect(onClose).toHaveBeenCalledTimes(1)
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(2)
    fireEvent.mouseDown(drawer.parentElement as HTMLElement)
    expect(onClose).toHaveBeenCalledTimes(3)
    fireEvent.mouseDown(drawer)
    expect(onClose).toHaveBeenCalledTimes(3)
  })

  it('ao abrir, o foco entra na gaveta; ao fechar, volta para onde estava', () => {
    const facets = facetsFor(NO_FILTERS)
    const Host = ({ open }: { open: boolean }) => (
      <>
        <button>Abrir</button>
        <FilterPanel filters={NO_FILTERS} facets={facets} onChange={vi.fn()} drawer open={open} onClose={vi.fn()} />
      </>
    )
    const { rerender } = render(<Host open={false} />)
    const opener = screen.getByRole('button', { name: 'Abrir' })
    opener.focus()
    rerender(<Host open />)
    expect(screen.getByRole('dialog', { name: 'Filtros' })).toContainElement(document.activeElement as HTMLElement)
    rerender(<Host open={false} />)
    expect(opener).toHaveFocus()
  })
})

describe('com as contagens de verdade', () => {
  function Live() {
    const [filters, setFilters] = useState(NO_FILTERS)
    const { facets } = filterLibrary({ files: [], folders: [], now: '2026-11-08T12:00:00Z' }, filters)
    return <FilterPanel filters={filters} facets={facets} onChange={setFilters} />
  }

  it('marca, troca a chave, escolhe datas e mostra "Com subpastas", a partir de `filterLibrary`', () => {
    render(<Live />)
    fireEvent.click(option('Nota'))
    expect(option('Nota')).toBeChecked()
    fireEvent.click(screen.getByRole('radio', { name: 'Criado' }))
    expect(screen.getByRole('radio', { name: 'Criado' })).toBeChecked()
    fireEvent.click(radio('Últimos 7 dias'))
    expect(radio('Últimos 7 dias')).toBeChecked()
    expect(screen.getByText('2 ativos')).toBeInTheDocument()
    fireEvent.click(radio('Escolher datas…'))
    expect(radio('Últimos 7 dias')).not.toBeChecked()
    expect(screen.getByText('1 ativo')).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('De'), { target: { value: '2026-11-01' } })
    expect(screen.getByLabelText('De')).toHaveValue('01/11/2026')
    expect(screen.getByText('2 ativos')).toBeInTheDocument()
    fireEvent.click(option('Biblioteca'))
    expect(option('Biblioteca')).toBeChecked()
    expect(option('Com subpastas')).toBeChecked()
    expect(screen.getByText('3 ativos')).toBeInTheDocument()
  })
})

describe('as datas do período em português (dd/mm/aaaa)', () => {
  const stamp = (at: string) => ({ at, deviceId: 'd1', deviceName: 'Teste' })
  const note = (id: string, at: string) => newFileMeta({ id, name: id, type: 'class', created: stamp(at), updated: stamp(at) })
  const FILES = [note('antes', '2026-11-04T15:00:00Z'), note('no-dia', '2026-11-05T15:00:00Z'), note('depois', '2026-11-08T12:00:00Z')]
  const source = { files: FILES, folders: [], now: '2026-11-08T15:00:00Z', timeZone: 'America/Sao_Paulo' }

  function Live({ seen }: { seen: (ids: string[], filters: LibraryFilters) => void }) {
    const [filters, setFilters] = useState<LibraryFilters>({ ...NO_FILTERS, period: {} })
    const { facets, items } = filterLibrary(source, filters)
    seen(items.map(item => item.id), filters)
    return <FilterPanel filters={filters} facets={facets} onChange={setFilters} />
  }

  it('não usa o campo de data do navegador, que desenha no idioma dele', () => {
    const { container } = renderPanel({ ...NO_FILTERS, period: { from: '2026-11-05' } })
    expect(container.querySelector('input[type="date"]')).toBeNull()
    expect(screen.getByLabelText('De')).toHaveValue('05/11/2026')
    expect(screen.getByLabelText('De')).toHaveAttribute('placeholder', 'dd/mm/aaaa')
  })

  it('digitar 05/11/2026 em "De" filtra a partir daquele dia', async () => {
    const user = userEvent.setup()
    const seen = vi.fn()
    render(<Live seen={seen} />)
    expect(seen).toHaveBeenLastCalledWith(['antes', 'no-dia', 'depois'], expect.anything())
    await user.type(screen.getByLabelText('De'), '05112026')
    expect(screen.getByLabelText('De')).toHaveValue('05/11/2026')
    expect(seen).toHaveBeenLastCalledWith(['no-dia', 'depois'], expect.objectContaining({ period: { from: '2026-11-05' } }))
  })

  it('"Até" 05/11/2026 filtra até aquele dia, e os dois juntos fecham o intervalo', async () => {
    const user = userEvent.setup()
    const seen = vi.fn()
    render(<Live seen={seen} />)
    await user.type(screen.getByLabelText('Até'), '05112026')
    expect(seen).toHaveBeenLastCalledWith(['antes', 'no-dia'], expect.objectContaining({ period: { to: '2026-11-05' } }))
    await user.type(screen.getByLabelText('De'), '05/11/2026')
    expect(seen).toHaveBeenLastCalledWith(['no-dia'], expect.objectContaining({ period: { from: '2026-11-05', to: '2026-11-05' } }))
  })

  it('colar 2026-11-05 também vale, e o filtro recebe aaaa-mm-dd', async () => {
    const user = userEvent.setup()
    const { onChange } = renderPanel({ ...NO_FILTERS, period: {} })
    await user.click(screen.getByLabelText('De'))
    await user.paste('2026-11-05')
    expect(screen.getByLabelText('De')).toHaveValue('05/11/2026')
    expect(onChange).toHaveBeenLastCalledWith({ ...NO_FILTERS, period: { from: '2026-11-05' } })
  })

  it('data que não existe mostra a frase e não muda o filtro', async () => {
    const user = userEvent.setup()
    const start: LibraryFilters = { ...NO_FILTERS, period: { from: '2026-10-01' } }
    const { onChange } = renderPanel(start)
    await user.clear(screen.getByLabelText('De'))
    onChange.mockClear()
    await user.type(screen.getByLabelText('De'), '31022026')
    expect(screen.getByRole('alert')).toHaveTextContent('Essa data não existe.')
    expect(onChange).not.toHaveBeenCalled()
  })

  it('apagar o campo limpa só aquela ponta', async () => {
    const user = userEvent.setup()
    const start: LibraryFilters = { ...NO_FILTERS, period: { from: '2026-10-01', to: '2026-10-31' } }
    const { onChange } = renderPanel(start)
    await user.clear(screen.getByLabelText('Até'))
    expect(onChange).toHaveBeenLastCalledWith({ ...start, period: { from: '2026-10-01', to: undefined } })
  })

  it('o calendário de "De" escolhe um dia e o filtro recebe aaaa-mm-dd', async () => {
    const user = userEvent.setup()
    const { onChange } = renderPanel({ ...NO_FILTERS, period: { from: '2026-10-01' } })
    await user.click(screen.getByRole('button', { name: 'Abrir o calendário: De' }))
    const calendar = screen.getByRole('dialog', { name: 'Calendário: De' })
    expect(within(calendar).getByText('outubro de 2026')).toBeInTheDocument()
    await user.click(within(calendar).getByRole('button', { name: /15 de outubro de 2026/ }))
    expect(onChange).toHaveBeenLastCalledWith({ ...NO_FILTERS, period: { from: '2026-10-15' } })
  })

  it('na gaveta do celular, Esc fecha só o calendário; o segundo Esc fecha a gaveta', async () => {
    const user = userEvent.setup()
    const onClose = vi.fn()
    renderPanel({ ...NO_FILTERS, period: { from: '2026-10-01' } }, { drawer: true, open: true, onClose })
    await user.click(screen.getByRole('button', { name: 'Abrir o calendário: De' }))
    expect(screen.getByRole('dialog', { name: 'Calendário: De' })).toBeInTheDocument()
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('dialog', { name: 'Calendário: De' })).toBeNull()
    expect(onClose).not.toHaveBeenCalled()
    await user.keyboard('{Escape}')
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})
