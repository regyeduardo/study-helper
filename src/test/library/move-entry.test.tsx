import { beforeEach, describe, expect, it } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

import type { FileMeta, FileSidecar, FolderMeta, SourceMeta } from '@/types/domain'
import { Overlays } from '@/components/dialogs/Overlays'
import { EntryList } from '@/components/library/EntryList'
import { ItemMenu } from '@/components/library/ItemMenu'
import { EntryPage } from '@/components/reader/EntryPage'
import { defaultIndex, newFileMeta, newFolderMeta, newSidecar } from '@/lib/defaults'
import type { Repository } from '@/lib/storage/repository'
import { useLibraryStore } from '@/stores/library'
import { useUiStore } from '@/stores/ui'

const CREATED = { at: '2026-11-03T12:00:00.000Z', deviceId: 'd1', deviceName: 'Notebook' }
const VIDEO: SourceMeta = { input: 'file', name: 'kickoff.mp4', sizeBytes: 184 * 1024 * 1024, mime: 'video/mp4', durationSeconds: 52 * 60, storage: 'drive', storedFileId: 'drv-video', expiresAt: null }

let aurora: FolderMeta
let atas: FolderMeta
let saved: Map<string, FileSidecar>

function item(id: string, fields: Partial<FileMeta>): FileSidecar {
  return newSidecar(newFileMeta({ id, name: id, type: 'class', created: CREATED, updated: CREATED, ...fields }))
}

function seed() {
  aurora = newFolderMeta({ id: 'aurora', name: 'Projeto Aurora' })
  atas = newFolderMeta({ id: 'atas', name: 'Atas' })
  const sidecars = [
    item('video', { name: 'Reunião de kickoff.mp4', role: 'entrada', kept: 'arquivo', type: 'reading', origin: VIDEO, folderId: aurora.id }),
    item('ata', { name: 'Ata do kickoff', type: 'meeting', parentFileId: 'video', folderId: aurora.id }),
  ]
  saved = new Map(sidecars.map(sidecar => [sidecar.meta.id, sidecar]))
  const repo = {
    kind: 'local',
    accountId: 'local',
    readContent: async () => '',
    readSidecar: async (id: string) => saved.get(id)!,
    saveFile: async (next: FileSidecar) => {
      saved.set(next.meta.id, next)
      return next
    },
    saveIndex: async () => undefined,
    fileSizes: async () => ({}),
  } as unknown as Repository
  useLibraryStore.setState({ repo, accountId: 'local', ready: true, folders: [aurora, atas], files: sidecars.map(sidecar => sidecar.meta), index: defaultIndex(), opened: {}, openedAt: {}, localMedia: [], sharedView: null, sizes: {} })
  useUiStore.setState({ menu: null, overlay: null, selection: new Set(), toasts: [] })
}

const stored = (id: string) => useLibraryStore.getState().files.find(file => file.id === id)!
const lastToast = () => useUiStore.getState().toasts.at(-1)?.text
const tree = (dialog: HTMLElement) => within(dialog).getByRole('tree', { name: 'Todas as pastas' })

/** Marks a folder in the open chooser and confirms with "Mover", as a person would. */
async function moveTo(name: string, windowTitle = 'Mover 1 item', answer: string | null = 'Só a entrada') {
  const dialog = await screen.findByRole('dialog', { name: windowTitle })
  fireEvent.click(within(tree(dialog)).getByRole('treeitem', { name }))
  expect(within(tree(dialog)).getByRole('treeitem', { selected: true })).toHaveTextContent(name)
  fireEvent.click(within(dialog).getByRole('button', { name: 'Mover' }))
  // an entrada with notes born of it: the question comes right after the folder (B)
  if (answer) fireEvent.click(await screen.findByRole('button', { name: answer }))
}

function renderEntryPage() {
  return render(
    <MemoryRouter>
      <EntryPage fileId="video" />
      <Overlays />
    </MemoryRouter>,
  )
}

const openMove = () => {
  fireEvent.click(screen.getByRole('button', { name: 'Mais ações' }))
  fireEvent.click(screen.getByRole('menuitem', { name: 'Mover para…' }))
}

beforeEach(seed)

