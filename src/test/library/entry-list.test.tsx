import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it } from 'vitest'
import { fireEvent, render, screen, within } from '@testing-library/react'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'

import type { ArtifactSummary, FileMeta, SourceMeta } from '@/types/domain'
import { ReaderShell } from '@/components/layout/ReaderShell'
import { ColumnsShell, FocusShell } from '@/components/layout/OtherShells'
import { EntryList } from '@/components/library/EntryList'
import { useLibraryStore } from '@/stores/library'
import { useUiStore } from '@/stores/ui'
import { FILES, seedLibrary } from '@/test/library/explorer-fixture'

const art = (id: string): ArtifactSummary => ({ id, kind: 'mapa', name: id, updatedAt: '2026-11-07T10:00:00Z' })
const at = (iso: string) => ({ at: iso, deviceId: 'local', deviceName: 'Este computador' })

function item(id: string, name: string, folderId: string | null, extra: Partial<FileMeta> = {}): FileMeta {
  return { ...FILES[0], id, name, folderId, tags: [], mastery: null, ...extra }
}

function entry(id: string, name: string, folderId: string | null, origin: SourceMeta, day: string, extra: Partial<FileMeta> = {}): FileMeta {
  return item(id, name, folderId, { role: 'entrada', kept: 'registro', origin, created: at(`${day}T12:00:00Z`), updated: at(`${day}T12:00:00Z`), ...extra })
}

const ENTRIES = [
  entry('e-video', 'Reunião de kickoff.mp4', 'calc', { input: 'file', name: 'kickoff.mp4', mime: 'video/mp4', storage: 'drive' }, '2026-11-03'),
  entry('e-pdf', 'Contrato de serviços.pdf', 'integ', { input: 'file', name: 'contrato.pdf', mime: 'application/pdf', storage: 'drive' }, '2026-10-28'),
  entry('e-link', 'Guia de juros compostos', null, { input: 'url', name: 'Guia de juros compostos', url: 'https://exemplo.com/juros', storage: 'none' }, '2026-10-21'),
  entry('e-texto', 'Texto colado · 06/11', 'fis', { input: 'text', name: 'texto colado', mime: 'text/plain', sizeBytes: 120, storage: 'none' }, '2026-11-06'),
  entry('e-tema', 'Tema: orçamento base zero', 'fis', { input: 'topic', name: 'orçamento base zero', storage: 'none' }, '2026-11-02'),
  entry('e-audio', 'Gravação da aula 3.webm', 'calc', { input: 'recording', name: 'aula3.webm', mime: 'audio/webm', storage: 'none' }, '2026-11-07'),
]

const GONE = entry('e-apagada', 'Entrada na Lixeira.mp4', 'calc', { input: 'file', name: 'x.mp4', mime: 'video/mp4', storage: 'none' }, '2026-11-01', { deletedAt: '2026-11-07T10:00:00Z' })

/** The video's family spreads over three folders: 3 notas and 1 artefato; the PDF has one live note and one in the Lixeira. */
const FAMILY = [
  item('ata', 'Ata do kickoff', 'fis', { parentFileId: 'e-video', artifacts: [art('m1')] }),
  item('aula', 'Aula do kickoff', 'calc', { parentFileId: 'e-video' }),
  item('filha', 'Resumo da ata', 'integ', { parentFileId: 'ata' }),
  item('clausulas', 'Cláusulas do contrato', 'integ', { parentFileId: 'e-pdf' }),
  item('rascunho', 'Rascunho apagado', 'integ', { parentFileId: 'e-pdf', deletedAt: '2026-11-07T10:00:00Z' }),
]

function Where() {
  return <output aria-label="Endereço">{useLocation().pathname}</output>
}

function renderList() {
  return render(
    <MemoryRouter initialEntries={['/entradas']}>
      <Routes>
        <Route path="*" element={<><EntryList /><Where /></>} />
      </Routes>
    </MemoryRouter>,
  )
}

function renderShell(path: string, shell: (children: ReactNode) => ReactNode) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="*" element={shell(<Where />)} />
      </Routes>
    </MemoryRouter>,
  )
}

const rows = () => within(screen.getByRole('table', { name: 'Entradas' })).getAllByRole('row').slice(1)
const rowOf = (name: string) => rows().find(row => row.textContent?.includes(name))!
const KINDS = ['Vídeo', 'Áudio', 'PDF', 'Link', 'Texto colado', 'Tema']

beforeEach(() => {
  seedLibrary()
  useUiStore.getState().clearFilters()
  useUiStore.setState({ selection: new Set() })
  useLibraryStore.setState(state => ({ files: [...state.files, ...ENTRIES, GONE, ...FAMILY] }))
})

