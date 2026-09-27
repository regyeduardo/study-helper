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
  it('shows every provider button, LLM7 selected by default, and the free-model warning', () => {
    render(<SettingsDialog initial="ai" />)
    for (const provider of PROVIDERS) expect(screen.getByRole('button', { name: new RegExp(`^${provider.name}\\s*${provider.tag}$`) })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^LLM7/ })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.queryByText(/DeepSeek/i)).not.toBeInTheDocument()
    expect(screen.getByText('Modelos grátis podem comprometer o resultado da geração.')).toBeInTheDocument()
  })

  it('hides the free-model warning for a paid provider', () => {
    render(<SettingsDialog initial="ai" />)
    fireEvent.click(screen.getByRole('button', { name: /^OpenAI/ }))
    expect(screen.queryByText('Modelos grátis podem comprometer o resultado da geração.')).not.toBeInTheDocument()
  })

  it('"Testar sem gastar token" only lists models via GET and fills the model list', async () => {
    const { calls } = installFetch(() => jsonResponse({ data: [{ id: 'default' }, { id: 'fast' }] }))
    render(<SettingsDialog initial="ai" />)
    fireEvent.click(screen.getByRole('button', { name: /Testar sem gastar token/ }))
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Conectado · 2 modelos disponíveis'))
    expect(calls).toHaveLength(1)
    expect(calls[0].method).toBe('GET')
    expect(calls[0].url).toBe('https://api.llm7.io/v1/models')
    expect(screen.getByRole('option', { name: 'fast' })).toBeInTheDocument()
    expect(useLibraryStore.getState().index.settings.ai.provider).toBe('llm7')
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