describe('mover uma entrada pela página da entrada', () => {
  it('"Mais ações" > "Mover para…" > pasta > "Mover" leva só a entrada, grava e mostra a pasta nova', async () => {
    render(
      <MemoryRouter>
        <EntryPage fileId="video" />
        <Overlays />
      </MemoryRouter>,
    )
    expect(screen.getByText('Entrada · Vídeo').parentElement).toHaveTextContent('Projeto Aurora')
    fireEvent.click(screen.getByRole('button', { name: 'Mais ações' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Mover para…' }))
    await moveTo('Atas')
    await waitFor(() => expect(useUiStore.getState().overlay).toBeNull())
    expect(stored('video').folderId).toBe('atas')
    expect(saved.get('video')!.meta.folderId).toBe('atas')
    expect(screen.getByText('Entrada · Vídeo').parentElement).toHaveTextContent('Atas')
    expect(screen.getByText('Entrada · Vídeo').parentElement).not.toHaveTextContent('Projeto Aurora')
    expect(lastToast()).toBe('Movido para Atas')
    // only the entrada moves: the note born of it stays
    expect(stored('ata').folderId).toBe('aurora')
    expect(saved.get('ata')!.meta.folderId).toBe('aurora')
  })

  it('a página já aberta no conteúdo (entrada lida antes de mover) também mostra a pasta nova', async () => {
    await useLibraryStore.getState().openFile('video')
    render(
      <MemoryRouter>
        <EntryPage fileId="video" />
        <Overlays />
      </MemoryRouter>,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Mais ações' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Mover para…' }))
    await moveTo('Atas')
    await waitFor(() => expect(saved.get('video')!.meta.folderId).toBe('atas'))
    expect(screen.getByText('Entrada · Vídeo').parentElement).toHaveTextContent('Atas')
    expect(lastToast()).toBe('Movido para Atas')
  })

  it('mover para a raiz (Biblioteca) também vale', async () => {
    render(
      <MemoryRouter>
        <EntryPage fileId="video" />
        <Overlays />
      </MemoryRouter>,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Mais ações' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Mover para…' }))
    const dialog = await screen.findByRole('dialog', { name: 'Mover 1 item' })
    fireEvent.click(within(tree(dialog)).getByRole('treeitem', { name: 'Atas' }))
    fireEvent.click(within(tree(dialog)).getByRole('treeitem', { name: 'Biblioteca (raiz)' }))
    fireEvent.click(within(dialog).getByRole('button', { name: 'Mover' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Só a entrada' }))
    await waitFor(() => expect(stored('video').folderId).toBeNull())
    expect(saved.get('video')!.meta.folderId).toBeNull()
    expect(lastToast()).toBe('Movido para Biblioteca')
  })
})

describe('a entrada com notas nascidas dela: a pergunta na hora (B)', () => {
  it('depois da pasta, pergunta se leva as notas, dizendo quantas e para onde', async () => {
    renderEntryPage()
    openMove()
    await moveTo('Atas', 'Mover 1 item', null)
    const question = await screen.findByRole('alertdialog', { name: 'Levar as notas também?' })
    expect(question).toHaveTextContent('1 nota nasceu desta entrada')
    expect(question).toHaveTextContent('Atas')
    expect(within(question).getByRole('button', { name: 'Só a entrada' })).toBeInTheDocument()
    expect(within(question).getByRole('button', { name: 'A entrada e as notas' })).toBeInTheDocument()
    // nothing moved before the answer
    expect(stored('video').folderId).toBe('aurora')
  })

  it('"A entrada e as notas" leva a família inteira para a pasta escolhida', async () => {
    renderEntryPage()
    openMove()
    await moveTo('Atas', 'Mover 1 item', 'A entrada e as notas')
    await waitFor(() => expect(stored('ata').folderId).toBe('atas'))
    expect(stored('video').folderId).toBe('atas')
    expect(saved.get('ata')!.meta.folderId).toBe('atas')
    expect(saved.get('video')!.meta.folderId).toBe('atas')
    expect(lastToast()).toBe('Movido para Atas, com 1 nota')
  })

  it('sem nenhuma nota nascida dela, move direto, sem perguntar', async () => {
    useLibraryStore.setState(state => ({ files: state.files.filter(file => file.id !== 'ata') }))
    renderEntryPage()
    openMove()
    await moveTo('Atas', 'Mover 1 item', null)
    await waitFor(() => expect(stored('video').folderId).toBe('atas'))
    expect(screen.queryByRole('alertdialog', { name: 'Levar as notas também?' })).not.toBeInTheDocument()
    expect(lastToast()).toBe('Movido para Atas')
  })
})

describe('mover uma entrada pela lista de Entradas', () => {
  it('o menu do item: "Mover" > pasta > "Mover" grava a pasta nova', async () => {
    useUiStore.getState().openMenu({ kind: 'file', id: 'video', x: 10, y: 10 })
    render(
      <MemoryRouter>
        <ItemMenu />
        <Overlays />
      </MemoryRouter>,
    )
    fireEvent.click(within(screen.getByRole('menu')).getByRole('button', { name: 'Mover' }))
    await moveTo('Atas')
    await waitFor(() => expect(useUiStore.getState().overlay).toBeNull())
    expect(stored('video').folderId).toBe('atas')
    expect(saved.get('video')!.meta.folderId).toBe('atas')
    expect(lastToast()).toBe('Movido para Atas')
  })

  it('a lista mostra a pasta nova depois de mover', async () => {
    render(
      <MemoryRouter>
        <EntryList />
        <ItemMenu />
        <Overlays />
      </MemoryRouter>,
    )
    useUiStore.getState().openMenu({ kind: 'file', id: 'video', x: 10, y: 10 })
    fireEvent.click(await within(await screen.findByRole('menu')).findByRole('button', { name: 'Mover' }))
    await moveTo('Atas')
    await waitFor(() => expect(stored('video').folderId).toBe('atas'))
    expect(screen.getByRole('link', { name: /Reunião de kickoff\.mp4/ }).closest('li, tr, article, div')).toHaveTextContent('Atas')
  })
})
