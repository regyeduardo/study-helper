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

/** A recording made by the app: a media note (Vídeo or Áudio) whose origin is `recording`. */
function recording(id: string, name: string, folderId: string | null, mime: string, day: string, extra: Partial<FileMeta> = {}): FileMeta {
  const origin: SourceMeta = { input: 'recording', name: `${id}.webm`, mime, storage: 'none' }
  return item(id, name, folderId, { type: mime.startsWith('video/') ? 'video' : 'audio', kept: 'registro', origin, created: at(`${day}T12:00:00Z`), updated: at(`${day}T12:00:00Z`), ...extra })
}

const ENTRIES = [
  recording('e-video', 'Reunião de kickoff', 'calc', 'video/webm', '2026-11-03'),
  recording('e-plan', 'Reunião de planejamento', 'integ', 'video/webm', '2026-10-28'),
  recording('e-mic', 'Ideias no caminho', null, 'audio/webm', '2026-10-21'),
  // a library from before: still role entrada, read as a recording of its type
  recording('e-aula', 'Gravação da aula 3', 'fis', 'audio/webm', '2026-11-06', { type: 'reading', role: 'entrada' }),
  recording('e-tela', 'Tela do projeto', 'fis', 'video/webm', '2026-11-02'),
  recording('e-audio', 'Monitoria de quinta', 'calc', 'audio/webm', '2026-11-07'),
]

/** Notes that keep a source but were not recorded by the app: a sent video, a PDF and a link. */
const NOT_RECORDED = [
  item('sent', 'aula-enviada.mp4', 'calc', { type: 'video', kept: 'registro', origin: { input: 'file', name: 'aula-enviada.mp4', mime: 'video/mp4', storage: 'drive' } as SourceMeta }),
  item('pdf', 'Contrato de serviços.pdf', 'integ', { role: 'entrada', kept: 'registro', origin: { input: 'file', name: 'contrato.pdf', mime: 'application/pdf', storage: 'drive' } as SourceMeta }),
  item('link', 'Guia de juros compostos', null, { type: 'link', kept: 'registro', origin: { input: 'url', name: 'Guia', url: 'https://exemplo.com/juros', storage: 'none' } as SourceMeta }),
]

const GONE = recording('e-apagada', 'Gravação na Lixeira', 'calc', 'video/webm', '2026-11-01', { deletedAt: '2026-11-07T10:00:00Z' })

/** The kickoff's family spreads over three folders: 3 notas and 1 artefato; the planning has one live note and one in the Lixeira. */
const FAMILY = [
  item('ata', 'Ata do kickoff', 'fis', { parentFileId: 'e-video', artifacts: [art('m1')] }),
  item('aula', 'Aula do kickoff', 'calc', { parentFileId: 'e-video' }),
  item('filha', 'Resumo da ata', 'integ', { parentFileId: 'ata' }),
  item('clausulas', 'Decisões do planejamento', 'integ', { parentFileId: 'e-plan' }),
  item('rascunho', 'Rascunho apagado', 'integ', { parentFileId: 'e-plan', deletedAt: '2026-11-07T10:00:00Z' }),
]

function Where() {
  return <output aria-label="Endereço">{useLocation().pathname}</output>
}

