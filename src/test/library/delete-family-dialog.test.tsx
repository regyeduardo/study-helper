import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

import type { ArtifactSummary, FileMeta, FileSidecar, FolderMeta, SourceMeta } from '@/types/domain'
import { Overlays } from '@/components/dialogs/Overlays'
import { ItemMenu } from '@/components/library/ItemMenu'
import { SelectionBar } from '@/components/library/SelectionBar'
import { TrashList } from '@/components/library/TrashList'
import { defaultIndex, newFileMeta, newFolderMeta, newSidecar } from '@/lib/defaults'
import type { Repository } from '@/lib/storage/repository'
import { useLibraryStore } from '@/stores/library'
import { useUiStore } from '@/stores/ui'

// The "Apagar" window of a family (FR-028, SC-005): the whole tree with the count, "Apagar tudo" and "Apagar só esta".

const VIDEO: SourceMeta = { input: 'file', name: 'kickoff.mp4', sizeBytes: 900, mime: 'video/mp4', storage: 'drive', storedFileId: 'drv-video', expiresAt: null }
const AUDIO: SourceMeta = { input: 'file', name: 'monitoria.m4a', sizeBytes: 90, mime: 'audio/mp4', storage: 'drive', storedFileId: 'drv-audio', expiresAt: null }

function memoryRepository(sidecars: FileSidecar[]) {
  const stored = new Map(sidecars.map(sidecar => [sidecar.meta.id, sidecar]))
  const removeSource = vi.fn(async (_ref: string) => undefined)
  const repo = {
    kind: 'local',
    accountId: 'local',
    readContent: async () => '',
    readSidecar: async (id: string) => stored.get(id)!,
    saveFile: async (sidecar: FileSidecar) => {
      stored.set(sidecar.meta.id, sidecar)
      return sidecar
    },
    removeFile: async (id: string) => void stored.delete(id),
    saveFolder: async () => undefined,
    saveIndex: async () => undefined,
    fileSizes: async () => ({}),
    removeSource,
  } as unknown as Repository
  return { repo, stored, removeSource }
}

const at = (minute: number) => ({ at: `2026-11-07T10:${String(minute).padStart(2, '0')}:00.000Z`, deviceId: 'd1', deviceName: 'Notebook' })
const artifact = (id: string, kind: ArtifactSummary['kind'], name: string): ArtifactSummary => ({ id, kind, name, updatedAt: at(1).at })

function item(id: string, name: string, fields: Partial<FileMeta> = {}): FileSidecar {
  return newSidecar(newFileMeta({ id, name, type: 'class', created: at(0), updated: at(0), ...fields }))
}

let memory: ReturnType<typeof memoryRepository>
let atas: FolderMeta
let trabalho: FolderMeta

/**
 * video (entrada, Trabalho) ─┬─ ata (Atas, 2 artifacts) ── explicacao (Trabalho)
 *                            ├─ aula (Trabalho)
 *                            └─ antiga (already in the Lixeira, deleted alone)
 * solta (no family) · gravada (no family, with media) · podcast (entrada, no family, with media)
 */
function seed() {
  atas = newFolderMeta({ name: 'Atas' })
  trabalho = newFolderMeta({ name: 'Trabalho' })
  const sidecars = [
    item('video', 'Reunião de kickoff.mp4', { role: 'entrada', kept: 'arquivo', type: 'reading', origin: VIDEO, folderId: trabalho.id }),
    item('ata', 'Ata da reunião', { type: 'meeting', parentFileId: 'video', folderId: atas.id, artifacts: [artifact('m1', 'mapa', 'Decisões do cronograma'), artifact('c1', 'cartoes', 'Prazos e responsáveis')] }),
    item('explicacao', 'Explicação: caminho crítico', { type: 'explanation', parentFileId: 'ata', folderId: trabalho.id }),
    item('aula', 'Aula: cronograma', { parentFileId: 'video', folderId: trabalho.id }),
    item('antiga', 'Resumo antigo', { parentFileId: 'video', folderId: trabalho.id, deletedAt: '2026-11-01T10:00:00.000Z' }),
    item('solta', 'Ideias soltas', { folderId: trabalho.id }),
    item('gravada', 'Monitoria', { type: 'reading', origin: AUDIO, folderId: null }),
    item('podcast', 'Podcast.m4a', { role: 'entrada', kept: 'arquivo', type: 'reading', origin: { ...AUDIO, storedFileId: 'drv-podcast' }, folderId: null }),
  ]
  memory = memoryRepository(sidecars)
  useLibraryStore.setState({ repo: memory.repo, accountId: 'local', ready: true, folders: [atas, trabalho], files: sidecars.map(sidecar => sidecar.meta), index: defaultIndex(), opened: {}, openedAt: {}, localMedia: [], sharedView: null, sizes: {} })
  useUiStore.setState({ menu: null, overlay: null, selection: new Set(), toasts: [] })
}

