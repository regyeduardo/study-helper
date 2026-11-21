import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

// A YouTube entrada that hangs under a note (made by "Gerar a partir disto"): it shows in Entradas, in the family tree of the
// entrada above, and it goes with the family when that is deleted or moved.

import type { FileMeta, FolderMeta, SourceMeta } from '@/types/domain'
import { Overlays } from '@/components/dialogs/Overlays'
import { EntryList } from '@/components/library/EntryList'
import { EntryPage } from '@/components/reader/EntryPage'
import { newFileMeta, newFolderMeta } from '@/lib/defaults'
import { paths } from '@/lib/paths'
import { useLibraryStore } from '@/stores/library'
import { useUiStore } from '@/stores/ui'
import { fileOf, memoryLibrary, PAGE_URL, VIDEO_TITLE, YOUTUBE_URL } from '@/test/source-meta/fixture'

const STAMP = { at: '2026-11-14T10:00:00.000Z', deviceId: 'd1', deviceName: 'Notebook' }
const PAGE: SourceMeta = { input: 'url', name: 'Página de cálculo', url: PAGE_URL, storage: 'none' }
const VIDEO: SourceMeta = { input: 'youtube', name: VIDEO_TITLE, url: YOUTUBE_URL, storage: 'none' }

let calculo: FolderMeta
let outra: FolderMeta

function seed() {
  calculo = newFolderMeta({ id: 'calculo', name: 'Cálculo' })
  outra = newFolderMeta({ id: 'outra', name: 'Outra' })
  const at = (minute: number) => ({ ...STAMP, at: `2026-11-14T10:0${minute}:00.000Z` })
  const files: FileMeta[] = [
    newFileMeta({ id: 'pagina', name: 'Página de cálculo', role: 'entrada', kept: 'registro', type: 'reading', origin: PAGE, folderId: 'calculo', created: at(0), updated: at(0) }),
    newFileMeta({ id: 'limites', name: 'Limites', type: 'class', status: 'ready', parentFileId: 'pagina', origin: PAGE, folderId: 'calculo', created: at(1), updated: at(1) }),
    newFileMeta({ id: 'video', name: VIDEO_TITLE, role: 'entrada', kept: 'registro', type: 'reading', origin: VIDEO, parentFileId: 'limites', folderId: 'calculo', created: at(2), updated: at(2) }),
    newFileMeta({ id: 'derivadas', name: 'Aula: Derivadas', type: 'class', status: 'ready', parentFileId: 'video', origin: { input: 'text', name: VIDEO_TITLE, storage: 'none' }, folderId: 'calculo', created: at(3), updated: at(3) }),
  ]
  memoryLibrary({ files, folders: [calculo, outra] })
}

beforeEach(seed)

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('a entrada dentro de uma nota', () => {
  it('não aparece em Gravações: é nota de Vídeo, mas não foi gravada pelo app (003)', async () => {
    render(
      <MemoryRouter>
        <EntryList />
      </MemoryRouter>,
    )
    expect(await screen.findByText('Nenhuma gravação ainda')).toBeInTheDocument()
    expect(screen.queryByText(VIDEO_TITLE)).toBeNull()
  })

  it('aparece na árvore de "O que nasceu daqui" da entrada de cima, marcada com o seu tipo, com a nota que nasceu dela', async () => {
    render(
      <MemoryRouter initialEntries={[paths.entry('pagina')]}>
        <EntryPage fileId="pagina" />
      </MemoryRouter>,
    )
    const family = await screen.findByRole('region', { name: 'O que nasceu daqui' })
    const video = within(family).getByRole('link', { name: new RegExp(VIDEO_TITLE) })
    expect(video).toHaveAttribute('href', paths.file('video'))
    expect(video.closest('li')).toHaveTextContent('YouTube')
    expect(within(video.closest('li')!).getByRole('link', { name: /Aula: Derivadas/ })).toBeInTheDocument()
    // only the notes count
    expect(within(family).getByText('2 notas')).toBeInTheDocument()
  })

  it('na própria página, a nota que nasceu dela', async () => {
    render(
      <MemoryRouter initialEntries={[paths.entry('video')]}>
        <EntryPage fileId="video" />
      </MemoryRouter>,
    )
    const family = await screen.findByRole('region', { name: 'O que nasceu daqui' })
    expect(within(family).getByRole('link', { name: /Aula: Derivadas/ })).toBeInTheDocument()
  })

  it('"Apagar tudo" da entrada de cima leva a de dentro junto', async () => {
    useUiStore.getState().open({ kind: 'delete-family', fileId: 'pagina' })
    render(
      <MemoryRouter>
        <Overlays />
      </MemoryRouter>,
    )
    const tree = await screen.findByRole('list', { name: 'O que vai junto' })
    expect(within(tree).getByText(VIDEO_TITLE)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Apagar tudo' }))
    await waitFor(() => expect(['pagina', 'limites', 'video', 'derivadas'].every(id => fileOf(id).deletedAt)).toBe(true))
  })

  it('mover a entrada de cima "com as notas" leva a entrada de dentro também', async () => {
    useUiStore.getState().open({ kind: 'move', fileIds: ['pagina'], folderIds: [] })
    render(
      <MemoryRouter>
        <Overlays />
      </MemoryRouter>,
    )
    const dialog = await screen.findByRole('dialog', { name: 'Mover 1 item' })
    fireEvent.click(within(within(dialog).getByRole('tree', { name: 'Todas as pastas' })).getByRole('treeitem', { name: 'Outra' }))
    fireEvent.click(within(dialog).getByRole('button', { name: 'Mover' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Levar as filhas junto' }))
    await waitFor(() => expect(['pagina', 'limites', 'video', 'derivadas'].map(id => fileOf(id).folderId)).toEqual(['outra', 'outra', 'outra', 'outra']))
    expect(useLibraryStore.getState().files).toHaveLength(4)
  })
})
