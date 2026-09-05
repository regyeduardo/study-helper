import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import ExplainSelectionModal from './ExplainSelectionModal'

function renderModal(overrides: Partial<Parameters<typeof ExplainSelectionModal>[0]> = {}) {
  const props = {
    excerpt: 'trecho selecionado',
    sourceName: 'Aula de Python',
    onSubmit: vi.fn(),
    onClose: vi.fn(),
    ...overrides,
  }
  render(<ExplainSelectionModal {...props} />)
  return props
}

describe('ExplainSelectionModal', () => {
  it('shows the selected excerpt and the source name', () => {
    renderModal()
    expect(screen.getByTestId('selection-excerpt')).toHaveTextContent('trecho selecionado')
    expect(screen.getByText('Aula de Python')).toBeInTheDocument()
  })

  it('submits with an empty prompt when the user types nothing', async () => {
    const user = userEvent.setup()
    const props = renderModal()

    await user.click(screen.getByTestId('explain-selection-submit'))

    expect(props.onSubmit).toHaveBeenCalledWith({ excerpt: 'trecho selecionado', prompt: '' })
  })

  it('submits the typed prompt', async () => {
    const user = userEvent.setup()
    const props = renderModal()

    await user.type(screen.getByLabelText(/Seu prompt/i), 'explique com analogia')
    await user.click(screen.getByTestId('explain-selection-submit'))

    expect(props.onSubmit).toHaveBeenCalledWith({
      excerpt: 'trecho selecionado',
      prompt: 'explique com analogia',
    })
  })

  it('closes on cancel', async () => {
    const user = userEvent.setup()
    const props = renderModal()

    await user.click(screen.getByText('Cancelar'))

    expect(props.onClose).toHaveBeenCalled()
  })

  it('closes on Escape', async () => {
    const user = userEvent.setup()
    const props = renderModal()

    await user.keyboard('{Escape}')

    expect(props.onClose).toHaveBeenCalled()
  })
})
