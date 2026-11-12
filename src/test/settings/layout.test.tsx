import '@/test/account/storage-shim'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

import { AccountMenu } from '@/components/dialogs/AccountMenu'
import { SettingsDialog } from '@/components/dialogs/SettingsDialog'
import { defaultIndex } from '@/lib/defaults'
import WorkspacePage from '@/pages/workspace'
import { useLibraryStore } from '@/stores/library'
import { useUiStore } from '@/stores/ui'

vi.mock('@/lib/transcription', () => ({ ENGINES: [] }))
vi.mock('@/pages/workspace/container/reader', () => ({ ReaderWorkspace: () => <div>layout leitor</div> }))
vi.mock('@/pages/workspace/container/columns', () => ({ ColumnsWorkspace: () => <div>layout colunas</div> }))
vi.mock('@/pages/workspace/container/commands', () => ({ CommandsWorkspace: () => <div>layout comandos</div> }))
vi.mock('@/pages/workspace/container/focus', () => ({ FocusWorkspace: () => <div>layout foco</div> }))

afterEach(() => {
  document.documentElement.removeAttribute('data-theme')
})

describe('Aparência', () => {
  it('as Configurações não têm mais a aba Aparência, nem a escolha de "cara do app", nem o tema', () => {
    render(<SettingsDialog initial="links" />)
    expect(within(screen.getByRole('navigation', { name: 'Seções' })).queryByRole('button', { name: 'Aparência' })).not.toBeInTheDocument()
    expect(screen.queryByText('Cara do app')).not.toBeInTheDocument()
    expect(screen.queryByRole('radiogroup', { name: 'Cara do app' })).not.toBeInTheDocument()
    expect(screen.queryByLabelText('Tema')).not.toBeInTheDocument()
  })

  it('o tema claro/escuro fica no menu da conta, e trocar aplica na hora', () => {
    useUiStore.setState({ overlay: { kind: 'account', x: 10, y: 10 } })
    render(<AccountMenu />)
    const theme = screen.getByLabelText('Tema')
    expect(theme.tagName).toBe('SELECT')
    expect(screen.getByRole('option', { name: 'Claro' })).toBeInTheDocument()
    expect(screen.getByRole('option', { name: 'Escuro' })).toBeInTheDocument()
    fireEvent.change(theme, { target: { value: 'dark' } })
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark')
  })

  it('o app abre sempre no layout Leitor, mesmo com outro salvo de antes', () => {
    useLibraryStore.setState({ index: { ...defaultIndex(), settings: { ...defaultIndex().settings, layout: 'focus' } }, files: [] })
    render(
      <MemoryRouter initialEntries={['/biblioteca']}>
        <WorkspacePage />
      </MemoryRouter>,
    )
    expect(screen.getByText('layout leitor')).toBeInTheDocument()
    expect(screen.queryByText('layout foco')).not.toBeInTheDocument()
  })
})
