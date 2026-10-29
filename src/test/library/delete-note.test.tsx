import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { Blob as NodeBlob, File as NodeFile } from 'node:buffer'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'

vi.mock('@/components/reader/GithubMarkdownView', () => ({
  default: ({ markdown }: { markdown: string }) => <div data-testid="markdown">{markdown}</div>,
}))

import { ConfirmDialog } from '@/components/dialogs/SimpleDialogs'
import { ItemMenu } from '@/components/library/ItemMenu'
import { SelectionBar } from '@/components/library/SelectionBar'
import { defaultIndex } from '@/lib/defaults'
import { paths } from '@/lib/paths'
import { addLocalMedia, listLocalMedia } from '@/lib/recording/media-library'
import type { Repository } from '@/lib/storage/repository'
import WorkspacePage from '@/pages/workspace'
import { useLibraryStore } from '@/stores/library'
import { useUiStore } from '@/stores/ui'
import type { FileSidecar, SourceMeta } from '@/types/domain'

function memoryRepository() {
  const sidecars = new Map<string, FileSidecar>()
  const contents = new Map<string, string>()
  const removeSource = vi.fn(async () => undefined)
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
    removeSource,
  } as unknown as Repository
  return { repo, removeSource }
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

const recorded: SourceMeta = { input: 'recording', name: 'gravacao-1.webm', mime: 'audio/webm', durationSeconds: 10, storage: 'none' }

async function note(name: string, origin: SourceMeta | null = null): Promise<string> {
  const meta = await useLibraryStore.getState().createFile({ name, type: 'reading', status: 'ready', folderId: null, origin }, 'Você [00:00]: Vamos lançar em maio?')
  return meta.id
}

async function recordedNote(name = 'Monitoria'): Promise<string> {
  const id = await note(name, recorded)
  folder.set('gravacao-1.webm', new NodeBlob(['x']) as unknown as Blob)
  await addLocalMedia({ storedName: 'gravacao-1.webm', name: 'gravacao-1.webm', mime: 'audio/webm', durationSeconds: 10, size: 8, createdAt: '2026-10-14T12:00:00Z', fileIds: [id] })
  useLibraryStore.setState({ localMedia: await listLocalMedia() })
  return id
}

function Where() {
  return <span data-testid="where">{useLocation().pathname}</span>
}

function Confirm() {
  const overlay = useUiStore(state => state.overlay)
  return overlay?.kind === 'confirm' ? <ConfirmDialog overlay={overlay} /> : null
}

function renderMenu(id: string, at = '/', page = false) {
  useUiStore.getState().openMenu({ kind: 'file', id, x: 10, y: 10 })
  const element = (
    <>
      {page && <WorkspacePage />}
      <ItemMenu />
      <Confirm />
      <Where />
    </>
  )
  render(
    <MemoryRouter initialEntries={[at]}>
      <Routes>
        <Route path="/arquivo/:fileId" element={element} />
        <Route path="*" element={element} />
      </Routes>
    </MemoryRouter>,
  )
  fireEvent.click(within(screen.getByRole('menu')).getByRole('button', { name: 'Apagar' }))
}

const fileOf = (id: string) => useLibraryStore.getState().files.find(file => file.id === id)!