const library = () => useLibraryStore.getState()
const fileOf = (id: string) => library().files.find(file => file.id === id)!
const lastToast = () => useUiStore.getState().toasts.at(-1)?.text

function renderApp(extra?: React.ReactNode) {
  render(
    <MemoryRouter>
      <ItemMenu />
      <SelectionBar />
      <Overlays />
      {extra}
    </MemoryRouter>,
  )
}

/** "Apagar" in the item's menu. */
function deleteFromMenu(id: string) {
  useUiStore.getState().openMenu({ kind: 'file', id, x: 10, y: 10 })
  renderApp()
  fireEvent.click(within(screen.getByRole('menu')).getByRole('button', { name: 'Apagar' }))
}

/** The node of the tree with this name: its name, the folder it lives in, its artifacts and its children. */
function node(dialog: HTMLElement, name: string) {
  const items = within(dialog)
    .getAllByRole('listitem')
    .filter(li => li.querySelector('.dfam-name')?.textContent === name)
  expect(items).toHaveLength(1)
  return items[0]
}
const namesIn = (dialog: HTMLElement) => [...dialog.querySelectorAll('.dfam-name')].map(element => element.textContent)

beforeEach(seed)

describe('apagar um item com descendentes', () => {
  it('a janela mostra 100% dos descendentes, em qualquer pasta, com a pasta de cada um e a contagem', async () => {
    deleteFromMenu('video')
    const dialog = await screen.findByRole('alertdialog', { name: 'Apagar “Reunião de kickoff.mp4”?' })
    expect(dialog).toHaveTextContent('Dela nasceram 3 notas · 2 artefatos.')
    expect(namesIn(dialog)).toEqual(['Ata da reunião', 'Explicação: caminho crítico', 'Aula: cronograma'])
    // nested by mother, each with its folder
    const ata = node(dialog, 'Ata da reunião')
    expect(within(ata).getByText('Atas')).toBeInTheDocument()
    expect(within(ata).getByText('Decisões do cronograma')).toBeInTheDocument()
    expect(within(ata).getByText('Prazos e responsáveis')).toBeInTheDocument()
    expect(ata).toContainElement(node(dialog, 'Explicação: caminho crítico'))
    expect(within(node(dialog, 'Explicação: caminho crítico')).getByText('Trabalho')).toBeInTheDocument()
    expect(node(dialog, 'Aula: cronograma')).not.toContainElement(node(dialog, 'Explicação: caminho crítico'))
    // what is already in the Lixeira, and what is not of the family, is not shown
    expect(dialog).not.toHaveTextContent('Resumo antigo')
    expect(dialog).not.toHaveTextContent('Ideias soltas')
    expect(dialog).toHaveTextContent('Tudo vai para a Lixeira e dá para restaurar.')
    expect(within(dialog).getAllByRole('button').map(button => button.textContent)).toEqual(['', 'Cancelar', 'Apagar só esta', 'Apagar tudo'])
  })

  it('uma nota com filha também abre a janela, com a contagem dela', async () => {
    deleteFromMenu('ata')
    const dialog = await screen.findByRole('alertdialog', { name: 'Apagar “Ata da reunião”?' })
    expect(dialog).toHaveTextContent('Dela nasceu 1 nota.')
    expect(namesIn(dialog)).toEqual(['Explicação: caminho crítico'])
  })

  it('"Apagar tudo" leva o item e a família inteira para a Lixeira, marcados para voltar juntos', async () => {
    deleteFromMenu('video')
    fireEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Apagar tudo' }))
    await waitFor(() => expect(fileOf('aula').deletedAt).toBeTruthy())
    for (const id of ['video', 'ata', 'explicacao', 'aula']) expect(fileOf(id)).toMatchObject({ deletedAt: expect.any(String), trashedWith: 'video' })
    expect(fileOf('solta').deletedAt).toBeNull()
    expect(fileOf('antiga').trashedWith).toBeUndefined()
    expect(memory.removeSource).not.toHaveBeenCalled()
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
    expect(lastToast()).toBe('“Reunião de kickoff.mp4” e mais 3 notas foram para a Lixeira.')
  })

  it('"Apagar só esta" numa nota: só ela vai para a Lixeira, e a filha sobe para a mãe dela', async () => {
    deleteFromMenu('ata')
    fireEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Apagar só esta' }))
    await waitFor(() => expect(fileOf('ata').deletedAt).toBeTruthy())
    expect(fileOf('ata').trashedWith).toBeUndefined()
    expect(fileOf('explicacao')).toMatchObject({ parentFileId: 'video', deletedAt: null, folderId: trabalho.id })
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
    expect(lastToast()).toBe('Só “Ata da reunião” foi para a Lixeira. As notas ficaram, cada uma na sua pasta.')
  })

  it('"Apagar só esta" numa entrada: as notas ficam, sem mãe; a Ata continua com a entrada', async () => {
    deleteFromMenu('video')
    fireEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Apagar só esta' }))
    await waitFor(() => expect(fileOf('video').deletedAt).toBeTruthy())
    expect(fileOf('aula')).toMatchObject({ parentFileId: null, deletedAt: null })
    expect(fileOf('ata')).toMatchObject({ parentFileId: 'video', deletedAt: null })
    expect(fileOf('explicacao')).toMatchObject({ parentFileId: 'ata', deletedAt: null })
    expect(memory.removeSource).not.toHaveBeenCalled()
  })

  it('Cancelar não muda nada', async () => {
    const before = library().files
    deleteFromMenu('video')
    fireEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Cancelar' }))
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
    expect(library().files).toBe(before)
  })
})

