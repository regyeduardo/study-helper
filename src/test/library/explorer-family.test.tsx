import { beforeEach, describe, expect, it } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter, useLocation } from 'react-router-dom'

import type { ArtifactSummary, FileMeta } from '@/types/domain'
import { ColumnsCard, CommandsRow, FocusRow, ReaderRow } from '@/components/library/FileRows'
import { DocumentHead } from '@/components/reader/DocumentArticle'
import { useLibraryStore } from '@/stores/library'
import { FILES, renderAt, seedLibrary } from '@/test/library/explorer-fixture'

const art = (id: string): ArtifactSummary => ({ id, kind: 'mapa', name: id, updatedAt: '2026-11-07T10:00:00Z' })

function item(id: string, name: string, folderId: string | null, extra: Partial<FileMeta> = {}): FileMeta {
  return { ...FILES[3], id, name, folderId, tags: [], mastery: null, ...extra }
}

/**
 * "Limites laterais e continuidade" (Cálculo I) has a nota filha in the same folder and another in Física II;
 * a PDF entrada in Física II has an Aula in Cálculo I.
 */
const FAMILY = [
  item('filha', 'Exercícios resolvidos de limites', 'calc', { parentFileId: 'limites', artifacts: [art('m1')] }),
  item('fora', 'Limites na física', 'fis', { parentFileId: 'limites' }),
  item('pdf', 'limites.pdf', 'fis', { role: 'entrada', kept: 'arquivo', origin: { input: 'file', name: 'limites.pdf', mime: 'application/pdf', storage: 'drive', storedFileId: 'drv' } }),
  item('aula-pdf', 'Aula do PDF de limites', 'calc', { parentFileId: 'pdf', type: 'class' }),
]

/** Changes the seeded library, family included. */
const change = (edit: (files: FileMeta[]) => FileMeta[]) => useLibraryStore.setState(state => ({ files: edit(state.files) }))
const trashed = (id: string) => change(files => files.map(file => (file.id === id ? { ...file, deletedAt: '2026-11-07T11:00:00Z' } : file)))

const fileOf = (id: string) => useLibraryStore.getState().files.find(file => file.id === id)!
const table = () => screen.getByRole('table', { name: 'Notas e pastas' })
const fileRows = () => within(table()).getAllByRole('row').filter(row => row.dataset.fileId)
const rowOf = (id: string) => fileRows().find(row => row.dataset.fileId === id)!
/** The order of the notes in the table. */
const listing = () => fileRows().map(row => row.dataset.fileId)

beforeEach(() => {
  seedLibrary()
  change(files => [...files, ...FAMILY])
})

// FR-073 replaces the nesting of FR-025 in the folder: each note on its own line, in the order of the table, and its mother 1 click away.
describe('lista da pasta: cada nota na sua linha, sem recuo (FR-073)', () => {
  it('a filha fica no lugar dela na ordem da tabela, sem recuo, com o selo que leva à mãe', () => {
    renderAt('/biblioteca/calc')
    expect(listing()).toEqual(['aula-pdf', 'derivadas-video', 'derivadas', 'filha', 'limites', 'monitoria'])
    expect(rowOf('filha')).not.toHaveClass('fam-nested')
    expect(within(rowOf('filha')).getByRole('link', { name: 'de: Limites laterais e continuidade' })).toHaveAttribute('href', '/arquivo/limites')
  })

  it('a neta também fica no lugar dela', () => {
    change(files => [...files, item('neta', 'Resumo dos exercícios', 'calc', { parentFileId: 'filha' })])
    renderAt('/biblioteca/calc')
    expect(listing()).toEqual(['aula-pdf', 'derivadas-video', 'derivadas', 'filha', 'limites', 'monitoria', 'neta'])
  })

  it('um ciclo nos dados não faz nenhuma nota sumir da pasta', () => {
    change(files => files.map(file => (file.id === 'limites' ? { ...file, parentFileId: 'filha' } : file)))
    renderAt('/biblioteca/calc')
    expect([...listing()].sort()).toEqual(['aula-pdf', 'derivadas', 'derivadas-video', 'filha', 'limites', 'monitoria'])
  })

  it('ordenar a tabela ordena todas as notas, mães e filhas juntas', () => {
    renderAt('/biblioteca/calc')
    fireEvent.click(within(table()).getByRole('button', { name: 'Nome' }))
    expect(listing()).toEqual(['monitoria', 'limites', 'filha', 'derivadas', 'derivadas-video', 'aula-pdf'])
  })

  it('a busca traz a filha sozinha, com o termo marcado no nome', async () => {
    renderAt('/biblioteca/calc')
    fireEvent.change(screen.getByRole('searchbox', { name: 'Buscar' }), { target: { value: 'Exercícios resolvidos' } })
    const found = () => within(screen.getByRole('table', { name: 'Resultados da busca' })).getAllByRole('row').slice(1)
    await waitFor(() => expect(found().map(row => row.dataset.fileId)).toEqual(['filha']))
    expect([...found()[0].querySelectorAll('mark')].map(mark => mark.textContent)).toEqual(['Exercícios', 'resolvidos'])
  })
})

