import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'

import { SettingsDialog } from '@/components/dialogs/SettingsDialog'

vi.mock('@/lib/transcription', () => ({ ENGINES: [] }))

describe('Aparência', () => {
  it('não tem mais escolha de "cara do app", e o tema claro/escuro continua', () => {
    render(<SettingsDialog initial="appearance" />)
    expect(screen.queryByText('Cara do app')).not.toBeInTheDocument()
    expect(screen.queryByRole('radiogroup', { name: 'Cara do app' })).not.toBeInTheDocument()
    const theme = screen.getByLabelText('Tema')
    expect(screen.getByRole('option', { name: 'Claro' })).toBeInTheDocument()
    expect(screen.getByRole('option', { name: 'Escuro' })).toBeInTheDocument()
    expect(theme.tagName).toBe('SELECT')
  })
})
