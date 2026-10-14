import { beforeEach, describe, expect, it } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

import { InfoPanel } from '@/components/reader/Inspector'
import { defaultIndex } from '@/lib/defaults'
import type { Repository } from '@/lib/storage/repository'
import { useLibraryStore } from '@/stores/library'
import type { FileSidecar, RecordingData } from '@/types/domain'

const heard: RecordingData = { blocks: [{ speaker: 'mic', start: 0, end: 3, text: 'Vamos lançar em maio?' }], speakers: [{ id: 'mic', name: 'Você', suggested: false }], marks: [] }

const sidecars = new Map<string, FileSidecar>()
const contents = new Map<string, string>()

beforeEach(() => {
  sidecars.clear()
  contents.clear()
  const repo = {
    kind: 'local',
    accountId: 'local',
    readContent: async (id: string) => contents.get(id) ?? '',
    readSidecar: async (id: string) => sidecars.get(id)!,
    saveFile: async (sidecar: FileSidecar, content?: string) => {
      sidecars.set(sidecar.meta.id, sidecar)
      if (content !== undefined) contents.set(sidecar.meta.id, content)
      return sidecar
    },
    saveIndex: async () => undefined,
    fileSizes: async () => ({}),
  } as unknown as Repository
  useLibraryStore.setState({ repo, accountId: 'local', ready: true, folders: [], files: [], index: defaultIndex(), opened: {}, openedAt: {}, sharedView: null, localMedia: [{ storedName: 'g.webm', name: 'g.webm', mime: 'audio/webm', durationSeconds: 3, size: 2048, createdAt: '2026-10-14T00:00:00Z', fileIds: [] }] })
})

async function meeting(): Promise<string> {
  const library = useLibraryStore.getState()
  const meta = await library.createFile({ name: 'Reunião', type: 'meeting', status: 'ready', folderId: null, origin: { input: 'recording', name: 'g.webm', mime: 'audio/webm', durationSeconds: 3, storage: 'none' } }, '# Ata\n\n- Lançar em maio')
  await useLibraryStore.getState().updateSidecar(meta.id, sidecar => ({ ...sidecar, recording: heard }))
  useLibraryStore.setState(state => ({ localMedia: state.localMedia.map(item => ({ ...item, fileIds: [meta.id] })) }))
  render(
    <MemoryRouter>
      <InfoPanel fileId={meta.id} />
    </MemoryRouter>,
  )
  return meta.id
}

const parts = () => within(screen.getByRole('list', { name: 'Partes da nota' })).getAllByRole('listitem')

describe('Detalhes shows the parts of the note and deletes one at a time', () => {
  it('lists the media, the transcript and the generated text with their size', async () => {
    await meeting()
    expect(parts().map(part => part.querySelector('b')?.textContent)).toEqual(['Mídia', 'Transcrição', 'Ata'])
    expect(parts()[0]).toHaveTextContent('2 KB · este computador')
  })

  it('deleting only the transcript keeps the note, the media and the Ata', async () => {
    const id = await meeting()
    fireEvent.click(screen.getByRole('button', { name: 'Apagar só a transcrição' }))
    fireEvent.click(within(parts()[1]).getByRole('button', { name: 'Apagar' }))
    await waitFor(() => expect(sidecars.get(id)?.recording).toBeUndefined())
    expect(useLibraryStore.getState().files.find(file => file.id === id)).toBeTruthy()
    expect(contents.get(id)).toContain('Lançar em maio')
    await waitFor(() => expect(parts().map(part => part.querySelector('b')?.textContent)).toEqual(['Mídia']))
  })

  it('deleting only the generated text turns it back into the transcript', async () => {
    const id = await meeting()
    fireEvent.click(screen.getByRole('button', { name: 'Apagar só o texto gerado' }))
    fireEvent.click(within(parts()[2]).getByRole('button', { name: 'Apagar' }))
    await waitFor(() => expect(useLibraryStore.getState().files.find(file => file.id === id)?.type).toBe('reading'))
    expect(contents.get(id)).toBe('Você [00:00]: Vamos lançar em maio?')
  })
})