describe('apagar um item sem descendentes segue a confirmação de hoje', () => {
  it('sem mídia, vai direto para a Lixeira pelo menu', async () => {
    deleteFromMenu('solta')
    await waitFor(() => expect(fileOf('solta').deletedAt).toBeTruthy())
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
    expect(fileOf('solta').trashedWith).toBeUndefined()
  })

  it('com mídia, pergunta se a mídia vai junto', async () => {
    deleteFromMenu('gravada')
    const dialog = await screen.findByRole('alertdialog', { name: 'Apagar "Monitoria"?' })
    expect(within(dialog).getAllByRole('button').map(button => button.textContent)).toEqual(['', 'Cancelar', 'Apagar só a nota', 'Apagar a nota e a mídia'])
  })

  it('a janela aberta pelo id (como na página da entrada) mostra a confirmação de hoje, com a escolha da mídia', async () => {
    useUiStore.getState().open({ kind: 'delete-family', fileId: 'gravada' })
    renderApp()
    const dialog = await screen.findByRole('alertdialog', { name: 'Apagar "Monitoria"?' })
    expect(dialog).toHaveTextContent('A nota vai para a lixeira e dá para restaurar. O áudio pode ir junto, mas aí não volta.')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Apagar a nota e a mídia' }))
    await waitFor(() => expect(fileOf('gravada').deletedAt).toBeTruthy())
    expect(memory.removeSource).toHaveBeenCalledWith('drv-audio')
  })

  it('numa entrada, a confirmação fala da entrada, não de uma nota', async () => {
    useUiStore.getState().open({ kind: 'delete-family', fileId: 'podcast' })
    renderApp()
    const dialog = await screen.findByRole('alertdialog', { name: 'Apagar "Podcast.m4a"?' })
    expect(dialog).toHaveTextContent('A entrada vai para a lixeira e dá para restaurar. O áudio pode ir junto, mas aí não volta.')
    expect(within(dialog).getAllByRole('button').map(button => button.textContent)).toEqual(['', 'Cancelar', 'Apagar só a entrada', 'Apagar a entrada e a mídia'])
  })

  it('a janela aberta pelo id, sem mídia, pede só a confirmação', async () => {
    useUiStore.getState().open({ kind: 'delete-family', fileId: 'solta' })
    renderApp()
    const dialog = await screen.findByRole('alertdialog', { name: 'Apagar "Ideias soltas"?' })
    expect(dialog).toHaveTextContent('A nota vai para a lixeira e dá para restaurar.')
    expect(within(dialog).getAllByRole('button').map(button => button.textContent)).toEqual(['', 'Cancelar', 'Apagar'])
    fireEvent.click(within(dialog).getByRole('button', { name: 'Apagar' }))
    await waitFor(() => expect(fileOf('solta').deletedAt).toBeTruthy())
  })
})

