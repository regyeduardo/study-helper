import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'

import { SettingsDialog } from '@/components/dialogs/SettingsDialog'
import { defaultIndex } from '@/lib/defaults'
import { useLibraryStore } from '@/stores/library'
import { installFetch, jsonResponse } from '@/test/ai/fake-provider'

vi.mock('@/lib/transcription', () => ({
  ENGINES: [{ id: 'whisper', name: 'Whisper (no navegador)', where: 'roda neste navegador', limits: 'baixa ~250 MB' }],
}))

const settings = () => useLibraryStore.getState().index.settings

function useProvider(name: RegExp, key: string) {
  fireEvent.click(screen.getByRole('button', { name }))
  fireEvent.change(screen.getByLabelText(/Chave da API/), { target: { value: key } })
  fireEvent.click(screen.getByRole('button', { name: 'Testar e salvar' }))
}

beforeEach(() => {
  useLibraryStore.setState({ index: defaultIndex(), repo: { saveIndex: async () => undefined } as never })
  installFetch(request => (request.url.includes('generativelanguage') ? jsonResponse({ data: [{ id: 'gemini-3.5-flash-lite' }] }) : request.headers.authorization === 'Bearer ruim' ? jsonResponse({ error: 'no' }, 401) : jsonResponse({ data: [{ id: 'gpt-4o-mini' }] })))
})

afterEach(() => vi.unstubAllGlobals())

describe('each AI keeps its own key, model and address', () => {
  it('switching to another AI and back brings the key and the model back, also after reopening', async () => {
    const { unmount } = render(<SettingsDialog initial="ai" />)
    useProvider(/^Google Gemini/, 'AQ.gem-1111')
    await waitFor(() => expect(settings().ai.provider).toBe('gemini'))
    useProvider(/^OpenAI/, 'sk-open-2222')
    await waitFor(() => expect(settings().ai.provider).toBe('openai'))
    unmount()
    render(<SettingsDialog initial="ai" />)
    fireEvent.click(screen.getByRole('button', { name: /^Google Gemini/ }))
    expect(screen.getByLabelText(/Chave da API/)).toHaveValue('AQ.gem-1111')
    expect(screen.getByLabelText('Modelo')).toHaveValue('gemini-3.5-flash-lite')
    expect(settings().aiCredentials).toMatchObject({ gemini: { apiKey: 'AQ.gem-1111', model: 'gemini-3.5-flash-lite' }, openai: { apiKey: 'sk-open-2222', model: 'gpt-4o-mini' } })
  })

  it('a key whose test fails is not kept', async () => {
    render(<SettingsDialog initial="ai" />)
    useProvider(/^OpenAI/, 'ruim')
    await waitFor(() => expect(screen.getByText('A chave foi recusada.')).toBeInTheDocument())
    expect(settings().aiCredentials.openai).toBeUndefined()
  })

  it('"Apagar chave" forgets the key, and on the AI in use goes back to the factory AI', async () => {
    render(<SettingsDialog initial="ai" />)
    useProvider(/^OpenAI/, 'sk-open-2222')
    await waitFor(() => expect(settings().ai.provider).toBe('openai'))
    fireEvent.click(screen.getByRole('button', { name: /Apagar chave/ }))
    await waitFor(() => expect(settings().ai.provider).toBe('ovh'))
    expect(settings().aiCredentials.openai).toBeUndefined()
    expect(screen.getByLabelText(/Chave da API/)).toHaveValue('')
  })
})
