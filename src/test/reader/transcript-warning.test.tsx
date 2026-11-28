import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, within } from '@testing-library/react'

// dono, 27/11: "Não permite fechar a mensagem". The transcription's warning closes, here and in the Transcrição tab of a note.

import type { MeetingMedia } from '@/components/reader/MediaPlayer'
import { MeetingTabs } from '@/components/reader/MeetingTabs'
import { TranscriptTab } from '@/components/reader/TranscriptTab'
import type { RecordingData } from '@/types/domain'

const WARNING = 'Não deu para ler a tela gravada; a nota foi feita só com o som.'
const recording = (warning?: string): RecordingData => ({ blocks: [{ speaker: 's1', start: 0, end: 4, text: 'Bom dia.' }], speakers: [{ id: 's1', name: 'Ana', suggested: false }], marks: [], ...(warning ? { warning } : {}) })
const media: MeetingMedia = { url: null, available: false, video: false, request: async () => undefined }
const close = () => fireEvent.click(screen.getByRole('button', { name: 'Fechar o aviso' }))

describe('o aviso da transcrição', () => {
  it('fecha pelo "Fechar o aviso" e diz a quem guarda a nota', () => {
    const onCloseWarning = vi.fn()
    render(<TranscriptTab recording={recording(WARNING)} onCloseWarning={onCloseWarning} />)
    expect(screen.getByRole('status')).toHaveTextContent(WARNING)
    close()
    expect(screen.queryByText(WARNING)).not.toBeInTheDocument()
    expect(onCloseWarning).toHaveBeenCalledTimes(1)
  })

  it('quem só lê também fecha, só na tela', () => {
    render(<TranscriptTab recording={recording(WARNING)} />)
    close()
    expect(screen.queryByText(WARNING)).not.toBeInTheDocument()
  })

  it('um aviso novo (outra transcrição) aparece de novo', () => {
    const view = render(<TranscriptTab recording={recording(WARNING)} />)
    close()
    view.rerender(<TranscriptTab recording={recording('A tela não foi lida: o vídeo não abriu.')} />)
    expect(screen.getByRole('status')).toHaveTextContent('A tela não foi lida: o vídeo não abriu.')
  })

  it('sem aviso, nada aparece', () => {
    render(<TranscriptTab recording={recording()} />)
    expect(screen.queryByRole('button', { name: 'Fechar o aviso' })).not.toBeInTheDocument()
  })

  it('sem as ferramentas (o "⋯" da entrada tem), não há Exportar nem Refazer acima das falas', () => {
    render(<TranscriptTab recording={recording()} tools={false} onRedo={() => undefined} />)
    for (const name of ['Exportar .txt', 'Exportar .srt', 'Refazer a transcrição']) expect(screen.queryByRole('button', { name })).not.toBeInTheDocument()
    expect(screen.getByText('Bom dia.')).toBeInTheDocument()
  })

  it('na aba Transcrição de uma nota, fechar chega a quem guarda a nota', () => {
    const onCloseWarning = vi.fn()
    render(<MeetingTabs recording={recording(WARNING)} media={media} name="Reunião" onCloseWarning={onCloseWarning} />)
    const panel = screen.getByRole('status')
    expect(panel).toHaveTextContent(WARNING)
    fireEvent.click(within(panel).getByRole('button', { name: 'Fechar o aviso' }))
    expect(onCloseWarning).toHaveBeenCalledTimes(1)
    expect(screen.queryByText(WARNING)).not.toBeInTheDocument()
  })
})
