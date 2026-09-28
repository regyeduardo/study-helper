import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'

const { installedModels } = vi.hoisted(() => ({ installedModels: vi.fn(async () => [] as { id: string; name: string; bytes: number }[]) }))
vi.mock('@/lib/storage/installed-models', () => ({ installedModels }))

import { ModelDownloadDialog } from '@/components/dialogs/ModelDownloadDialog'
import { confirmModelDownloads, ModelDownloadDeclined, modelsNeeded, setModelDownloadAsker } from '@/lib/transcription/consent'

afterEach(() => {
  setModelDownloadAsker(null)
  installedModels.mockReset()
  installedModels.mockResolvedValue([])
})

describe('which models a transcription needs', () => {
  it('names each local model with its download size', () => {
    expect(modelsNeeded('whisper', 'pt', false)).toEqual([{ id: 'whisper', name: 'Whisper', megabytes: 515 }])
    expect(modelsNeeded('parakeet', 'pt', true)).toEqual([
      { id: 'parakeet', name: 'Parakeet pt-BR', megabytes: 930 },
      { id: 'speakers', name: 'Separação de quem falou', megabytes: 34 },
    ])
    expect(modelsNeeded('parakeet', 'en', false)).toEqual([{ id: 'parakeet', name: 'Parakeet', megabytes: 670 }])
    expect(modelsNeeded(null, 'pt', false)).toEqual([])
  })
})

describe('asking before a download', () => {
  it('asks only for what is not downloaded yet', async () => {
    installedModels.mockResolvedValue([{ id: 'whisper', name: 'Whisper', bytes: 500 }])
    const asker = vi.fn(async () => true)
    setModelDownloadAsker(asker)
    await confirmModelDownloads(modelsNeeded('whisper', 'pt', true))
    expect(asker).toHaveBeenCalledWith([{ id: 'speakers', name: 'Separação de quem falou', megabytes: 34 }])
  })

  it('does not ask when everything is already downloaded', async () => {
    installedModels.mockResolvedValue([{ id: 'whisper', name: 'Whisper', bytes: 500 }])
    const asker = vi.fn(async () => true)
    setModelDownloadAsker(asker)
    await confirmModelDownloads(modelsNeeded('whisper', 'pt', false))
    expect(asker).not.toHaveBeenCalled()
  })

  it('stops the transcription when the person says no', async () => {
    setModelDownloadAsker(async () => false)
    await expect(confirmModelDownloads(modelsNeeded('whisper', 'pt', false))).rejects.toBeInstanceOf(ModelDownloadDeclined)
  })
})

describe('the download question', () => {
  it('shows the size and answers with the button the person clicks', async () => {
    render(<ModelDownloadDialog />)
    let answer: Promise<void> | null = null
    act(() => {
      answer = confirmModelDownloads(modelsNeeded('parakeet', 'pt', true))
    })
    expect(await screen.findByRole('dialog', { name: 'Baixar o modelo de transcrição?' })).toHaveTextContent('Parakeet pt-BR: ~930 MB')
    expect(screen.getByText('Separação de quem falou: ~34 MB')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Baixar ~964 MB' }))
    await expect(answer).resolves.toBeUndefined()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('"Agora não" cancels without downloading', async () => {
    render(<ModelDownloadDialog />)
    let answer: Promise<void> | null = null
    act(() => {
      answer = confirmModelDownloads(modelsNeeded('whisper', 'pt', false))
    })
    fireEvent.click(await screen.findByRole('button', { name: 'Agora não' }))
    await expect(answer).rejects.toThrow('A transcrição foi cancelada: o modelo não foi baixado.')
  })
})
