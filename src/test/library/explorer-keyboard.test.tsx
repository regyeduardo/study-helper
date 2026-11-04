import { beforeEach, describe, expect, it } from 'vitest'
import { fireEvent, render, screen, within } from '@testing-library/react'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'

import { useViewRoute } from '@/hooks/use-view-route'
import { ReaderWorkspace } from '@/pages/workspace/container/reader'
import { seedLibrary } from '@/test/library/explorer-fixture'

function Workspace() {
  return <ReaderWorkspace route={useViewRoute()} />
}

function Where() {
  return <div data-testid="where">{useLocation().pathname}</div>
}

function renderAt(path: string) {
  render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/biblioteca/:folderId?" element={<Workspace />} />
        <Route path="/arquivo/:fileId" element={<Workspace />} />
        <Route path="*" element={<Workspace />} />
      </Routes>
      <Where />
    </MemoryRouter>,
  )
}

const row = (name: string) => within(screen.getByRole('table', { name: 'Notas e pastas' })).getByRole('row', { name: new RegExp(`^${name}`) })

beforeEach(() => {
  seedLibrary()
})

describe('Biblioteca pelo teclado', () => {
  it('a linha da nota recebe o Tab e o Enter abre a nota', () => {
    renderAt('/biblioteca/calc')
    const note = row('Limites laterais e continuidade')
    expect(note).toHaveAttribute('tabindex', '0')
    note.focus()
    expect(note).toHaveFocus()
    fireEvent.keyDown(note, { key: 'Enter' })
    expect(screen.getByTestId('where')).toHaveTextContent('/arquivo/limites')
  })

  it('a linha da pasta também: o Enter entra na pasta', () => {
    renderAt('/biblioteca/calc')
    const folder = row('Integrais')
    expect(folder).toHaveAttribute('tabindex', '0')
    fireEvent.keyDown(folder, { key: 'Enter' })
    expect(screen.getByTestId('where')).toHaveTextContent('/biblioteca/integ')
  })

  it('Enter na estrela ou no ⋯ da linha não abre a nota', () => {
    renderAt('/biblioteca/calc')
    const note = row('Limites laterais e continuidade')
    fireEvent.keyDown(within(note).getByRole('button', { name: 'Favoritar' }), { key: 'Enter' })
    fireEvent.keyDown(within(note).getByRole('button', { name: 'Opções de Limites laterais e continuidade' }), { key: 'Enter' })
    expect(screen.getByTestId('where')).toHaveTextContent('/biblioteca/calc')
  })
})
