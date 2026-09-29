import { afterEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'

import { SettingsDialog } from '@/components/dialogs/SettingsDialog'
import { PROVIDERS } from '@/lib/ai/providers'
import { useLibraryStore } from '@/stores/library'
import { installFetch, jsonResponse } from '@/test/ai/fake-provider'

vi.mock('@/lib/transcription', () => ({
  ENGINES: [{ id: 'whisper', name: 'Whisper (no navegador)', where: 'roda neste navegador', limits: 'baixa ~250 MB' }],
}))

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('SettingsDialog AI tab', () => {
  it('shows every provider button, OVHcloud in use by default with its model, and the free-model warning', () => {
    render(<SettingsDialog initial="ai" />)
    for (const provider of PROVIDERS.filter(item => item.id !== 'free')) expect(screen.getByRole('button', { name: new RegExp(`^${provider.name}\\s*${provider.tag}$`) })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^Grátis \(Ling\)/ })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^OVHcloud/ })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('note', { name: 'IA em uso' })).toHaveTextContent('Em uso: OVHcloud · Meta-Llama-3_3-70B-Instruct')
    expect(screen.getByLabelText('Modelo')).toHaveValue('Meta-Llama-3_3-70B-Instruct')
    expect(screen.queryByText(/DeepSeek/i)).not.toBeInTheDocument()
    expect(screen.getByText('Modelos grátis podem comprometer o resultado da geração.')).toBeInTheDocument()
  })

  it('hides the free-model warning for a paid provider', () => {
    render(<SettingsDialog initial="ai" />)
    fireEvent.click(screen.getByRole('button', { name: /^OpenAI/ }))
    expect(screen.queryByText('Modelos grátis podem comprometer o resultado da geração.')).not.toBeInTheDocument()
  })

  it('"Testar sem gastar token" only lists models via GET and fills the model list', async () => {
    const { calls } = installFetch(() => jsonResponse({ data: [{ id: 'gpt-4o' }, { id: 'gpt-4o-mini' }] }))
    render(<SettingsDialog initial="ai" />)
    fireEvent.click(screen.getByRole('button', { name: /^OpenAI/ }))
    fireEvent.change(screen.getByLabelText('Chave da API'), { target: { value: 'sk-teste' } })
    fireEvent.click(screen.getByRole('button', { name: /Testar sem gastar token/ }))
    await waitFor(() => expect(screen.getAllByRole('status')[0]).toHaveTextContent('Conectado · 2 modelos disponíveis'))
    expect(calls).toHaveLength(1)
    expect(calls[0].method).toBe('GET')
    expect(calls[0].url).toBe('https://api.openai.com/v1/models')
    expect(screen.getByRole('option', { name: 'gpt-4o-mini' })).toBeInTheDocument()
    expect(useLibraryStore.getState().index.settings.ai.provider).toBe('ovh')
  })

  it('"Testar e salvar" keeps the model the test filled in, and reopening shows what is saved', async () => {
    installFetch(() => jsonResponse({ data: [{ id: 'gemini-3.5-flash-lite' }] }))
    useLibraryStore.setState({ repo: { saveIndex: async () => undefined } as never })
    const { unmount } = render(<SettingsDialog initial="ai" />)
    fireEvent.click(screen.getByRole('button', { name: /^Google Gemini/ }))
    fireEvent.change(screen.getByLabelText('Chave da API'), { target: { value: 'AQ.chave-9876' } })
    fireEvent.click(screen.getByRole('button', { name: 'Testar e salvar' }))
    await waitFor(() => expect(useLibraryStore.getState().index.settings.ai).toEqual({ provider: 'gemini', baseUrl: '', apiKey: 'AQ.chave-9876', model: 'gemini-3.5-flash-lite' }))
    unmount()
    render(<SettingsDialog initial="ai" />)
    expect(screen.getByRole('note', { name: 'IA em uso' })).toHaveTextContent('Em uso: Google Gemini · gemini-3.5-flash-lite · chave ••••9876')
    expect(screen.getByRole('button', { name: /^Google Gemini/ })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByLabelText('Modelo')).toHaveValue('gemini-3.5-flash-lite')
  })
})

describe('SettingsDialog restore from a study-helper.json', () => {
  it('brings every setting from the file', async () => {
    useLibraryStore.setState({ repo: { saveIndex: async () => undefined } as never })
    render(<SettingsDialog initial="general" />)
    const saved = { version: 1, settings: { ai: { provider: 'custom', baseUrl: 'https://api.deepseek.com', apiKey: 'sk-cfd', model: 'deepseek-flash' }, transcription: { engine: 'parakeet', groqApiKey: '', language: 'pt', separateSpeakers: true }, timezone: 'America/Manaus', layout: 'focus' } }
    const file = new File([JSON.stringify(saved)], 'study-helper.json', { type: 'application/json' })
    fireEvent.change(screen.getByLabelText('Arquivo de configurações'), { target: { files: [file] } })
    await waitFor(() => expect(useLibraryStore.getState().index.settings.ai).toEqual(saved.settings.ai))
    expect(useLibraryStore.getState().index.settings).toMatchObject({ timezone: 'America/Manaus', layout: 'focus', transcription: { engine: 'parakeet' } })
    expect(screen.getByText(/Configurações trazidas do arquivo/)).toBeInTheDocument()
  })

  it('refuses a file without settings', async () => {
    render(<SettingsDialog initial="general" />)
    fireEvent.change(screen.getByLabelText('Arquivo de configurações'), { target: { files: [new File(['{"x":1}'], 'outro.json')] } })
    expect(await screen.findByText(/não tem configurações do app/)).toBeInTheDocument()
  })
})

describe('SettingsDialog links limits', () => {
  it('shows the Jina, youtube-transcript.ai and Gemini limits', () => {
    render(<SettingsDialog initial="transcription" />)
    expect(screen.getByText('Link de site é lido pelo Jina Reader (grátis, 20 pedidos por minuto).')).toBeInTheDocument()
    expect(screen.getByText('youtube-transcript.ai')).toBeInTheDocument()
    expect(screen.getByText('Uso justo, sem garantia: pode ficar lento ou fora do ar.')).toBeInTheDocument()
    expect(screen.getByText('Até 8 h de vídeo por dia, só vídeo público.')).toBeInTheDocument()
  })
})