beforeEach(() => {
  memory = memoryRepository()
  folder = installBrowserFolder()
  useLibraryStore.setState({ repo: memory.repo, accountId: 'local', ready: true, folders: [], files: [], index: defaultIndex(), opened: {}, openedAt: {}, localMedia: [], sharedView: null, sizes: {} })
  useUiStore.setState({ menu: null, overlay: null, selection: new Set() })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('deleting a note that has media', () => {
  it('asks whether the media goes too, with both choices and Cancelar', async () => {
    const id = await recordedNote()
    renderMenu(id)
    const dialog = await screen.findByRole('alertdialog', { name: 'Apagar "Monitoria"?' })
    expect(dialog).toHaveTextContent('A nota vai para a lixeira e dá para restaurar. O áudio pode ir junto, mas aí não volta.')
    expect(within(dialog).getAllByRole('button').map(button => button.textContent)).toEqual(['', 'Cancelar', 'Apagar só a nota', 'Apagar a nota e a mídia'])
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancelar' }))
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
    expect(fileOf(id).deletedAt).toBeNull()
    expect(folder.has('gravacao-1.webm')).toBe(true)
  })

  it('"Apagar só a nota" sends the note to the trash and keeps the media', async () => {
    const id = await recordedNote()
    renderMenu(id)
    fireEvent.click(await screen.findByRole('button', { name: 'Apagar só a nota' }))
    await waitFor(() => expect(fileOf(id).deletedAt).toBeTruthy())
    expect(folder.has('gravacao-1.webm')).toBe(true)
    expect(useLibraryStore.getState().localMedia.map(item => item.storedName)).toEqual(['gravacao-1.webm'])
    expect(fileOf(id).origin?.removedAt).toBeFalsy()
  })

  it('"Apagar a nota e a mídia" sends the note to the trash and removes the media from Mídias', async () => {
    const id = await recordedNote()
    renderMenu(id)
    fireEvent.click(await screen.findByRole('button', { name: 'Apagar a nota e a mídia' }))
    await waitFor(() => expect(fileOf(id).deletedAt).toBeTruthy())
    expect(folder.has('gravacao-1.webm')).toBe(false)
    expect(await listLocalMedia()).toEqual([])
    expect(useLibraryStore.getState().localMedia).toEqual([])
    expect(fileOf(id).origin?.removedAt).toBeTruthy()
  })

  it('a video kept in Google Drive is removed from the Drive too', async () => {
    const id = await note('Aula gravada', { input: 'file', name: 'aula.mp4', mime: 'video/mp4', durationSeconds: 60, storage: 'drive', storedFileId: 'drv-1' })
    renderMenu(id)
    expect(await screen.findByRole('alertdialog')).toHaveTextContent('O vídeo pode ir junto')
    fireEvent.click(screen.getByRole('button', { name: 'Apagar a nota e a mídia' }))
    await waitFor(() => expect(fileOf(id).deletedAt).toBeTruthy())
    expect(memory.removeSource).toHaveBeenCalledWith('drv-1')
    expect(fileOf(id).origin).toMatchObject({ storedFileId: undefined })
  })
})

describe('deleting a note without media', () => {
  it('goes straight to the trash, with no question', async () => {
    const id = await note('Pauta')
    renderMenu(id)
    await waitFor(() => expect(fileOf(id).deletedAt).toBeTruthy())
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
    expect(useUiStore.getState().overlay).toBeNull()
    expect(screen.getByTestId('where')).toHaveTextContent(/^\/$/)
  })
})

describe('deleting the note that is open', () => {
  it('without media, leaves the deleted note and goes to the library', async () => {
    const id = await note('Pauta')
    renderMenu(id, paths.file(id), true)
    await waitFor(() => expect(screen.getByTestId('where')).toHaveTextContent(paths.library))
    expect(fileOf(id).deletedAt).toBeTruthy()
  })

  it('with media, after the choice, goes to the library', async () => {
    const id = await recordedNote()
    renderMenu(id, paths.file(id), true)
    fireEvent.click(await screen.findByRole('button', { name: 'Apagar só a nota' }))
    await waitFor(() => expect(screen.getByTestId('where')).toHaveTextContent(paths.library))
  })
})

describe('deleting the selection', () => {
  it('asks once about the media of the selected notes and removes it when asked', async () => {
    const audio = await recordedNote()
    const text = await note('Pauta')
    useUiStore.getState().setSelection([audio, text])
    render(
      <MemoryRouter>
        <SelectionBar />
        <Confirm />
      </MemoryRouter>,
    )
    fireEvent.click(within(screen.getByRole('toolbar', { name: 'Seleção' })).getByRole('button', { name: /Apagar/ }))
    const dialog = await screen.findByRole('alertdialog', { name: 'Apagar 2 notas?' })
    expect(within(dialog).getByRole('button', { name: 'Apagar só as notas' })).toBeInTheDocument()
    fireEvent.click(within(dialog).getByRole('button', { name: 'Apagar as notas e as mídias' }))
    await waitFor(() => expect(fileOf(text).deletedAt).toBeTruthy())
    expect(fileOf(audio).deletedAt).toBeTruthy()
    expect(folder.has('gravacao-1.webm')).toBe(false)
    expect(useUiStore.getState().selection.size).toBe(0)
  })
})
