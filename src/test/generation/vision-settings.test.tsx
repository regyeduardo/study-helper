import { beforeEach, describe, expect, it } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'

import { SettingsDialog } from '@/components/dialogs/SettingsDialog'
import { defaultIndex } from '@/lib/defaults'
import { visionSettingsOf } from '@/lib/generation/frames'
import { useLibraryStore } from '@/stores/library'

beforeEach(() => {
  const index = defaultIndex()
  index.settings.ai = { provider: 'custom', baseUrl: 'https://api.deepseek.com', apiKey: 'chave-deepseek', model: 'deepseek-flash' }
  index.settings.aiCredentials = { custom: { apiKey: 'chave-deepseek', model: 'deepseek-flash', baseUrl: 'https://api.deepseek.com' } }
  useLibraryStore.setState({ index, updateSettings: async patch => useLibraryStore.setState(state => ({ index: { ...state.index, settings: { ...state.index.settings, ...patch } } })) })
})

const settings = () => useLibraryStore.getState().index.settings

describe('IA settings in three tabs', () => {
  it('Inteligência artificial has Geral, Transcrição and Visão, and Transcrição e links became Links', () => {
    render(<SettingsDialog initial="ai" />)
    expect(screen.getAllByRole('tab').map(tab => tab.textContent)).toEqual(['Geral', 'Transcrição', 'Visão'])
    const nav = within(screen.getByRole('dialog', { name: 'Configurações' })).getAllByRole('button').map(button => button.textContent)
    expect(nav).toContain('Links')
    expect(nav).not.toContain('Transcrição e links')
    fireEvent.click(screen.getByRole('tab', { name: 'Transcrição' }))
    expect(screen.getByText('Transcrição de áudio e vídeo')).toBeInTheDocument()
  })

  it('the vision tab takes the key of its own provider, different from the text one', async () => {
    render(<SettingsDialog initial="ai" />)
    fireEvent.click(screen.getByRole('tab', { name: 'Visão' }))
    fireEvent.click(screen.getByRole('button', { name: /Google Gemini/ }))
    fireEvent.change(screen.getByLabelText('Chave do Google Gemini'), { target: { value: 'chave-gemini' } })
    fireEvent.change(screen.getByLabelText('Modelo de visão'), { target: { value: 'gemini-3.5-flash-lite' } })
    await waitFor(() => expect(visionSettingsOf(settings())).toEqual({ provider: 'gemini', model: 'gemini-3.5-flash-lite', apiKey: 'chave-gemini', baseUrl: '' }))
    expect(settings().ai).toMatchObject({ provider: 'custom', apiKey: 'chave-deepseek' })
  })

  it('choosing the same provider as the text shows its key already filled', () => {
    render(<SettingsDialog initial="ai" />)
    fireEvent.click(screen.getByRole('tab', { name: 'Visão' }))
    fireEvent.click(screen.getByRole('button', { name: /Personalizado/ }))
    expect(screen.getByLabelText('Chave do Personalizado')).toHaveValue('chave-deepseek')
    expect(screen.getByLabelText('URL base da visão')).toHaveValue('https://api.deepseek.com')
  })
})
