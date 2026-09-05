import { render, screen } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'
import Dock from './Dock'

const navItems = [
  { icon: <span>H</span>, label: 'Home', onClick: vi.fn() },
  { icon: <span>A</span>, label: 'Arquivos', onClick: vi.fn() },
]

const groupItems = [
  {
    icon: <span>I</span>,
    label: 'Importar',
    show: true,
    items: [{ label: 'Carregar', onClick: vi.fn() }],
  },
]

describe('Dock', () => {
  it('renders nav items', () => {
    render(<Dock items={navItems} />)
    expect(screen.getByText('Home')).toBeInTheDocument()
    expect(screen.getByText('Arquivos')).toBeInTheDocument()
  })

  it('renders a separator between nav and group items when groups are present', () => {
    render(<Dock items={navItems} groups={groupItems} />)
    // Nav and group items both render
    expect(screen.getByText('Home')).toBeInTheDocument()
    expect(screen.getByText('Importar')).toBeInTheDocument()
    // Separator div exists
    expect(document.querySelector('.bg-white\\/10')).toBeInTheDocument()
  })

  it('does not render separator when no groups provided', () => {
    render(<Dock items={navItems} />)
    expect(document.querySelector('.bg-white\\/10')).not.toBeInTheDocument()
  })

  it('does not render separator when groups is empty array', () => {
    render(<Dock items={navItems} groups={[]} />)
    expect(document.querySelector('.bg-white\\/10')).not.toBeInTheDocument()
  })

  it('hides a DockGroup when its show prop is false', () => {
    const hiddenGroup = [
      {
        icon: <span>X</span>,
        label: 'Oculto',
        show: false,
        items: [{ label: 'Item', onClick: vi.fn() }],
      },
    ]
    render(<Dock items={navItems} groups={hiddenGroup} />)
    expect(screen.queryByText('Oculto')).not.toBeInTheDocument()
  })

  it('renders children after groups with its own separator', () => {
    render(
      <Dock items={navItems} groups={groupItems}>
        <div data-testid="child">Child</div>
      </Dock>,
    )
    expect(screen.getByTestId('child')).toBeInTheDocument()
  })
})
