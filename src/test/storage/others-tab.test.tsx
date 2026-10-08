import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'

const MB = 1024 * 1024
const { storageBreakdown } = vi.hoisted(() => ({ storageBreakdown: vi.fn() }))

vi.mock('@/lib/storage/storage-usage', () => ({ storageBreakdown }))
vi.mock('@/lib/transcription', () => ({ ENGINES: [] }))

import { SettingsDialog } from '@/components/dialogs/SettingsDialog'
import { useIntegrationStore } from '@/lib/recording/integration'
import { installIntegration } from '@/test/recording/integration-fakes'

beforeEach(() => {
  installIntegration({ available: false })
  useIntegrationStore.setState({ status: 'unknown', hello: null })
  vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/128.0.0.0')
  storageBreakdown.mockReset()
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('Settings › Outros', () => {
  it('shows the integration with the download for this system and what the app takes', async () => {
    storageBreakdown.mockResolvedValue({ mediaBytes: 50 * MB, appBytes: 10 * MB, totalBytes: 1030 * MB })
    render(<SettingsDialog initial="others" />)
    expect(screen.getByRole('button', { name: 'Outros' })).toHaveAttribute('aria-pressed', 'true')
    expect(await screen.findByRole('link', { name: 'Baixar a integração (Windows)' })).toHaveAttribute('href', expect.stringMatching(/study-helper-audio\.exe$/))
    expect((await screen.findByText('Gravações em Mídias')).parentElement).toHaveTextContent('50 MB')
    expect(screen.getByText('Dados do app (notas, cache e configurações)').parentElement).toHaveTextContent('10 MB')
    expect(screen.getByText('Total').parentElement).toHaveTextContent('1 GB')
  })
})
