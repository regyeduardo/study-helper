import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { DockGroup } from './DockGroup'
import { describe, it, expect, vi } from 'vitest'

const testItems = [
  { label: 'Ação A', onClick: vi.fn() },
  { label: 'Ação B', onClick: vi.fn(), disabled: true },
]

describe('DockGroup', () => {
  it('renders nothing when show=false', () => {
    render(<DockGroup icon={<span />} label="Teste" show={false} items={testItems} />)
    expect(screen.queryByText('Teste')).not.toBeInTheDocument()
  })

  it('renders icon button when show=true', () => {
    render(<DockGroup icon={<span />} label="Importar" show={true} items={testItems} />)
    expect(screen.getByRole('button')).toBeInTheDocument()
  })

  it('renders correctly when show transitions from false to true', () => {
    const { rerender } = render(
      <DockGroup icon={<span />} label="Test" show={false} items={testItems} />
    )
    expect(screen.queryByRole('button')).not.toBeInTheDocument()

    rerender(
      <DockGroup icon={<span />} label="Test" show={true} items={testItems} />
    )
    expect(screen.getByRole('button')).toBeInTheDocument()
  })

  it('opens popover on click', async () => {
    const user = userEvent.setup()
    render(<DockGroup icon={<span />} label="Importar" show={true} items={testItems} />)
    await user.click(screen.getByRole('button'))
    expect(screen.getByText('Ação A')).toBeInTheDocument()
  })

  it('calls onClick for enabled item', async () => {
    const user = userEvent.setup()
    render(<DockGroup icon={<span />} label="Importar" show={true} items={testItems} />)
    await user.click(screen.getByRole('button'))
    await user.click(screen.getByText('Ação A'))
    expect(testItems[0].onClick).toHaveBeenCalledOnce()
  })

  it('does not call onClick for disabled item', async () => {
    const user = userEvent.setup()
    render(<DockGroup icon={<span />} label="Importar" show={true} items={testItems} />)
    await user.click(screen.getByRole('button'))
    await user.click(screen.getByText('Ação B'))
    expect(testItems[1].onClick).not.toHaveBeenCalled()
  })

  it('closes popover on outside click', async () => {
    const user = userEvent.setup()
    render(<DockGroup icon={<span />} label="Importar" show={true} items={testItems} />)
    await user.click(screen.getByRole('button'))
    expect(screen.getByText('Ação A')).toBeInTheDocument()
    await user.click(document.body)
    expect(screen.queryByText('Ação A')).not.toBeInTheDocument()
  })
})
