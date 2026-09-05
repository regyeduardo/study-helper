import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import GenerationModeModal from './GenerationModeModal'

describe('GenerationModeModal', () => {
  it('renders nothing when open is false', () => {
    const { container } = render(
      <GenerationModeModal
        open={false}
        onRealtime={vi.fn()}
        onBackground={vi.fn()}
        onClose={vi.fn()}
      />,
    )
    expect(container.innerHTML).toBe('')
  })

  it('renders two mode options when open', () => {
    render(
      <GenerationModeModal
        open={true}
        onRealtime={vi.fn()}
        onBackground={vi.fn()}
        onClose={vi.fn()}
      />,
    )
    expect(screen.getByText('Acompanhar em tempo real')).toBeInTheDocument()
    expect(screen.getByText('Deixar em segundo plano')).toBeInTheDocument()
  })

  it('calls onRealtime when first option selected', async () => {
    const onRealtime = vi.fn()
    const onClose = vi.fn()
    const user = userEvent.setup()

    render(
      <GenerationModeModal
        open={true}
        onRealtime={onRealtime}
        onBackground={vi.fn()}
        onClose={onClose}
      />,
    )

    await user.click(screen.getByTestId('realtime-option'))
    expect(onRealtime).toHaveBeenCalledTimes(1)
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('calls onBackground when second option selected', async () => {
    const onBackground = vi.fn()
    const onClose = vi.fn()
    const user = userEvent.setup()

    render(
      <GenerationModeModal
        open={true}
        onRealtime={vi.fn()}
        onBackground={onBackground}
        onClose={onClose}
      />,
    )

    await user.click(screen.getByTestId('background-option'))
    expect(onBackground).toHaveBeenCalledTimes(1)
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('calls onClose when cancel is clicked', async () => {
    const onClose = vi.fn()
    const user = userEvent.setup()

    render(
      <GenerationModeModal
        open={true}
        onRealtime={vi.fn()}
        onBackground={vi.fn()}
        onClose={onClose}
      />,
    )

    await user.click(screen.getByText('Cancelar'))
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})
