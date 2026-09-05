import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import SelectionMenu from './SelectionMenu'

function mockSelection(text: string) {
  vi.spyOn(window, 'getSelection').mockReturnValue({
    toString: () => text,
  } as unknown as Selection)
}

describe('SelectionMenu', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('shows "Gerar explicação" when there is a selection', () => {
    mockSelection('um trecho qualquer')
    render(
      <SelectionMenu canExplain onExplainSelection={vi.fn()}>
        <p>conteúdo</p>
      </SelectionMenu>,
    )

    fireEvent.contextMenu(screen.getByText('conteúdo'))

    expect(screen.getByText('Gerar explicação')).toBeInTheDocument()
  })

  it('hides "Gerar explicação" when nothing is selected', () => {
    mockSelection('')
    render(
      <SelectionMenu canExplain onExplainSelection={vi.fn()}>
        <p>conteúdo</p>
      </SelectionMenu>,
    )

    fireEvent.contextMenu(screen.getByText('conteúdo'))

    expect(screen.queryByText('Gerar explicação')).not.toBeInTheDocument()
  })

  it('hides "Gerar explicação" when the file cannot be explained', () => {
    mockSelection('trecho')
    render(
      <SelectionMenu canExplain={false} onExplainSelection={vi.fn()}>
        <p>conteúdo</p>
      </SelectionMenu>,
    )

    fireEvent.contextMenu(screen.getByText('conteúdo'))

    expect(screen.queryByText('Gerar explicação')).not.toBeInTheDocument()
  })

  it('always offers the browser actions', () => {
    mockSelection('')
    render(
      <SelectionMenu canExplain onExplainSelection={vi.fn()}>
        <p>conteúdo</p>
      </SelectionMenu>,
    )

    fireEvent.contextMenu(screen.getByText('conteúdo'))

    expect(screen.getByText('Copiar')).toBeInTheDocument()
    expect(screen.getByText('Selecionar tudo')).toBeInTheDocument()
  })

  it('passes the selected excerpt to the callback', () => {
    mockSelection('trecho que quero entender')
    const onExplainSelection = vi.fn()
    render(
      <SelectionMenu canExplain onExplainSelection={onExplainSelection}>
        <p>conteúdo</p>
      </SelectionMenu>,
    )

    fireEvent.contextMenu(screen.getByText('conteúdo'))
    fireEvent.click(screen.getByText('Gerar explicação'))

    expect(onExplainSelection).toHaveBeenCalledWith('trecho que quero entender')
  })
})
