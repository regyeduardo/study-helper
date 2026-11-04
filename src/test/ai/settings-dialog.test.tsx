import { afterEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'

import { SettingsDialog } from '@/components/dialogs/SettingsDialog'
import { useLibraryStore } from '@/stores/library'

vi.mock('@/lib/transcription', () => ({
  ENGINES: [{ id: 'whisper', name: 'Whisper (no navegador)', where: 'roda neste navegador', limits: 'baixa ~250 MB' }],
}))

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('SettingsDialog restore from a study-helper.json', () => {
  it('brings every setting from the file', async () => {
    useLibraryStore.setState({ repo: { saveIndex: async () => undefined } as never })
    render(<SettingsDialog initial="general" />)
    const saved = { version: 1, settings: { ai: { provider: 'custom', baseUrl: 'https://api.deepseek.com', apiKey: 'sk-cfd', model: 'deepseek-flash' }, transcription: { engine: 'parakeet', groqApiKey: '', language: 'pt', separateSpeakers: true }, timezone: 'America/Manaus', layout: 'focus' } }
    const file = new File([JSON.stringify(saved)], 'study-helper.json', { type: 'application/json' })
    fireEvent.change(screen.getByLabelText('Arquivo de configurações'), { target: { files: [file] } })
    // An old file: its AI becomes a provider and the Estudo default (the DeepSeek address is the DeepSeek type).
    await waitFor(() => expect(useLibraryStore.getState().index.settings.aiConfig?.defaults).toEqual({ estudo: 'deepseek::deepseek-flash' }), { timeout: 5000 })
    expect(useLibraryStore.getState().index.settings.aiConfig?.providers).toEqual([{ id: 'deepseek', type: 'deepseek', name: 'DeepSeek', key: 'sk-cfd', base: '' }])
    expect(useLibraryStore.getState().index.settings.ai).toEqual({ provider: 'deepseek', baseUrl: '', apiKey: 'sk-cfd', model: 'deepseek-flash' })
    expect(useLibraryStore.getState().index.settings).toMatchObject({ timezone: 'America/Manaus', layout: 'focus', transcription: { engine: 'parakeet' } })
    expect(await screen.findByText(/Configurações trazidas do arquivo/)).toBeInTheDocument()
  })

  it('refuses a file without settings', async () => {
    render(<SettingsDialog initial="general" />)
    fireEvent.change(screen.getByLabelText('Arquivo de configurações'), { target: { files: [new File(['{"x":1}'], 'outro.json')] } })
    expect(await screen.findByText(/não tem configurações do app/)).toBeInTheDocument()
  })
})

describe('SettingsDialog links limits', () => {
  it('shows the Jina, youtube-transcript.ai and Gemini limits', () => {
    render(<SettingsDialog initial="links" />)
    expect(screen.getByText('Link de site é lido pelo Jina Reader (grátis, 20 pedidos por minuto).')).toBeInTheDocument()
    expect(screen.getByText('youtube-transcript.ai')).toBeInTheDocument()
    expect(screen.getByText('Uso justo, sem garantia: pode ficar lento ou fora do ar.')).toBeInTheDocument()
    expect(screen.getByText('Até 8 h de vídeo por dia, só vídeo público.')).toBeInTheDocument()
  })
})
