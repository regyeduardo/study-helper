import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import LiveModeDockItem, { type LiveModeDockItemProps } from './LiveModeDockItem'

const defaultProps: LiveModeDockItemProps = {
  streamingOpen: true,
  active: true,
  complete: false,
  onViewStream: vi.fn(),
  onCancelStream: vi.fn(),
  onOpenSaveModal: vi.fn(),
}

// ── Helpers ──

function renderGenerating(overrides: Partial<LiveModeDockItemProps> = {}) {
  return render(
    <LiveModeDockItem
      {...defaultProps}
      active={true}
      complete={false}
      {...overrides}
    />
  )
}

function renderReady(overrides: Partial<LiveModeDockItemProps> = {}) {
  return render(
    <LiveModeDockItem
      {...defaultProps}
      active={false}
      complete={true}
      {...overrides}
    />
  )
}

// ── generating state ──

describe('estado generating (active=true, complete=false)', () => {
  it('renderiza o ícone de spinner (Loader2 com classe animate-spin)', () => {
    renderGenerating()
    const spinner = document.querySelector('.animate-spin')
    expect(spinner).toBeInTheDocument()
    // Verify it's a Loader2 icon (lucide renders an SVG)
    expect(spinner!.tagName).toBe('svg')
  })

  it('o label/tooltip do item é "Ao Vivo"', () => {
    renderGenerating()
    expect(screen.getByText('Ao Vivo')).toBeInTheDocument()
  })

  it('onOpenSaveModal não é chamado ao clicar no item', async () => {
    const onOpenSaveModal = vi.fn()
    const user = userEvent.setup()
    renderGenerating({ onOpenSaveModal })

    const btn = screen.getByLabelText('Ao Vivo')
    await user.click(btn)

    expect(onOpenSaveModal).not.toHaveBeenCalled()
  })

  it('ao clicar no item, um popover aparece com os textos "Ver geração" e "Cancelar geração"', async () => {
    const user = userEvent.setup()
    renderGenerating()

    const btn = screen.getByLabelText('Ao Vivo')
    await user.click(btn)

    expect(screen.getByText('Ver geração')).toBeInTheDocument()
    expect(screen.getByText('Cancelar geração')).toBeInTheDocument()
  })

  it('clicar em "Ver geração" chama onViewStream() exatamente 1 vez', async () => {
    const onViewStream = vi.fn()
    const user = userEvent.setup()
    renderGenerating({ onViewStream })

    const btn = screen.getByLabelText('Ao Vivo')
    await user.click(btn)

    await user.click(screen.getByText('Ver geração'))
    expect(onViewStream).toHaveBeenCalledTimes(1)
  })

  it('clicar em "Ver geração" fecha o popover', async () => {
    const user = userEvent.setup()
    renderGenerating()

    const btn = screen.getByLabelText('Ao Vivo')
    await user.click(btn)

    // Popover is open
    expect(screen.getByText('Ver geração')).toBeInTheDocument()

    await user.click(screen.getByText('Ver geração'))

    // Popover should be closed
    expect(screen.queryByText('Ver geração')).not.toBeInTheDocument()
    expect(screen.queryByText('Cancelar geração')).not.toBeInTheDocument()
  })

  it('clicar em "Cancelar geração" chama onCancelStream() exatamente 1 vez', async () => {
    const onCancelStream = vi.fn()
    const user = userEvent.setup()
    renderGenerating({ onCancelStream })

    const btn = screen.getByLabelText('Ao Vivo')
    await user.click(btn)

    await user.click(screen.getByText('Cancelar geração'))
    expect(onCancelStream).toHaveBeenCalledTimes(1)
  })

  it('clicar em "Cancelar geração" fecha o popover', async () => {
    const user = userEvent.setup()
    renderGenerating()

    const btn = screen.getByLabelText('Ao Vivo')
    await user.click(btn)

    expect(screen.getByText('Cancelar geração')).toBeInTheDocument()

    await user.click(screen.getByText('Cancelar geração'))

    expect(screen.queryByText('Ver geração')).not.toBeInTheDocument()
    expect(screen.queryByText('Cancelar geração')).not.toBeInTheDocument()
  })

  it('clicar fora do popover fecha o popover sem chamar nenhum callback', async () => {
    const onViewStream = vi.fn()
    const onCancelStream = vi.fn()
    const user = userEvent.setup()
    renderGenerating({ onViewStream, onCancelStream })

    const btn = screen.getByLabelText('Ao Vivo')
    await user.click(btn)

    // Popover is open
    expect(screen.getByText('Ver geração')).toBeInTheDocument()

    // Click outside the popover — click on document.body
    await user.click(document.body)

    // Popover should be closed
    expect(screen.queryByText('Ver geração')).not.toBeInTheDocument()
    expect(screen.queryByText('Cancelar geração')).not.toBeInTheDocument()

    // No callbacks should have been called
    expect(onViewStream).not.toHaveBeenCalled()
    expect(onCancelStream).not.toHaveBeenCalled()
  })
})

// ── ready state ──

describe('estado ready (active=false, complete=true, streamingOpen=true)', () => {
  it('renderiza o ícone de Save com classe animate-bounce', () => {
    renderReady()
    const saveIcon = document.querySelector('.animate-bounce')
    expect(saveIcon).toBeInTheDocument()
    expect(saveIcon!.tagName).toBe('svg')
  })

  it('o label/tooltip do item é "Salvar aula"', () => {
    renderReady()
    expect(screen.getByText('Salvar aula')).toBeInTheDocument()
  })

  it('ao clicar no item, onOpenSaveModal() é chamado exatamente 1 vez', async () => {
    const onOpenSaveModal = vi.fn()
    const user = userEvent.setup()
    renderReady({ onOpenSaveModal })

    const btn = screen.getByLabelText('Salvar aula')
    await user.click(btn)

    expect(onOpenSaveModal).toHaveBeenCalledTimes(1)
  })

  it('nenhum popover é exibido ao clicar (clique direto no modal)', () => {
    renderReady()

    // No popover content should be present
    expect(screen.queryByText('Ver geração')).not.toBeInTheDocument()
    expect(screen.queryByText('Cancelar geração')).not.toBeInTheDocument()
  })
})

// ── hidden state ──

describe('estado hidden (streamingOpen=false)', () => {
  it('o componente retorna null — nenhum elemento está no DOM', () => {
    const { container } = render(
      <LiveModeDockItem
        {...defaultProps}
        streamingOpen={false}
      />
    )
    expect(container).toBeEmptyDOMElement()
  })
})

// ── transitions ──

describe('transições', () => {
  it('ao alterar de generating para ready, o ícone e o label mudam', async () => {
    const { rerender } = render(
      <LiveModeDockItem {...defaultProps} active={true} complete={false} />
    )

    // Initially generating — spinner + "Ao Vivo"
    expect(document.querySelector('.animate-spin')).toBeInTheDocument()
    expect(screen.getByText('Ao Vivo')).toBeInTheDocument()
    expect(screen.queryByText('Salvar aula')).not.toBeInTheDocument()

    // Rerender to ready
    rerender(
      <LiveModeDockItem {...defaultProps} active={false} complete={true} />
    )

    // Now ready — save icon + "Salvar aula"
    expect(document.querySelector('.animate-bounce')).toBeInTheDocument()
    expect(screen.getByText('Salvar aula')).toBeInTheDocument()
    expect(screen.queryByText('Ao Vivo')).not.toBeInTheDocument()
  })
})
