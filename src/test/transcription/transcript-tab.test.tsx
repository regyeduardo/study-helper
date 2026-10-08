import { describe, expect, it, vi } from 'vitest'
import 'fake-indexeddb/auto'

import { fireEvent, render, screen, within } from '@testing-library/react'

import { SettingsDialog } from '@/components/dialogs/SettingsDialog'
import { TranscriptTab } from '@/components/reader/TranscriptTab'
import { defaultIndex } from '@/lib/defaults'
import { LOCAL_ACCOUNT, useAccountStore } from '@/stores/account'
import { useLibraryStore } from '@/stores/library'
import type { RecordingData } from '@/types/domain'
import * as download from '@/utils/download'

const recording: RecordingData = {
  blocks: [
    { speaker: 'mic', start: 0, end: 4.2, text: 'Quanto custou isso?' },
    { speaker: 'speaker_0', start: 72.5, end: 80, text: 'Custou dois mil.' },
    { speaker: 'mic', start: 3725, end: 3730, text: 'Fechado.' },
  ],
  speakers: [
    { id: 'mic', name: 'Você', suggested: false },
    { id: 'speaker_0', name: 'Falante 2', suggested: false },
  ],
  marks: [],
}

describe('TranscriptTab', () => {
  it('shows one block per speech with the speaker name, colour and time', () => {
    render(<TranscriptTab recording={recording} />)
    const blocks = screen.getAllByRole('listitem')
    expect(blocks).toHaveLength(3)
    expect(within(blocks[0]).getByText('Você')).toBeInTheDocument()
    expect(within(blocks[0]).getByText('00:00')).toBeInTheDocument()
    expect(within(blocks[0]).getByText('Quanto custou isso?')).toBeInTheDocument()
    expect(within(blocks[1]).getByText('Falante 2')).toBeInTheDocument()
    expect(within(blocks[1]).getByText('01:12')).toBeInTheDocument()
    expect(within(blocks[2]).getByText('Você')).toBeInTheDocument()
    expect(within(blocks[2]).getByText('1:02:05')).toBeInTheDocument()
    expect(blocks[0].dataset.tone).toBe(blocks[2].dataset.tone)
    expect(blocks[0].dataset.tone).not.toBe(blocks[1].dataset.tone)
  })

  it('a transcription without speakers shows the text and the time only', () => {
    render(
      <TranscriptTab
        recording={{
          blocks: [{ speaker: '', start: 5, end: 9, text: 'Bom dia a todos.' }],
          speakers: [],
          marks: [],
        }}
      />,
    )
    const block = screen.getByRole('listitem')
    expect(within(block).getByText('00:05')).toBeInTheDocument()
    expect(within(block).getByText('Bom dia a todos.')).toBeInTheDocument()
    expect(block.querySelector('.tr-who')).toBeNull()
  })
})

describe('TranscriptTab review', () => {
  it('a corrected word shows what was first heard when the mouse is over it', () => {
    render(<TranscriptTab recording={{ blocks: [{ speaker: '', start: 0, end: 3, text: 'A Marina confirma.', original: 'A Mariana confirma.' }], speakers: [], marks: [] }} />)
    const fixed = screen.getByText('Marina')
    expect(fixed).toHaveAttribute('title', 'Ouvido: Mariana')
    expect(screen.getByRole('listitem')).toHaveTextContent('A Marina confirma.')
    expect(screen.getAllByTitle(/Ouvido:/)).toHaveLength(1)
  })
})

describe('TranscriptTab export', () => {
  it('saves the transcription as .txt and as .srt, named after the note', async () => {
    const saved = vi.spyOn(download, 'downloadBlob').mockImplementation(() => undefined)
    render(<TranscriptTab recording={recording} name="Reunião: preços" />)
    fireEvent.click(screen.getByRole('button', { name: 'Exportar .txt' }))
    fireEvent.click(screen.getByRole('button', { name: 'Exportar .srt' }))
    expect(saved.mock.calls.map(call => call[1])).toEqual([`${download.safeFilename('Reunião: preços')} - transcrição.txt`, `${download.safeFilename('Reunião: preços')} - transcrição.srt`])
    expect(saved.mock.calls[0][0].size).toBeGreaterThan(0)
    saved.mockRestore()
  })
})

describe('transcription settings', () => {
  it('no longer offers "Separar quem fala"', () => {
    useAccountStore.setState({
      accounts: [LOCAL_ACCOUNT],
      activeId: LOCAL_ACCOUNT.id,
    })
    useLibraryStore.setState({ index: defaultIndex() })
    render(<SettingsDialog initial="transcription" />)
    expect(screen.getByText('Idioma falado')).toBeInTheDocument()
    expect(screen.queryByText('Separar quem fala')).not.toBeInTheDocument()
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument()
  })
})
