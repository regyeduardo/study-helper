import { beforeEach, describe, expect, it } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

import { DocumentBody } from '@/components/reader/DocumentArticle'
import { MeetingTabs } from '@/components/reader/MeetingTabs'
import { defaultIndex } from '@/lib/defaults'
import type { Repository } from '@/lib/storage/repository'
import { useLibraryStore } from '@/stores/library'
import type { FileSidecar, RecordingData, RecordingMark } from '@/types/domain'

const recording: RecordingData = {
  blocks: [
    { speaker: 'mic', start: 0, end: 20, text: 'Vamos começar.' },
    { speaker: 'speaker_0', start: 60, end: 70, text: 'O preço fica em dois mil.' },
    { speaker: 'mic', start: 80, end: 85, text: 'Fechado.' },
  ],
  speakers: [
    { id: 'mic', name: 'Você', suggested: false },
    { id: 'speaker_0', name: 'Marina', suggested: false },
  ],
  marks: [
    { id: 'm1', kind: 'mark', at: 65, text: '' },
    { id: 'm2', kind: 'note', at: 82, text: 'conferir o preço' },
  ],
}

const sidecars = new Map<string, FileSidecar>()
let slowSave: Promise<void> | null = null
const contents = new Map<string, string>()
const repo = {
  kind: 'local',
  accountId: 'local',
  readContent: async (id: string) => contents.get(id) ?? '',
  readSidecar: async (id: string) => sidecars.get(id)!,
  saveFile: async (sidecar: FileSidecar, content?: string) => {
    if (slowSave) await slowSave
    sidecars.set(sidecar.meta.id, sidecar)
    if (content !== undefined) contents.set(sidecar.meta.id, content)
    return sidecar
  },
  saveIndex: async () => undefined,
  fileSizes: async () => ({}),
} as unknown as Repository

const saved = (id: string): RecordingMark[] => sidecars.get(id)!.recording!.marks
const button = (name: string) => screen.getByRole('button', { name })

async function openNote(): Promise<string> {
  const meta = await useLibraryStore.getState().createFile({ name: 'Reunião de preço', type: 'reading' }, 'transcrição')
  await useLibraryStore.getState().updateSidecar(meta.id, sidecar => ({ ...sidecar, recording }))
  render(
    <MemoryRouter>
      <DocumentBody fileId={meta.id} />
    </MemoryRouter>,
  )
  await waitFor(() => expect(screen.getAllByRole('note')).toHaveLength(2))
  return meta.id
}

beforeEach(() => {
  sidecars.clear()
  slowSave = null
  contents.clear()
  useLibraryStore.setState({ repo, accountId: 'local', ready: true, folders: [], files: [], index: defaultIndex(), opened: {}, openedAt: {}, localMedia: [], sharedView: null })
})

describe('marks and notes in the note', () => {
  it('edits the text of a note made while recording, and it stays saved', async () => {
    const id = await openNote()
    fireEvent.click(button('Editar a anotação de 01:22'))
    const field = screen.getByRole('textbox', { name: 'Texto da anotação' })
    expect(field).toHaveValue('conferir o preço')
    fireEvent.change(field, { target: { value: 'conferir o preço com a Marina' } })
    fireEvent.keyDown(field, { key: 'Enter' })
    await waitFor(() => expect(saved(id)[1]).toEqual({ id: 'm2', kind: 'note', at: 82, text: 'conferir o preço com a Marina' }))
    expect(screen.getByRole('note', { name: 'Anotação em 01:22' })).toHaveTextContent('conferir o preço com a Marina')
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
  })

  it('deletes a mark made while recording, and it stays deleted', async () => {
    const id = await openNote()
    fireEvent.click(button('Editar a marcação de 01:05'))
    fireEvent.click(button('Apagar a marcação de 01:05'))
    await waitFor(() => expect(saved(id).map(mark => mark.id)).toEqual(['m2']))
    expect(screen.getAllByRole('note')).toHaveLength(1)
  })

  it('creates a new note on a speech, at the time of that speech', async () => {
    const id = await openNote()
    fireEvent.click(within(screen.getAllByRole('listitem')[0]).getByRole('button', { name: 'Marcar esta fala' }))
    const field = await screen.findByRole('textbox', { name: 'Texto da anotação' })
    fireEvent.change(field, { target: { value: 'pauta da reunião' } })
    fireEvent.keyDown(field, { key: 'Enter' })
    await waitFor(() => expect(saved(id)).toHaveLength(3))
    expect(saved(id).find(mark => mark.text === 'pauta da reunião')).toMatchObject({ kind: 'note', at: 0 })
    expect(within(screen.getAllByRole('listitem')[0]).getByRole('note', { name: 'Anotação em 00:00' })).toHaveTextContent('pauta da reunião')
  })

  it('a new mark left without text is a flag, and writing on a flag turns it into a note', async () => {
    const id = await openNote()
    fireEvent.click(within(screen.getAllByRole('listitem')[2]).getByRole('button', { name: 'Marcar esta fala' }))
    fireEvent.keyDown(await screen.findByRole('textbox', { name: 'Texto da anotação' }), { key: 'Escape' })
    await waitFor(() => expect(saved(id)).toHaveLength(3))
    expect(saved(id).find(mark => mark.at === 80)).toMatchObject({ kind: 'mark', text: '' })
    fireEvent.click(button('Editar a marcação de 01:05'))
    fireEvent.change(screen.getByRole('textbox', { name: 'Texto da anotação' }), { target: { value: 'valor fechado' } })
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Texto da anotação' }), { key: 'Enter' })
    await waitFor(() => expect(saved(id).find(mark => mark.id === 'm1')).toEqual({ id: 'm1', kind: 'note', at: 65, text: 'valor fechado' }))
  })

  it('with slow storage, a new mark opens at once and is saved behind', async () => {
    const id = await openNote()
    let release = () => undefined as void
    slowSave = new Promise(resolve => (release = resolve))
    fireEvent.click(within(screen.getAllByRole('listitem')[0]).getByRole('button', { name: 'Marcar esta fala' }))
    expect(screen.getByRole('textbox', { name: 'Texto da anotação' })).toBeInTheDocument()
    expect(saved(id)).toHaveLength(2)
    release()
    await waitFor(() => expect(saved(id)).toHaveLength(3))
  })

  it('a note that cannot be changed shows the marks with nothing to click', () => {
    render(<MeetingTabs recording={recording} media={{ url: null, available: false, video: false, request: async () => undefined }} />)
    expect(screen.getAllByRole('note')).toHaveLength(2)
    expect(screen.queryByRole('button', { name: /Editar a|Marcar esta fala/ })).not.toBeInTheDocument()
  })
})