function renderList() {
  return render(
    <MemoryRouter initialEntries={['/gravacoes']}>
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

const rows = () => within(screen.getByRole('table', { name: 'Gravações' })).getAllByRole('row').slice(1)
const rowOf = (name: string) => rows().find(row => row.getAttribute('aria-label') === name)!

beforeEach(() => {
  seedLibrary()
  useUiStore.getState().clearFilters()
  useUiStore.setState({ selection: new Set() })
  useLibraryStore.setState(state => ({ files: [...state.files, ...ENTRIES, ...NOT_RECORDED, GONE, ...FAMILY] }))
})

describe('Gravações: o que o app gravou (003, FR-050)', () => {
  it('lista todas as gravações vivas, de qualquer pasta, sem as notas, sem as apagadas e sem o que o app não gravou', () => {
    renderList()
    expect(rows()).toHaveLength(ENTRIES.length)
    const text = rows().map(row => row.textContent).join(' ')
    for (const item of ENTRIES) expect(text).toContain(item.name)
    for (const other of [GONE, ...NOT_RECORDED, ...FILES, ...FAMILY]) expect(rows().map(row => row.getAttribute('aria-label'))).not.toContain(other.name)
  })

  it('mostra o tipo de cada gravação: Vídeo ou Áudio', () => {
    renderList()
    const kindOf = (name: string) => ['Vídeo', 'Áudio'].filter(kind => within(rowOf(name)).queryByText(kind) !== null)
    expect(kindOf('Reunião de kickoff')).toEqual(['Vídeo'])
    expect(kindOf('Tela do projeto')).toEqual(['Vídeo'])
    expect(kindOf('Ideias no caminho')).toEqual(['Áudio'])
    expect(kindOf('Gravação da aula 3')).toEqual(['Áudio'])
  })

  it('conta a família inteira em qualquer pasta, sem o que está na Lixeira', () => {
    renderList()
    expect(within(rowOf('Reunião de kickoff')).getByText('3 notas · 1 artefato')).toBeInTheDocument()
    expect(within(rowOf('Reunião de planejamento')).getByText('1 nota')).toBeInTheDocument()
    expect(within(rowOf('Ideias no caminho')).getByText('Nada ainda')).toBeInTheDocument()
  })

  it('mostra a pasta e a data, da mais nova para a mais antiga', () => {
    renderList()
    expect(rowOf('Reunião de planejamento')).toHaveTextContent('Integrais')
    expect(rowOf('Ideias no caminho')).toHaveTextContent('Biblioteca')
    expect(rowOf('Reunião de kickoff')).toHaveTextContent('03/11/2026')
    expect(rows()[0]).toHaveTextContent('Monitoria de quinta')
    expect(rows().at(-1)).toHaveTextContent('Ideias no caminho')
  })

  it('cada gravação leva à página da sua nota de mídia, pelo nome ou pela linha', () => {
    renderList()
    for (const item of ENTRIES) expect(within(rowOf(item.name)).getByRole('link', { name: item.name })).toHaveAttribute('href', `/entrada/${item.id}`)
    fireEvent.click(within(rowOf('Reunião de planejamento')).getByText('Integrais'))
    expect(screen.getByRole('status', { name: 'Endereço' })).toHaveTextContent('/entrada/e-plan')
  })

  it('sem gravações, diz o que aparece aqui e oferece gravar', () => {
    useLibraryStore.setState({ files: [...FILES, ...NOT_RECORDED, GONE] })
    renderList()
    expect(screen.queryByRole('table', { name: 'Gravações' })).toBeNull()
    expect(screen.getByText('Nenhuma gravação ainda')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Gravar' }))
    expect(useUiStore.getState().overlay).toEqual({ kind: 'record' })
  })
})

describe('o mesmo painel e a mesma tabela do explorador (FR-044, FR-045, US4)', () => {
  const panel = () => screen.getByRole('complementary', { name: 'Filtros' })
  const option = (name: string) => within(panel()).getByRole('checkbox', { name: new RegExp(`^${name}\\b`) })
  const head = (name: string) => within(screen.getByRole('table', { name: 'Gravações' })).getByRole('button', { name })
  const order = () => rows().map(row => row.getAttribute('data-file-id'))

  it('tem o painel de filtros do explorador, com os grupos e as contagens só das gravações', () => {
    renderList()
    for (const name of ['Tipo', 'O que gerou', 'Período', 'Etiqueta', 'Pasta', 'Guardado']) expect(within(panel()).getByRole('group', { name })).toBeInTheDocument()
    expect(option('Vídeo')).toHaveAccessibleName('Vídeo, 3 itens')
    expect(option('Áudio')).toHaveAccessibleName('Áudio, 3 itens')
    expect(within(panel()).queryByRole('checkbox', { name: /^PDF\b/ })).toBeNull()
  })

  it('filtrar por tipo deixa só aquele tipo, com a linha de filtros ativos, a contagem e "Limpar tudo"', () => {
    renderList()
    fireEvent.click(option('Vídeo'))
    expect(rows()).toHaveLength(3)
    expect(rows().map(row => row.getAttribute('aria-label'))).toEqual(expect.arrayContaining(['Reunião de kickoff', 'Reunião de planejamento', 'Tela do projeto']))
    const active = screen.getByRole('group', { name: 'Filtros ativos' })
    expect(active).toHaveTextContent('Tipo')
    expect(screen.getByText('3 de 6')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Limpar tudo' }))
    expect(rows()).toHaveLength(ENTRIES.length)
  })

  it('filtro que não acha nada diz isso, em vez de mostrar a tela de lista vazia', () => {
    renderList()
    fireEvent.click(option('Vídeo'))
    fireEvent.click(option('Áudio'))
    fireEvent.click(within(panel()).getByRole('radio', { name: /^Hoje\b/ }))
    expect(screen.getByText('Nada com esse filtro aqui.')).toBeInTheDocument()
    expect(screen.queryByText('Nenhuma gravação ainda')).toBeNull()
  })

  it('tem caixa de seleção por linha e "Marcar todos"; marcar mostra a barra de seleção', () => {
    renderList()
    expect(screen.queryByRole('toolbar', { name: 'Seleção' })).toBeNull()
    fireEvent.click(screen.getByRole('checkbox', { name: 'Marcar Reunião de kickoff' }))
    expect(screen.getByRole('toolbar', { name: 'Seleção' })).toHaveTextContent('1 selecionado')
    expect(screen.getByRole('checkbox', { name: 'Marcar Reunião de kickoff' })).toBeChecked()
    fireEvent.click(screen.getByRole('checkbox', { name: 'Marcar todos' }))
    expect(screen.getByRole('toolbar', { name: 'Seleção' })).toHaveTextContent(`${ENTRIES.length} selecionados`)
    expect(screen.getByRole('status', { name: 'Endereço' })).toHaveTextContent('/gravacoes')
  })

  it('tem "Criado" e "Atualizado", da mais nova para a mais antiga, e ordena por coluna', () => {
    renderList()
    expect(order()).toEqual(['e-audio', 'e-aula', 'e-video', 'e-tela', 'e-plan', 'e-mic'])
    expect(head('Criado').closest('th')).toHaveAttribute('aria-sort', 'descending')
    expect(head('Atualizado')).toBeInTheDocument()
    fireEvent.click(head('Nome'))
    expect(rows().map(row => within(row).getByRole('link').textContent)).toEqual(ENTRIES.map(item => item.name).sort((a, b) => a.localeCompare(b, 'pt-BR')))
    fireEvent.click(head('Nome'))
    expect(rows()[0]).toHaveTextContent('Tela do projeto')
  })
})

describe('item "Gravações" na navegação, no lugar de "Entradas"', () => {
  const navButton = () => screen.getByRole('button', { name: /^Gravações/ })

  it('na lateral do leitor, mostra a contagem e leva à lista', () => {
    renderShell('/', children => <ReaderShell>{children}</ReaderShell>)
    expect(navButton()).toHaveTextContent(/^Gravações6$/)
    expect(screen.queryByRole('button', { name: /^Entradas/ })).toBeNull()
    fireEvent.click(navButton())
    expect(screen.getByRole('status', { name: 'Endereço' })).toHaveTextContent('/gravacoes')
  })

  it('fica marcado na lista (também pelo endereço antigo) e na página de uma gravação', () => {
    for (const path of ['/gravacoes', '/entradas', '/entrada/e-video']) {
      const view = renderShell(path, children => <ReaderShell>{children}</ReaderShell>)
      expect(navButton()).toHaveAttribute('aria-current', 'true')
      view.unmount()
    }
    renderShell('/', children => <ReaderShell>{children}</ReaderShell>)
    expect(navButton()).toHaveAttribute('aria-current', 'false')
  })

  it('no layout de colunas, mostra a contagem e leva à lista', () => {
    renderShell('/', children => <ColumnsShell>{children}</ColumnsShell>)
    expect(navButton()).toHaveTextContent(/^Gravações6$/)
    fireEvent.click(navButton())
    expect(screen.getByRole('status', { name: 'Endereço' })).toHaveTextContent('/gravacoes')
  })

  it('no layout de foco, mostra a contagem e leva à lista', () => {
    renderShell('/', children => <FocusShell>{children}</FocusShell>)
    expect(navButton()).toHaveTextContent(/^Gravações6$/)
    fireEvent.click(navButton())
    expect(screen.getByRole('status', { name: 'Endereço' })).toHaveTextContent('/gravacoes')
  })
})
