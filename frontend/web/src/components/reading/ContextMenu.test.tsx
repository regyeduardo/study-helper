import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, it, expect, vi } from 'vitest'
import ContextMenu from './ContextMenu'
import type { ContextMenuItem } from '@/types'

const baseItems: ContextMenuItem[] = [
  {
    id: 'ver-termos-arquivo',
    label: 'Ver termos deste arquivo',
    kind: 'app',
    onClick: vi.fn(),
  },
  { id: 'divider', label: '', kind: 'divider' },
  {
    id: 'copy',
    label: 'Copiar',
    kind: 'browser',
    onClick: vi.fn(),
  },
  {
    id: 'select-all',
    label: 'Selecionar Tudo',
    kind: 'browser',
    onClick: vi.fn(),
  },
]

describe('ContextMenu', () => {
  it('renders at the cursor position', () => {
    render(
      <ContextMenu
        items={baseItems}
        x={100}
        y={200}
        onClose={vi.fn()}
      />,
    )

    const menu = screen.getByRole('menu')
    expect(menu).toBeInTheDocument()
    expect(menu.style.left).toBe('100px')
    expect(menu.style.top).toBe('200px')
  })

  it('renders "Ver termos deste arquivo" when no selection and no hovered term', () => {
    render(
      <ContextMenu
        items={baseItems}
        x={0}
        y={0}
        onClose={vi.fn()}
      />,
    )

    expect(screen.getByText('Ver termos deste arquivo')).toBeInTheDocument()
  })

  it('renders Copy and Select All in a separate bottom section', () => {
    render(
      <ContextMenu
        items={baseItems}
        x={0}
        y={0}
        onClose={vi.fn()}
      />,
    )

    expect(screen.getByText('Copiar')).toBeInTheDocument()
    expect(screen.getByText('Selecionar Tudo')).toBeInTheDocument()
  })

  it('has a divider between app items and browser items', () => {
    render(
      <ContextMenu
        items={baseItems}
        x={0}
        y={0}
        onClose={vi.fn()}
      />,
    )

    const dividers = document.querySelectorAll('[data-testid="context-menu-divider"]')
    expect(dividers.length).toBe(1)
  })

  it('dismisses on outside click', async () => {
    const user = userEvent.setup()
    const onClose = vi.fn()

    render(
      <div>
        <div data-testid="outside">Outside</div>
        <ContextMenu
          items={baseItems}
          x={0}
          y={0}
          onClose={onClose}
        />
      </div>,
    )

    await user.click(screen.getByTestId('outside'))
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('dismisses on Escape key press', async () => {
    const user = userEvent.setup()
    const onClose = vi.fn()

    render(
      <ContextMenu
        items={baseItems}
        x={0}
        y={0}
        onClose={onClose}
      />,
    )

    await user.keyboard('{Escape}')
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('Copy action writes the selection to clipboard', async () => {
    const user = userEvent.setup()

    // Mock clipboard API via vi.stubGlobal
    const writeText = vi.fn()
    vi.stubGlobal('navigator', {
      ...navigator,
      clipboard: { writeText },
    })

    // Mock window.getSelection
    const mockSelection = { toString: () => 'selected text' }
    const getSelection = vi.fn(() => mockSelection as unknown as Selection)
    vi.stubGlobal('getSelection', getSelection)

    const onClose = vi.fn()

    const itemsWithCopy: ContextMenuItem[] = [
      {
        id: 'copy',
        label: 'Copiar',
        kind: 'browser',
        onClick: () => {
          navigator.clipboard.writeText(window.getSelection()?.toString() ?? '')
          onClose()
        },
      },
    ]

    render(
      <ContextMenu
        items={itemsWithCopy}
        x={0}
        y={0}
        onClose={onClose}
      />,
    )

    await user.click(screen.getByText('Copiar'))

    expect(writeText).toHaveBeenCalledWith('selected text')
    expect(onClose).toHaveBeenCalled()

    vi.unstubAllGlobals()
  })

  it('does not render when items array is empty', () => {
    const { container } = render(
      <ContextMenu
        items={[]}
        x={0}
        y={0}
        onClose={vi.fn()}
      />,
    )

    expect(container.innerHTML).toBe('')
  })
})
