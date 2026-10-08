import { useState } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, within } from '@testing-library/react'

import { MeetingTabs } from '@/components/reader/MeetingTabs'
import { renameInText, renameSpeaker } from '@/lib/transcription/turns'
import type { RecordingData } from '@/types/domain'

const speech = (speaker: string, start: number, text: string) => ({ speaker, start, end: start + 3, text })

function recordingWith(name: string, suggested: boolean): RecordingData {
  return {
    blocks: [speech('mic', 0, 'Quanto custou?'), speech('speaker_0', 4, 'Dois mil.'), speech('speaker_0', 8, 'Com frete.'), speech('mic', 12, 'Fechado.'), speech('speaker_0', 16, 'Mando hoje.'), speech('speaker_0', 20, 'Até mais.')],
    speakers: [
      { id: 'mic', name: 'Você', suggested: false },
      { id: 'speaker_0', name, suggested },
    ],
    marks: [],
  }
}

const noMedia = { url: null, available: false, video: false, request: async () => undefined }

function Note({ initial, onRename = () => {} }: { initial: RecordingData; onRename?(id: string, name: string): void }) {
  const [recording, setRecording] = useState(initial)
  return (
    <MeetingTabs
      recording={recording}
      media={noMedia}
      onRename={(id, name) => {
        onRename(id, name)
        setRecording(renameSpeaker(recording, id, name))
      }}
    />
  )
}

const names = () => screen.getAllByRole('listitem').map(block => block.querySelector('.tr-who')?.textContent)

describe('renaming a speaker', () => {
  it('one click on the name opens it for typing, and Enter renames the four speeches', () => {
    const onRename = vi.fn()
    render(<Note initial={recordingWith('Falante 2', false)} onRename={onRename} />)
    fireEvent.click(within(screen.getAllByRole('listitem')[1]).getByRole('button', { name: 'Renomear Falante 2' }))
    const field = screen.getByRole('textbox', { name: 'Nome do falante' })
    expect(field).toHaveValue('Falante 2')
    fireEvent.change(field, { target: { value: ' Marina ' } })
    fireEvent.keyDown(field, { key: 'Enter' })
    expect(onRename).toHaveBeenCalledWith('speaker_0', 'Marina')
    expect(names()).toEqual(['Você', 'Marina', 'Marina', 'Você', 'Marina', 'Marina'])
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
  })

  it('a suggested name is marked on every speech until one click confirms it', () => {
    render(<Note initial={recordingWith('Marina', true)} />)
    expect(screen.getAllByText('sugestão')).toHaveLength(4)
    fireEvent.click(screen.getAllByRole('button', { name: 'Confirmar o nome Marina' })[0])
    expect(screen.queryByText('sugestão')).not.toBeInTheDocument()
    expect(names()).toEqual(['Você', 'Marina', 'Marina', 'Você', 'Marina', 'Marina'])
  })

  it('typing another name over a suggestion also clears the mark', () => {
    render(<Note initial={recordingWith('Marina', true)} />)
    fireEvent.click(screen.getAllByRole('button', { name: 'Renomear Marina' })[2])
    fireEvent.change(screen.getByRole('textbox', { name: 'Nome do falante' }), { target: { value: 'Mariana' } })
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Nome do falante' }), { key: 'Enter' })
    expect(screen.queryByText('sugestão')).not.toBeInTheDocument()
    expect(names().filter(name => name === 'Mariana')).toHaveLength(4)
  })

  it('Escape or an empty name changes nothing', () => {
    const onRename = vi.fn()
    render(<Note initial={recordingWith('Falante 2', false)} onRename={onRename} />)
    fireEvent.click(screen.getAllByRole('button', { name: 'Renomear Falante 2' })[0])
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Outro' } })
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Escape' })
    fireEvent.click(screen.getAllByRole('button', { name: 'Renomear Falante 2' })[0])
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '   ' } })
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' })
    expect(onRename).not.toHaveBeenCalled()
    expect(names().filter(name => name === 'Falante 2')).toHaveLength(4)
  })

  it('a note that cannot be changed shows the names as plain text', () => {
    render(<MeetingTabs recording={recordingWith('Marina', true)} media={noMedia} />)
    expect(screen.queryByRole('button', { name: /Renomear/ })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Confirmar o nome/ })).not.toBeInTheDocument()
    expect(screen.getAllByText('sugestão')).toHaveLength(4)
  })
})

describe('the new name in the minutes', () => {
  it('replaces the old name wherever it stands alone', () => {
    expect(renameInText('- Falante 2 envia a proposta. Falante 20 revisa.\n| enviar | Falante 2 | sexta |', 'Falante 2', 'Marina')).toBe('- Marina envia a proposta. Falante 20 revisa.\n| enviar | Marina | sexta |')
  })

  it('renameSpeaker keeps the speeches and clears the suggestion mark', () => {
    const before = recordingWith('Marina', true)
    const after = renameSpeaker(before, 'speaker_0', 'Marina')
    expect(after.speakers[1]).toEqual({ id: 'speaker_0', name: 'Marina', suggested: false })
    expect(after.blocks).toBe(before.blocks)
  })
})