describe('selo "de: <mãe>" quando a mãe mora em outra pasta (FR-025)', () => {
  it('a filha aparece na sua pasta com o selo, que leva à mãe com 1 clique', async () => {
    renderAt('/biblioteca/fis')
    expect(listing()).toContain('fora')
    const badge = within(rowOf('fora')).getByRole('link', { name: 'de: Limites laterais e continuidade' })
    expect(badge).toHaveAttribute('href', '/arquivo/limites')
    fireEvent.click(badge)
    expect(await screen.findByRole('heading', { level: 1, name: 'Limites laterais e continuidade' })).toBeInTheDocument()
  })

  it('a nota feita de uma entrada de outra pasta leva à entrada', () => {
    renderAt('/biblioteca/calc')
    expect(within(rowOf('aula-pdf')).getByRole('link', { name: 'de: limites.pdf' })).toHaveAttribute('href', '/arquivo/pdf')
  })

  it('com a mãe na Lixeira, a filha sai de baixo dela e o selo diz que a mãe foi apagada', () => {
    trashed('limites')
    renderAt('/biblioteca/calc')
    expect(listing()).toEqual(['aula-pdf', 'derivadas-video', 'derivadas', 'filha', 'monitoria'])
    expect(rowOf('filha')).toHaveTextContent('de: Limites laterais e continuidade · mãe apagada')
    expect(within(rowOf('filha')).queryByRole('link', { name: /^de:/ })).not.toBeInTheDocument()
  })

  it('com a mãe apagada para sempre, o selo diz só "mãe apagada"', () => {
    change(files => files.filter(file => file.id !== 'limites'))
    renderAt('/biblioteca/fis')
    expect(within(rowOf('fora')).getByText('mãe apagada')).toBeInTheDocument()
  })

  it('com a mãe escondida por um filtro, a filha fica solta e ganha o selo', () => {
    change(files => files.map(file => (file.id === 'filha' ? { ...file, parentFileId: 'monitoria', tags: ['resolvidos'] } : file)))
    renderAt('/biblioteca/calc')
    fireEvent.click(screen.getByRole('checkbox', { name: /^resolvidos\b/ }))
    expect(listing()).toContain('filha')
    expect(within(rowOf('filha')).getByRole('link', { name: 'de: Monitoria de limites' })).toHaveAttribute('href', '/arquivo/monitoria')
  })

  it('numa lista sem aninhamento, como Favoritos, tudo fica solto e quem tem mãe mostra o selo', () => {
    change(files => files.map(file => (['limites', 'filha', 'fora'].includes(file.id) ? { ...file, favorite: true } : file)))
    renderAt('/favoritos')
    expect(listing()).toEqual(['filha', 'limites', 'fora'])
    expect(within(rowOf('fora')).getByRole('link', { name: 'de: Limites laterais e continuidade' })).toBeInTheDocument()
    expect(within(rowOf('filha')).getByRole('link', { name: 'de: Limites laterais e continuidade' })).toBeInTheDocument()
    expect(within(rowOf('limites')).queryByRole('link', { name: /^de:/ })).not.toBeInTheDocument()
  })
})

