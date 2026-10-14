import { beforeEach, describe, expect, it } from 'vitest'
import { fireEvent, screen, within } from '@testing-library/react'

import { renderAt, seedLibrary } from '@/test/library/explorer-fixture'

beforeEach(() => {
  seedLibrary()
})

const table = () => screen.getByRole('table', { name: 'Notas e pastas' })
const rows = () => within(table()).getAllByRole('row').slice(1)
const cells = (row: HTMLElement) => within(row).getAllByRole('cell').map(cell => cell.textContent?.trim())

describe('explorer side bar', () => {
  it('shows Início, Para revisar, the folder tree and the tags with their counts', () => {
    renderAt('/biblioteca/calc')
    const side = screen.getByRole('complementary', { name: 'Navegação' })
    expect(within(side).getByRole('button', { name: /Início/ })).toBeInTheDocument()
    expect(within(side).getByRole('button', { name: /Para revisar/ })).toBeInTheDocument()
    const tree = within(side).getByRole('tree', { name: 'Pastas' })
    expect(within(tree).getAllByRole('treeitem').map(item => item.getAttribute('aria-label'))).toEqual(['Biblioteca', 'Cálculo I', 'Integrais', 'Exercícios', 'Física II'])
    expect(within(tree).getByRole('treeitem', { name: 'Cálculo I' })).toHaveAttribute('aria-current', 'page')
    const tags = within(side).getByRole('list', { name: 'Etiquetas' })
    expect(within(tags).getAllByRole('button').map(button => button.textContent)).toEqual(['limites3', 'derivadas2'])
  })

  it('a tag shows only the notes that have it, and a folder in the tree opens it', () => {
    renderAt('/biblioteca/calc')
    fireEvent.click(within(screen.getByRole('list', { name: 'Etiquetas' })).getByRole('button', { name: /derivadas/ }))
    expect(rows().map(row => cells(row)[0])).toEqual(['Aula gravada: derivadas', 'Derivadas pela definição'])
    fireEvent.click(within(screen.getByRole('tree', { name: 'Pastas' })).getByRole('treeitem', { name: 'Física II' }))
    expect(screen.getByRole('heading', { name: 'Física II' })).toBeInTheDocument()
  })
})

describe('explorer table', () => {
  it('lists folders and notes with Nome, Mídia, Etiquetas and Prova', () => {
    renderAt('/biblioteca/calc')
    expect(within(table()).getAllByRole('columnheader').map(header => header.textContent?.trim())).toEqual(['Nome', 'Mídia', 'Etiquetas', 'Prova', ''])
    expect(rows().map(row => cells(row).slice(0, 4))).toEqual([
      ['Integrais', 'pasta', '', ''],
      ['Exercícios', 'pasta', '', ''],
      ['Aula gravada: derivadas', 'Vídeo · 1 h 10', 'derivadas', ''],
      ['Derivadas pela definição', 'Texto', 'derivadas', '80%'],
      ['Limites laterais e continuidade', 'Texto', 'limites', '70%'],
      ['Monitoria de limites', 'Áudio · 52 min', 'limites', ''],
    ])
  })

  it('Tudo, Texto, Áudio and Vídeo filter by the media of the note', () => {
    renderAt('/biblioteca/calc')
    const filters = screen.getByRole('group', { name: 'Mídia' })
    expect(within(filters).getByRole('button', { name: 'Tudo' })).toHaveAttribute('aria-pressed', 'true')
    fireEvent.click(within(filters).getByRole('button', { name: 'Áudio' }))
    expect(rows().map(row => cells(row)[0])).toEqual(['Monitoria de limites'])
    fireEvent.click(within(filters).getByRole('button', { name: 'Vídeo' }))
    expect(rows().map(row => cells(row)[0])).toEqual(['Aula gravada: derivadas'])
    fireEvent.click(within(filters).getByRole('button', { name: 'Texto' }))
    expect(rows().map(row => cells(row)[0])).toEqual(['Derivadas pela definição', 'Limites laterais e continuidade'])
    fireEvent.click(within(filters).getByRole('button', { name: 'Tudo' }))
    expect(rows()).toHaveLength(6)
  })

  it('clicking a column header sorts by it', () => {
    renderAt('/biblioteca/calc')
    fireEvent.click(within(table()).getByRole('button', { name: 'Prova' }))
    expect(rows().map(row => cells(row)[0]).slice(2, 4)).toEqual(['Limites laterais e continuidade', 'Derivadas pela definição'])
  })
})
