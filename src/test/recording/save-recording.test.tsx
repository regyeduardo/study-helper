import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { Blob as NodeBlob, File as NodeFile } from 'node:buffer'
import { MemoryRouter } from 'react-router-dom'

const { navigate } = vi.hoisted(() => ({ navigate: vi.fn() }))

vi.mock('@/routes', () => ({ router: { navigate } }))

vi.mock('@/lib/transcription', () => ({
  ENGINES: [],
  transcribe: vi.fn(async () => ({
    text: 'Você [00:00]: Oi.',
    engine: 'deepinfra',
    language: 'pt',
    durationSeconds: 3,
    speakers: 1,
    recording: { blocks: [{ speaker: 'mic', start: 0, end: 3, text: 'Oi.' }], speakers: [{ id: 'mic', name: 'Você', suggested: false }], marks: [] },
  })),
}))

import { RecordingDoneDialog } from '@/components/dialogs/RecordDialogs'
import { defaultIndex } from '@/lib/defaults'
import { listLocalMedia } from '@/lib/recording/media-library'
import type { Repository } from '@/lib/storage/repository'
import { transcribe } from '@/lib/transcription'
import { LOCAL_ACCOUNT, useAccountStore } from '@/stores/account'
import { useJobsStore } from '@/stores/jobs'
import { useLibraryStore } from '@/stores/library'
import { useRecorderStore } from '@/stores/recorder'
import type { FileSidecar } from '@/types/domain'

function memoryRepository() {
  const sidecars = new Map<string, FileSidecar>()
  const repo = {
    kind: 'local',
    accountId: 'local',
    readContent: async () => '',
    readSidecar: async (id: string) => sidecars.get(id)!,
    saveFile: async (sidecar: FileSidecar) => (sidecars.set(sidecar.meta.id, sidecar), sidecar),
    saveIndex: async () => undefined,
    fileSizes: async () => ({}),
  } as unknown as Repository
  return { repo, sidecars }
}

function installBrowserFolder(): Map<string, Blob> {
  const files = new Map<string, Blob>()
  const handle = (name: string) => ({
    getFile: async () => new NodeFile([files.get(name) as never], name),
    createWritable: async () => {
      const parts: BlobPart[] = []
      return { write: async (data: BlobPart) => void parts.push(data), close: async () => void files.set(name, new NodeBlob(parts as never) as unknown as Blob) }
    },
  })
  const folder = {
    getFileHandle: async (name: string, options?: { create?: boolean }) => {
      if (!files.has(name) && !options?.create) throw new DOMException('missing', 'NotFoundError')
      return handle(name)
    },
    removeEntry: async (name: string) => void files.delete(name),
  }
  Object.defineProperty(navigator, 'storage', { configurable: true, value: { getDirectory: async () => folder } })
  return files
}

let memory: ReturnType<typeof memoryRepository>
let folder: Map<string, Blob>

const recording = () => {
  const file = new NodeFile([new Uint8Array(8)], 'Reunião 14-10-2026, 09-00-00.webm', { type: 'audio/webm' }) as unknown as File
  return { file, mime: 'audio/webm;codecs=opus', durationSeconds: 65, storedName: 'gravacao-1.webm', marks: [{ id: 'm1', kind: 'mark' as const, at: 10, text: '' }] }
}

beforeEach(async () => {
  memory = memoryRepository()
  folder = installBrowserFolder()
  folder.set('gravacao-1.webm', new NodeBlob(['x']) as unknown as Blob)
  folder.set('midias.json', new NodeBlob([JSON.stringify([{ storedName: 'gravacao-1.webm', name: 'Reunião.webm', mime: 'audio/webm', durationSeconds: 65, size: 8, createdAt: '2026-10-14T12:00:00Z', fileIds: [] }])]) as unknown as Blob)
  navigate.mockClear()
  vi.mocked(transcribe).mockClear()
  useAccountStore.setState({ accounts: [LOCAL_ACCOUNT], activeId: LOCAL_ACCOUNT.id })
  useLibraryStore.setState({ repo: memory.repo, accountId: 'local', ready: true, folders: [], files: [], index: defaultIndex(), opened: {}, openedAt: {}, localMedia: [], sharedView: null })
  useJobsStore.setState({ jobs: [], live: {}, proposals: [] })
  useRecorderStore.setState({ result: recording(), resultPlace: 'dialog' })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

const open = () =>
  render(
    <MemoryRouter>
      <RecordingDoneDialog />
    </MemoryRouter>,
  )

describe('Gravação pronta asks only whether to transcribe', () => {
  it('"Não, só a mídia" saves a note of the recording, linked to the media, and opens it, with no transcription', async () => {
    open()
    expect(screen.getByRole('radiogroup', { name: 'Quer a transcrição?' })).toBeInTheDocument()
    expect(screen.getByRole('radio', { name: /Sim, transcrever/ })).toHaveAttribute('aria-checked', 'true')
    expect(screen.queryByText('O que gerar')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('radio', { name: /Não, só a mídia/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Salvar' }))
    await waitFor(() => expect(navigate).toHaveBeenCalled())
    const note = useLibraryStore.getState().files[0]
    expect(navigate).toHaveBeenCalledWith(`/arquivo/${note.id}`)
    expect(note).toMatchObject({ name: 'Reunião 14-10-2026, 09-00-00', type: 'reading', status: 'ready', origin: { input: 'recording', mime: 'audio/webm', durationSeconds: 65 } })
    expect(memory.sidecars.get(note.id)?.recording?.marks).toHaveLength(1)
    expect((await listLocalMedia())[0].fileIds).toEqual([note.id])
    expect(transcribe).not.toHaveBeenCalled()
  })

  it('"Sim, transcrever" saves and transcribes inside the note', async () => {
    open()
    fireEvent.click(screen.getByRole('button', { name: 'Salvar' }))
    await waitFor(() => expect(transcribe).toHaveBeenCalled())
    const note = useLibraryStore.getState().files[0]
    await waitFor(() => expect(memory.sidecars.get(note.id)?.recording?.blocks).toHaveLength(1))
    expect(memory.sidecars.get(note.id)?.recording?.marks).toHaveLength(1)
  })

  it('"Descartar" asks first and then removes the recording', async () => {
    open()
    fireEvent.click(screen.getByRole('button', { name: 'Descartar' }))
    expect(folder.has('gravacao-1.webm')).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'Descartar' }))
    expect(useRecorderStore.getState().result).toBeNull()
    await waitFor(() => expect(folder.has('gravacao-1.webm')).toBe(false))
    expect(useLibraryStore.getState().files).toHaveLength(0)
  })
})
