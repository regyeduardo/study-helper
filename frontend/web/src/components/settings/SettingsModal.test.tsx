import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import SettingsModal from './SettingsModal'

const mockSetDockPosition = vi.fn()

vi.mock('@/hooks/useDockPosition', () => ({
  useDockPosition: () => ['left', mockSetDockPosition],
}))

describe('SettingsModal', () => {
  beforeEach(() => {
    mockSetDockPosition.mockClear()
  })

  it('renders two toggle options: "Esquerda" and "Direita"', () => {
    render(<SettingsModal open={true} onClose={() => {}} />)

    expect(screen.getByText('Esquerda')).toBeInTheDocument()
    expect(screen.getByText('Direita')).toBeInTheDocument()
  })

  it('calls the setter with "right" when clicking "Direita"', async () => {
    const user = userEvent.setup()
    render(<SettingsModal open={true} onClose={() => {}} />)

    await user.click(screen.getByText('Direita'))

    expect(mockSetDockPosition).toHaveBeenCalledWith('right')
  })

  it('calls the setter with "left" when clicking "Esquerda"', async () => {
    const user = userEvent.setup()
    render(<SettingsModal open={true} onClose={() => {}} />)

    await user.click(screen.getByText('Esquerda'))

    expect(mockSetDockPosition).toHaveBeenCalledWith('left')
  })

  it('renders nothing when closed', () => {
    const { container } = render(<SettingsModal open={false} onClose={() => {}} />)
    expect(container.innerHTML).toBe('')
  })
})
