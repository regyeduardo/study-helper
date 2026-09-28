import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'

const MB = 1024 * 1024
const { storageBreakdown, deleteModel } = vi.hoisted(() => ({ storageBreakdown: vi.fn(), deleteModel: vi.fn(async () => undefined) }))

vi.mock('@/lib/storage/installed-models', () => ({ storageBreakdown, deleteModel }))
vi.mock('@/lib/transcription', () => ({ ENGINES: [] }))

import { SettingsDialog } from '@/components/dialogs/SettingsDialog'
import { useIntegrationStore } from '@/lib/recording/integration'
import { installIntegration } from '@/test/recording/integration-fakes'

const WHISPER = { id: 'whisper', name: 'Whisper', bytes: 300 * MB }

beforeEach(() => {
  installIntegration({ available: false })
  useIntegrationStore.setState({ status: 'unknown', hello: null })
  vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/128.0.0.0')
  storageBreakdown.mockReset()
  deleteModel.mockClear()
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('Settings › Outros', () => {
  it('shows the integration with the download for this system, the installed models and what the app takes', async () => {
    storageBreakdown.mockResolvedValue({ models: [WHISPER, { id: 'parakeet', name: 'Parakeet', bytes: 670 * MB }], mediaBytes: 50 * MB, appBytes: 10 * MB, totalBytes: 1030 * MB })
    render(<SettingsDialog initial="others" />)
    expect(screen.getByRole('button', { name: 'Outros' })).toHaveAttribute('aria-pressed', 'true')
    expect(await screen.findByRole('link', { name: 'Baixar a integração (Windows)' })).toHaveAttribute('href', expect.stringMatching(/study-helper-audio\.exe$/))
    expect(await screen.findByRole('group', { name: 'Whisper' })).toHaveTextContent('Whisper · 300 MB')
    expect(screen.getByRole('group', { name: 'Parakeet' })).toHaveTextContent('Parakeet · 670 MB')
    expect(screen.getByText('Gravações em Mídias').parentElement).toHaveTextContent('50 MB')
    expect(screen.getByText('Dados do app (notas, cache e configurações)').parentElement).toHaveTextContent('10 MB')
    expect(screen.getByText('Total').parentElement).toHaveTextContent('1 GB')
  })

  it('deletes a model only after the confirmation and shows the new sizes', async () => {
    storageBreakdown.mockResolvedValueOnce({ models: [WHISPER], mediaBytes: 0, appBytes: 0, totalBytes: 300 * MB }).mockResolvedValue({ models: [], mediaBytes: 0, appBytes: 0, totalBytes: 0 })
    render(<SettingsDialog initial="others" />)
    const whisper = await screen.findByRole('group', { name: 'Whisper' })
    fireEvent.click(whisper.querySelector('button')!)
    expect(deleteModel).not.toHaveBeenCalled()
    expect(screen.getByText('Apagar o Whisper?')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Apagar' }))
    await waitFor(() => expect(deleteModel).toHaveBeenCalledWith('whisper'))
    expect(await screen.findByText('Nenhum modelo baixado neste navegador. Eles baixam na primeira transcrição.')).toBeInTheDocument()
  })
})