describe('apagar uma seleção com famílias', () => {
  function deleteSelection(ids: string[]) {
    useUiStore.getState().setSelection(ids)
    renderApp()
    fireEvent.click(within(screen.getByRole('toolbar', { name: 'Seleção' })).getByRole('button', { name: /Apagar/ }))
  }

  it('mostra a árvore de todos os itens numa janela só, com a contagem somada', async () => {
    deleteSelection(['video', 'solta'])
    const dialog = await screen.findByRole('alertdialog', { name: 'Apagar 2 itens?' })
    expect(dialog).toHaveTextContent('Delas nasceram 3 notas · 2 artefatos.')
    expect(namesIn(dialog)).toEqual(['Reunião de kickoff.mp4', 'Ata da reunião', 'Explicação: caminho crítico', 'Aula: cronograma', 'Ideias soltas'])
    expect(node(dialog, 'Reunião de kickoff.mp4')).toContainElement(node(dialog, 'Aula: cronograma'))
    expect(within(dialog).getAllByRole('button').map(button => button.textContent)).toEqual(['', 'Cancelar', 'Apagar só estas', 'Apagar tudo'])
  })

  it('"Apagar tudo" leva cada família junto e o resto sozinho, e limpa a seleção', async () => {
    deleteSelection(['video', 'solta'])
    fireEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Apagar tudo' }))
    await waitFor(() => expect(fileOf('solta').deletedAt).toBeTruthy())
    for (const id of ['video', 'ata', 'explicacao', 'aula']) expect(fileOf(id)).toMatchObject({ deletedAt: expect.any(String), trashedWith: 'video' })
    expect(fileOf('solta').trashedWith).toBeUndefined()
    expect(useUiStore.getState().selection.size).toBe(0)
  })

  it('um item dentro da família de outro selecionado aparece uma vez só, e vai junto', async () => {
    deleteSelection(['ata', 'video'])
    const dialog = await screen.findByRole('alertdialog', { name: 'Apagar 2 itens?' })
    expect(namesIn(dialog)).toEqual(['Reunião de kickoff.mp4', 'Ata da reunião', 'Explicação: caminho crítico', 'Aula: cronograma'])
    fireEvent.click(within(dialog).getByRole('button', { name: 'Apagar tudo' }))
    await waitFor(() => expect(fileOf('aula').deletedAt).toBeTruthy())
    for (const id of ['video', 'ata', 'explicacao', 'aula']) expect(fileOf(id).trashedWith).toBe('video')
  })

  it('"Apagar só estas" leva só os selecionados, e as filhas sobem', async () => {
    deleteSelection(['ata', 'aula'])
    fireEvent.click(within(await screen.findByRole('alertdialog', { name: 'Apagar 2 itens?' })).getByRole('button', { name: 'Apagar só estas' }))
    await waitFor(() => expect(fileOf('aula').deletedAt).toBeTruthy())
    expect(fileOf('ata').deletedAt).toBeTruthy()
    expect(fileOf('explicacao')).toMatchObject({ parentFileId: 'video', deletedAt: null })
    expect(fileOf('video').deletedAt).toBeNull()
    expect(useUiStore.getState().selection.size).toBe(0)
  })
})

describe('"Apagar só estas" com mãe e filha selecionadas', () => {
  it('a neta sobe além das duas, em qualquer ordem de seleção', async () => {
    useUiStore.getState().setSelection(['video', 'ata'])
    renderApp()
    fireEvent.click(within(screen.getByRole('toolbar', { name: 'Seleção' })).getByRole('button', { name: /Apagar/ }))
    fireEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Apagar só estas' }))
    await waitFor(() => expect(fileOf('video').deletedAt).toBeTruthy())
    expect(fileOf('ata').deletedAt).toBeTruthy()
    expect(fileOf('explicacao')).toMatchObject({ parentFileId: null, deletedAt: null })
    expect(fileOf('aula')).toMatchObject({ parentFileId: null, deletedAt: null })
  })
})

describe('restaurar da Lixeira', () => {
  const rowOf = (name: string) => screen.getByText(name).closest('.row') as HTMLElement

  it('quem foi com "Apagar tudo" diz que volta junto, e restaurar qualquer um traz a família inteira', async () => {
    await library().trashFamily('video')
    renderApp(<TrashList />)
    expect(rowOf('Aula: cronograma')).toHaveTextContent('volta junto com mais 3 itens')
    expect(rowOf('Reunião de kickoff.mp4')).toHaveTextContent('volta junto com mais 3 itens')
    expect(rowOf('Resumo antigo')).not.toHaveTextContent('volta junto')
    fireEvent.click(within(rowOf('Explicação: caminho crítico')).getByRole('button', { name: 'Restaurar' }))
    await waitFor(() => expect(fileOf('video').deletedAt).toBeNull())
    for (const id of ['ata', 'explicacao', 'aula']) expect(fileOf(id)).toMatchObject({ deletedAt: null, trashedWith: undefined })
    expect(fileOf('ata').folderId).toBe(atas.id)
    expect(fileOf('antiga').deletedAt).toBe('2026-11-01T10:00:00.000Z')
    expect(screen.queryByText('Aula: cronograma')).not.toBeInTheDocument()
    expect(lastToast()).toBe('4 itens restaurados')
  })

  it('um item apagado sozinho volta sozinho', async () => {
    await library().trashFiles(['solta'])
    renderApp(<TrashList />)
    fireEvent.click(within(rowOf('Ideias soltas')).getByRole('button', { name: 'Restaurar' }))
    await waitFor(() => expect(fileOf('solta').deletedAt).toBeNull())
    expect(fileOf('antiga').deletedAt).toBeTruthy()
    expect(lastToast()).toBe('Restaurado')
  })
})