describe('contagem nas mães e nas entradas (FR-024)', () => {
  it('a mãe mostra as notas e os artefatos de toda a família, em qualquer pasta', () => {
    renderAt('/biblioteca/calc')
    expect(within(rowOf('limites')).getByText('2 notas · 1 artefato')).toBeInTheDocument()
    expect(rowOf('filha')).not.toHaveTextContent(/\d+ notas?\b/)
    expect(rowOf('derivadas')).not.toHaveTextContent(/\d+ notas?\b/)
  })

  it('a entrada não é linha da pasta; em Entradas, aparece com a sua contagem (FR-073)', () => {
    renderAt('/biblioteca/fis')
    expect(listing()).not.toContain('pdf')
  })

  it('em Entradas, a entrada mostra a sua contagem', () => {
    renderAt('/entradas')
    const row = within(screen.getByRole('table', { name: 'Entradas' })).getAllByRole('row').find(item => item.dataset.fileId === 'pdf')!
    expect(within(row).getByText('1 nota')).toBeInTheDocument()
  })
})

describe('nas linhas das outras telas, que continuam soltas', () => {
  function Route() {
    return <output aria-label="rota">{useLocation().pathname}</output>
  }

  const VARIANTS: [string, (file: FileMeta) => React.ReactNode][] = [
    ['Leitor', file => <ReaderRow file={file} showWhere={false} />],
    ['Colunas', file => <ColumnsCard file={file} showWhere={false} currentId={null} excerpt="" />],
    ['Comandos', file => <CommandsRow file={file} showWhere={false} />],
    ['Foco', file => <FocusRow file={file} showWhere={false} />],
  ]

  const show = (row: React.ReactNode) =>
    render(
      <MemoryRouter initialEntries={['/biblioteca/calc']}>
        {row}
        <Route />
      </MemoryRouter>,
    )

  it.each(VARIANTS)('%s: a mãe mostra a contagem', (_, row) => {
    show(row(fileOf('limites')))
    expect(screen.getByText('2 notas · 1 artefato')).toBeInTheDocument()
  })

  it.each(VARIANTS)('%s: o selo leva à mãe, e Enter nele não abre a própria linha', (_, row) => {
    show(row(fileOf('filha')))
    const badge = screen.getByRole('link', { name: 'de: Limites laterais e continuidade' })
    fireEvent.keyDown(badge, { key: 'Enter' })
    expect(screen.getByRole('status', { name: 'rota' })).toHaveTextContent('/biblioteca/calc')
    fireEvent.click(badge)
    expect(screen.getByRole('status', { name: 'rota' })).toHaveTextContent('/arquivo/limites')
  })
})

describe('cabeçalho da nota: a mãe ou a entrada a 1 clique (SC-004)', () => {
  const head = (id: string) =>
    render(
      <MemoryRouter>
        <DocumentHead meta={fileOf(id)} onInfo={() => undefined} />
      </MemoryRouter>,
    )

  it('mostra o selo com o link para a mãe, mesmo com as duas na mesma pasta', () => {
    head('fora')
    expect(screen.getByRole('link', { name: 'de: Limites laterais e continuidade' })).toHaveAttribute('href', '/arquivo/limites')
    head('filha')
    expect(screen.getAllByRole('link', { name: 'de: Limites laterais e continuidade' })).toHaveLength(2)
  })

  it('a nota de uma entrada leva à página da entrada', () => {
    head('aula-pdf')
    expect(screen.getByRole('link', { name: 'de: limites.pdf' })).toHaveAttribute('href', '/arquivo/pdf')
  })

  it('com a mãe na Lixeira, a nota continua aberta e o selo diz que ela foi apagada', () => {
    trashed('limites')
    head('filha')
    expect(screen.getByText('de: Limites laterais e continuidade · mãe apagada')).toBeInTheDocument()
    expect(screen.queryByRole('link', { name: /^de:/ })).not.toBeInTheDocument()
  })

  it('num link compartilhado, a mãe que ficou de fora não vira "mãe apagada"', () => {
    change(files => files.filter(file => file.id !== 'limites'))
    useLibraryStore.setState({ sharedView: { item: { id: 's', name: 's', folders: [], files: [] }, rootId: null } as never })
    head('fora')
    expect(screen.queryByText(/mãe apagada/)).not.toBeInTheDocument()
  })

  it('nota sem mãe não tem selo', () => {
    head('derivadas')
    expect(screen.queryByText(/^de:/)).not.toBeInTheDocument()
    expect(screen.queryByText('mãe apagada')).not.toBeInTheDocument()
  })
})