describe('lista de entradas (FR-026)', () => {
  it('lista todas as entradas vivas, de qualquer pasta, sem as notas e sem as apagadas', () => {
    renderList()
    expect(rows()).toHaveLength(ENTRIES.length)
    const text = rows().map(row => row.textContent).join(' ')
    for (const item of ENTRIES) expect(text).toContain(item.name)
    expect(text).not.toContain(GONE.name)
    for (const note of [...FILES, ...FAMILY]) expect(text).not.toContain(note.name)
  })

  it('mostra o tipo de cada entrada: vídeo, PDF, link, texto colado, tema e áudio', () => {
    renderList()
    // the kind is the line under the name, as in the explorer's table
    const kindOf = (name: string) => KINDS.filter(kind => within(rowOf(name)).queryByText(kind) !== null)
    expect(kindOf('Reunião de kickoff.mp4')).toEqual(['Vídeo'])
    expect(kindOf('Contrato de serviços.pdf')).toEqual(['PDF'])
    expect(kindOf('Guia de juros compostos')).toEqual(['Link'])
    expect(kindOf('Texto colado · 06/11')).toEqual(['Texto colado'])
    expect(kindOf('Tema: orçamento base zero')).toEqual(['Tema'])
    expect(kindOf('Gravação da aula 3.webm')).toEqual(['Áudio'])
  })

  it('conta a família inteira em qualquer pasta, sem o que está na Lixeira', () => {
    renderList()
    expect(within(rowOf('Reunião de kickoff.mp4')).getByText('3 notas · 1 artefato')).toBeInTheDocument()
    expect(within(rowOf('Contrato de serviços.pdf')).getByText('1 nota')).toBeInTheDocument()
    expect(within(rowOf('Guia de juros compostos')).getByText('Nada ainda')).toBeInTheDocument()
  })

  it('mostra a pasta e a data, da mais nova para a mais antiga', () => {
    renderList()
    expect(rowOf('Contrato de serviços.pdf')).toHaveTextContent('Integrais')
    expect(rowOf('Guia de juros compostos')).toHaveTextContent('Biblioteca')
    expect(rowOf('Reunião de kickoff.mp4')).toHaveTextContent('03/11/2026')
    expect(rows()[0]).toHaveTextContent('Gravação da aula 3.webm')
    expect(rows().at(-1)).toHaveTextContent('Guia de juros compostos')
  })

  it('cada entrada leva à sua página, pelo nome ou pela linha', () => {
    renderList()
    for (const item of ENTRIES) expect(within(rowOf(item.name)).getByRole('link', { name: item.name })).toHaveAttribute('href', `/entrada/${item.id}`)
    fireEvent.click(within(rowOf('Contrato de serviços.pdf')).getByText('Integrais'))
    expect(screen.getByRole('status', { name: 'Endereço' })).toHaveTextContent('/entrada/e-pdf')
  })

  it('sem entradas, diz o que aparece aqui e oferece criar', () => {
    useLibraryStore.setState({ files: [...FILES, GONE] })
    renderList()
    expect(screen.queryByRole('table', { name: 'Entradas' })).toBeNull()
    expect(screen.getByText('Nenhuma entrada ainda')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Novo' })).toBeInTheDocument()
  })
})

describe('o mesmo painel e a mesma tabela do explorador (FR-044, FR-045, US4)', () => {
  const panel = () => screen.getByRole('complementary', { name: 'Filtros' })
  const option = (name: string) => within(panel()).getByRole('checkbox', { name: new RegExp(`^${name}\\b`) })
  const head = (name: string) => within(screen.getByRole('table', { name: 'Entradas' })).getByRole('button', { name })
  const order = () => rows().map(row => row.getAttribute('data-file-id'))

  it('tem o painel de filtros do explorador, com os grupos e as contagens só das entradas', () => {
    renderList()
    for (const name of ['Tipo', 'O que gerou', 'Período', 'Etiqueta', 'Pasta', 'Guardado']) expect(within(panel()).getByRole('group', { name })).toBeInTheDocument()
    expect(option('Vídeo')).toHaveAccessibleName('Vídeo, 1 item')
    expect(option('Nota')).toHaveAccessibleName('Nota, 0 itens')
  })

  it('filtrar por tipo deixa só aquele tipo, com a linha de filtros ativos, a contagem e "Limpar tudo"', () => {
    renderList()
    fireEvent.click(option('Vídeo'))
    expect(rows()).toHaveLength(1)
    expect(rows()[0]).toHaveTextContent('Reunião de kickoff.mp4')
    const active = screen.getByRole('group', { name: 'Filtros ativos' })
    expect(active).toHaveTextContent('Tipo')
    expect(screen.getByText('1 de 6')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Limpar tudo' }))
    expect(rows()).toHaveLength(ENTRIES.length)
  })

  it('filtro que não acha nada diz isso, em vez de mostrar a tela de lista vazia', () => {
    renderList()
    fireEvent.click(option('Vídeo'))
    fireEvent.click(option('Áudio'))
    fireEvent.click(within(panel()).getByRole('radio', { name: /^Hoje\b/ }))
    expect(screen.getByText('Nada com esse filtro aqui.')).toBeInTheDocument()
    expect(screen.queryByText('Nenhuma entrada ainda')).toBeNull()
  })

  it('tem caixa de seleção por linha e "Marcar todos"; marcar mostra a barra de seleção', () => {
    renderList()
    expect(screen.queryByRole('toolbar', { name: 'Seleção' })).toBeNull()
    fireEvent.click(screen.getByRole('checkbox', { name: 'Marcar Reunião de kickoff.mp4' }))
    expect(screen.getByRole('toolbar', { name: 'Seleção' })).toHaveTextContent('1 selecionado')
    expect(screen.getByRole('checkbox', { name: 'Marcar Reunião de kickoff.mp4' })).toBeChecked()
    fireEvent.click(screen.getByRole('checkbox', { name: 'Marcar todos' }))
    expect(screen.getByRole('toolbar', { name: 'Seleção' })).toHaveTextContent(`${ENTRIES.length} selecionados`)
    expect(screen.getByRole('status', { name: 'Endereço' })).toHaveTextContent('/entradas')
  })

  it('tem "Criado" e "Atualizado", da mais nova para a mais antiga, e ordena por coluna', () => {
    renderList()
    expect(order()).toEqual(['e-audio', 'e-texto', 'e-video', 'e-tema', 'e-pdf', 'e-link'])
    expect(head('Criado').closest('th')).toHaveAttribute('aria-sort', 'descending')
    expect(head('Atualizado')).toBeInTheDocument()
    fireEvent.click(head('Nome'))
    expect(rows().map(row => within(row).getByRole('link').textContent)).toEqual(ENTRIES.map(item => item.name).sort((a, b) => a.localeCompare(b, 'pt-BR')))
    fireEvent.click(head('Nome'))
    expect(rows()[0]).toHaveTextContent('Texto colado · 06/11')
  })

  it('mostra a pasta de cada entrada na linha, e abre a página da entrada pelo nome', () => {
    renderList()
    expect(rowOf('Contrato de serviços.pdf')).toHaveTextContent('Integrais')
    expect(rowOf('Guia de juros compostos')).toHaveTextContent('Biblioteca')
  })
})

describe('item "Entradas" na navegação', () => {
  const navButton = () => screen.getByRole('button', { name: /^Entradas/ })

  it('na lateral do leitor, mostra a contagem e leva à lista', () => {
    renderShell('/', children => <ReaderShell>{children}</ReaderShell>)
    expect(navButton()).toHaveTextContent(/^Entradas6$/)
    fireEvent.click(navButton())
    expect(screen.getByRole('status', { name: 'Endereço' })).toHaveTextContent('/entradas')
  })

  it('fica marcado na lista e na página de uma entrada', () => {
    for (const path of ['/entradas', '/entrada/e-video']) {
      const view = renderShell(path, children => <ReaderShell>{children}</ReaderShell>)
      expect(navButton()).toHaveAttribute('aria-current', 'true')
      view.unmount()
    }
    renderShell('/', children => <ReaderShell>{children}</ReaderShell>)
    expect(navButton()).toHaveAttribute('aria-current', 'false')
  })

  it('no layout de colunas, mostra a contagem e leva à lista', () => {
    renderShell('/', children => <ColumnsShell>{children}</ColumnsShell>)
    expect(navButton()).toHaveTextContent(/^Entradas6$/)
    fireEvent.click(navButton())
    expect(screen.getByRole('status', { name: 'Endereço' })).toHaveTextContent('/entradas')
  })

  it('no layout de foco, mostra a contagem e leva à lista', () => {
    renderShell('/', children => <FocusShell>{children}</FocusShell>)
    expect(navButton()).toHaveTextContent(/^Entradas6$/)
    fireEvent.click(navButton())
    expect(screen.getByRole('status', { name: 'Endereço' })).toHaveTextContent('/entradas')
  })
})
