import { type ComponentType } from 'react'
import { beforeEach, describe, expect, it } from 'vitest'
import { fireEvent, render, screen, within } from '@testing-library/react'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'

import { useViewRoute } from '@/hooks/use-view-route'
import { ColumnsWorkspace } from '@/pages/workspace/container/columns'
import { CommandsWorkspace } from '@/pages/workspace/container/commands'
import { FocusWorkspace } from '@/pages/workspace/container/focus'
import type { ViewRoute } from '@/hooks/use-view-route'
import { useLibraryStore } from '@/stores/library'
import { useUiStore } from '@/stores/ui'
import { seedLibrary } from '@/test/library/explorer-fixture'

// US4 · FR-041, FR-040, FR-044, FR-038: what the explorer gained is also in Colunas, Comandos and Foco.

const LAYOUTS: [string, ComponentType<{ route: ViewRoute }>][] = [
  ['Colunas', ColumnsWorkspace],
  ['Comandos', CommandsWorkspace],
  ['Foco', FocusWorkspace],
]

function Where() {
  return <output aria-label="Endereço">{useLocation().pathname}</output>
}

/** Each workspace brings its own shell (side bar, top bar). */
function renderLayout(Workspace: ComponentType<{ route: ViewRoute }>, path: string) {
  const Screen = () => <Workspace route={useViewRoute()} />
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/biblioteca/:folderId?" element={<><Screen /><Where /></>} />
      </Routes>
    </MemoryRouter>,
  )
}

const ids = (container: HTMLElement) => [...container.querySelectorAll('[data-file-id]')].map(row => row.getAttribute('data-file-id')).filter(Boolean)

beforeEach(() => {
  seedLibrary()
  useUiStore.setState({ selection: new Set(), query: '', tag: null, lowMastery: false, filtersCollapsed: false })
})

describe.each(LAYOUTS)('%s: filtros do explorador (FR-044, FR-041)', (_name, Workspace) => {
  it('o botão "Filtros" abre o painel, filtrar deixa só o que bate e mostra os filtros ativos com "Limpar tudo"', () => {
    const { container } = renderLayout(Workspace, '/biblioteca/calc')
    expect(ids(container)).toEqual(expect.arrayContaining(['limites', 'derivadas']))
    expect(screen.queryByRole('dialog', { name: 'Filtros' })).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: /^Filtros/ }))
    const panel = screen.getByRole('dialog', { name: 'Filtros' })
    fireEvent.click(within(panel).getByRole('checkbox', { name: /^derivadas\b/ }))
    fireEvent.click(within(panel).getByRole('button', { name: 'Fechar os filtros' }))

    expect(ids(container).sort()).toEqual(['derivadas', 'derivadas-video'])
    expect(within(screen.getByRole('group', { name: 'Filtros ativos' })).getByText('Etiqueta')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Limpar tudo' }))
    expect(ids(container)).toEqual(expect.arrayContaining(['limites', 'derivadas']))
  })

  it('"Entradas" e "Notas" separam o que a lista mostra; não sobram os balões só de tipo', () => {
    renderLayout(Workspace, '/biblioteca/calc')
    const scope = within(screen.getByRole('group', { name: 'Mostrar' }))
    expect(scope.getByRole('button', { name: /^Notas/ })).toBeInTheDocument()
    expect(scope.getByRole('button', { name: /^Entradas/ })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Limpar filtros' })).toBeNull()
  })

  it('a Pasta do painel mostra o que está em outra pasta, fora da pasta aberta', () => {
    const { container } = renderLayout(Workspace, '/biblioteca/calc')
    fireEvent.click(screen.getByRole('button', { name: /^Filtros/ }))
    const panel = screen.getByRole('dialog', { name: 'Filtros' })
    fireEvent.click(within(panel).getByRole('checkbox', { name: /^Física II\b/ }))
    expect(ids(container)).toEqual(['ondas'])
  })
})

describe.each(LAYOUTS)('%s: datas de criação e de atualização sob o nome (FR-040)', (_name, Workspace) => {
  it('cada arquivo mostra "Criado" e "Atualizado" numa linha discreta', () => {
    const { container } = renderLayout(Workspace, '/biblioteca/calc')
    const row = container.querySelector('[data-file-id="limites"]') as HTMLElement
    expect(within(row).getByText('Criado 10/10/2026 · Atualizado 10/10/2026')).toBeInTheDocument()
  })
})

describe('Favoritos (FR-038, FR-041)', () => {
  beforeEach(() => {
    useLibraryStore.setState(state => ({ folders: state.folders.map(folder => (folder.id === 'calc' ? { ...folder, favorite: true, color: 'azul' as const } : folder)) }))
  })

  it('Colunas: a lateral de coleções tem a área Favoritos, e leva à pasta', () => {
    renderLayout(ColumnsWorkspace, '/biblioteca/fis')
    const list = within(screen.getByRole('complementary', { name: 'Coleções' })).getByRole('list', { name: 'Favoritos' })
    expect(within(list).getByRole('img', { name: 'Pasta azul' })).toBeInTheDocument()
    fireEvent.click(within(list).getByRole('button', { name: /Cálculo I/ }))
    expect(screen.getByRole('status', { name: 'Endereço' })).toHaveTextContent('/biblioteca/calc')
  })

  it.each([
    ['Comandos', CommandsWorkspace],
    ['Foco', FocusWorkspace],
  ] as const)('%s: sem lateral, as pastas favoritas ficam no alto da biblioteca, e levam à pasta', (_name, Workspace) => {
    renderLayout(Workspace, '/biblioteca/fis')
    const list = screen.getByRole('list', { name: 'Favoritos' })
    fireEvent.click(within(list).getByRole('button', { name: /Cálculo I/ }))
    expect(screen.getByRole('status', { name: 'Endereço' })).toHaveTextContent('/biblioteca/calc')
  })

  it('sem pasta favorita, a área não aparece', () => {
    useLibraryStore.setState(state => ({ folders: state.folders.map(folder => ({ ...folder, favorite: false })) }))
    renderLayout(FocusWorkspace, '/biblioteca/fis')
    expect(screen.queryByRole('list', { name: 'Favoritos' })).toBeNull()
  })
})
