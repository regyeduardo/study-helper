import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, within } from '@testing-library/react'

import { SettingsDialog } from '@/components/dialogs/SettingsDialog'
import { useUiStore } from '@/stores/ui'

vi.mock('@/lib/transcription', () => ({ ENGINES: [] }))

function phone() {
  vi.spyOn(window, 'matchMedia').mockImplementation(
    query =>
      ({
        matches: query.includes('max-width'),
        media: query,
        onchange: null,
        addListener: () => undefined,
        removeListener: () => undefined,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
        dispatchEvent: () => false,
      }) as MediaQueryList,
  )
}

const dialog = () => screen.getByRole('dialog', { name: 'Configurações' })
const sections = () => within(dialog()).getByRole('navigation', { name: 'Seções' })
const title = () => dialog().querySelector('h2 .on-phone')?.textContent

beforeEach(() => {
  phone()
  useUiStore.setState({ overlay: { kind: 'settings' } })
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('Configurações no celular', () => {
  it('abre na lista de seções, com o X para fechar e sem a seta de voltar', () => {
    render(<SettingsDialog />)
    expect(title()).toBe('Configurações')
    expect(within(sections()).getByRole('button', { name: 'Links' })).toBeInTheDocument()
    expect(within(dialog()).getByRole('button', { name: 'Fechar' })).not.toHaveClass('on-desk')
    expect(within(dialog()).queryByRole('button', { name: 'Voltar' })).not.toBeInTheDocument()
    // A lista não pode usar a classe dos menus ⋯ (que flutuam com position:fixed).
    expect(dialog().querySelector('.menu')).toBeNull()
  })

  it('dentro de uma seção a seta volta para a lista, sem fechar', () => {
    render(<SettingsDialog />)
    fireEvent.click(within(sections()).getByRole('button', { name: 'Links' }))
    expect(title()).toBe('Links')
    expect(within(dialog()).getByRole('button', { name: 'Fechar' })).toBeInTheDocument()
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Voltar' }))
    expect(useUiStore.getState().overlay).toEqual({ kind: 'settings' })
    expect(within(dialog()).queryByRole('button', { name: 'Voltar' })).not.toBeInTheDocument()
  })

  it('aberto direto numa seção (por um link), mostra essa seção', () => {
    render(<SettingsDialog initial="links" />)
    expect(title()).toBe('Links')
    expect(within(dialog()).getByRole('button', { name: 'Voltar' })).toBeInTheDocument()
  })
})
