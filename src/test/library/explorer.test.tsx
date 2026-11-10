import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, screen, waitFor, within } from '@testing-library/react'

import type { FileMeta, SourceMeta } from '@/types/domain'
import { NO_FILTERS } from '@/lib/library-filters'
import type { Repository } from '@/lib/storage/repository'
import { useLibraryStore } from '@/stores/library'
import { useUiStore } from '@/stores/ui'
import { FILES, renderAt, seedLibrary } from '@/test/library/explorer-fixture'

beforeEach(() => {
  seedLibrary()
  // the fixture's repo has no folder writing, and "Limpar tudo" keeps the tab
  useLibraryStore.setState(state => ({ repo: { ...state.repo, saveFolder: async () => undefined } as unknown as Repository }))
  useUiStore.setState({ filters: NO_FILTERS, selection: new Set(), overlay: null, drag: null })
})

afterEach(() => {
  vi.restoreAllMocks()
})

const table = () => screen.getByRole('table', { name: 'Notas e pastas' })
const rows = () => within(table()).getAllByRole('row').slice(1)
const names = () => rows().map(row => row.getAttribute('aria-label'))
const rowNamed = (name: string) => within(table()).getByRole('row', { name })
const nameCell = (name: string) => within(rowNamed(name)).getAllByRole('cell')[1]
const headers = () => within(table()).getAllByRole('columnheader').map(header => header.textContent?.trim())
const option = (name: RegExp) => screen.getByRole('checkbox', { name })
const box = (name: string) => within(table()).getByRole('checkbox', { name: `Marcar ${name}` })
const bar = () => screen.getByRole('toolbar', { name: 'Seleção' })

const change = (edit: (files: FileMeta[]) => FileMeta[]) => useLibraryStore.setState(state => ({ files: edit(state.files) }))
const fileOf = (id: string) => useLibraryStore.getState().files.find(file => file.id === id)!
const folderOf = (id: string) => useLibraryStore.getState().folders.find(folder => folder.id === id)!
const entrada = (id: string, name: string, folderId: string | null, origin: SourceMeta, extra: Partial<FileMeta> = {}): FileMeta => ({ ...FILES[0], id, name, folderId, role: 'entrada', kept: 'registro', tags: [], mastery: null, origin, ...extra })
const VIDEO: SourceMeta = { input: 'file', name: 'aula.mp4', mime: 'video/mp4', storage: 'none' }

function screenLike(matches: RegExp) {
  vi.spyOn(window, 'matchMedia').mockImplementation(
    query =>
      ({
        matches: matches.test(query),
        media: query,
        onchange: null,
        addListener: () => undefined,
        removeListener: () => undefined,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
        dispatchEvent: () => false,
      }) as MediaQueryList,
  )
}

function dataTransfer() {
  const data = new Map<string, string>()
  return {
    dropEffect: 'none',
    effectAllowed: 'all',
    files: [],
    items: [],
    get types() {
      return [...data.keys()]
    },
    setData: (type: string, value: string) => void data.set(type, value),
    getData: (type: string) => data.get(type) ?? '',
    clearData: () => data.clear(),
    setDragImage: () => undefined,
  }
}

const tree = () => screen.getByRole('tree', { name: 'Pastas' })
const treeFolder = (name: string) => within(within(tree()).getByRole('treeitem', { name })).getByText(name)

function drag(source: HTMLElement, target: HTMLElement, whileOver?: () => void) {
  const transfer = dataTransfer()
  fireEvent.dragStart(source, { dataTransfer: transfer })
  fireEvent.dragOver(target, { dataTransfer: transfer })
  whileOver?.()
  fireEvent.drop(target, { dataTransfer: transfer })
  fireEvent.dragEnd(source, { dataTransfer: transfer })
}

describe('explorer side bar', () => {
  it('shows Início, Para revisar, the folder tree and the tags with their counts', () => {
    renderAt('/biblioteca/calc')
    const side = screen.getByRole('complementary', { name: 'Navegação' })
    expect(within(side).getByRole('button', { name: /Início/ })).toBeInTheDocument()
    expect(within(side).getByRole('button', { name: /Para revisar/ })).toBeInTheDocument()
    const sideTree = within(side).getByRole('tree', { name: 'Pastas' })
    expect(within(sideTree).getAllByRole('treeitem').map(item => item.getAttribute('aria-label'))).toEqual(['Biblioteca', 'Cálculo I', 'Integrais', 'Exercícios', 'Física II'])
    expect(within(sideTree).getByRole('treeitem', { name: 'Cálculo I' })).toHaveAttribute('aria-current', 'page')
    const tags = within(side).getByRole('list', { name: 'Etiquetas' })
    expect(within(tags).getAllByRole('button').map(button => button.textContent)).toEqual(['limites3', 'derivadas2'])
  })

  it('a tag shows only the notes that have it, and a folder in the tree opens it', () => {
    renderAt('/biblioteca/calc')
    fireEvent.click(within(screen.getByRole('list', { name: 'Etiquetas' })).getByRole('button', { name: /derivadas/ }))
    expect(names()).toEqual(['Aula gravada: derivadas', 'Derivadas pela definição'])
    fireEvent.click(within(screen.getByRole('tree', { name: 'Pastas' })).getByRole('treeitem', { name: 'Física II' }))
    expect(screen.getByRole('heading', { name: 'Física II' })).toBeInTheDocument()
  })

  it('the tag of the side bar looks in the whole library, and is an active filter that can be taken off', () => {
    renderAt('/biblioteca/calc')
    fireEvent.click(within(screen.getByRole('list', { name: 'Etiquetas' })).getByRole('button', { name: /limites/ }))
    expect(names()).toEqual(['Limites laterais e continuidade', 'Monitoria de limites', 'Stewart, capítulo 2'])
    const active = screen.getByRole('group', { name: 'Filtros ativos' })
    expect(active).toHaveTextContent(/Etiqueta\s*limites/)
    fireEvent.click(within(active).getByRole('button', { name: /Etiqueta/ }))
    expect(useUiStore.getState().tag).toBeNull()
    expect(screen.queryByRole('group', { name: 'Filtros ativos' })).toBeNull()
  })
})

describe('explorer table', () => {
  it('lists folders and notes with Nome, Criado and Atualizado (FR-073: no "O que nasceu")', () => {
    renderAt('/biblioteca/calc')
    expect(headers()).toEqual(['', 'Nome', 'Criado', 'Atualizado', ''])
    expect(names()).toEqual(['Integrais', 'Exercícios', 'Aula gravada: derivadas', 'Derivadas pela definição', 'Limites laterais e continuidade', 'Monitoria de limites'])
    expect(nameCell('Integrais')).toHaveTextContent('Pasta · 1 item')
    expect(nameCell('Exercícios')).toHaveTextContent('Pasta · 0 itens')
    expect(nameCell('Aula gravada: derivadas')).toHaveTextContent('Vídeo · 1 h 10')
    expect(nameCell('Aula gravada: derivadas')).toHaveTextContent('#derivadas')
    expect(nameCell('Monitoria de limites')).toHaveTextContent('Áudio · 52 min')
    expect(nameCell('Monitoria de limites')).toHaveTextContent('#limites')
    expect(nameCell('Derivadas pela definição')).toHaveTextContent('Prova 80%')
    expect(nameCell('Limites laterais e continuidade')).toHaveTextContent('Prova 70%')
    expect(screen.queryByText(/curso/i)).not.toBeInTheDocument()
  })

  it('a note says if it was written directly', () => {
    renderAt('/biblioteca/calc')
    expect(nameCell('Limites laterais e continuidade')).toHaveTextContent('Nota · escrita direto')
    expect(nameCell('Monitoria de limites')).not.toHaveTextContent('escrita direto')
  })

  it('the folder row has the color of the folder', () => {
    useLibraryStore.setState(state => ({ folders: state.folders.map(folder => (folder.id === 'integ' ? { ...folder, color: 'verde' as const } : folder)) }))
    renderAt('/biblioteca/calc')
    expect(within(rowNamed('Integrais')).getByRole('img', { name: 'Pasta verde' })).toBeInTheDocument()
    expect(within(rowNamed('Exercícios')).queryByRole('img')).toBeNull()
  })

  it('an entrada is not a row of the folder: it is in Entradas, with "O que nasceu" (FR-073)', () => {
    change(files => [...files, entrada('video', 'Aula sem notas', 'calc', VIDEO)])
    renderAt('/biblioteca/calc')
    expect(screen.queryByRole('row', { name: 'Aula sem notas' })).toBeNull()
    expect(table()).not.toHaveTextContent('Nada ainda')
    expect(rows()).toHaveLength(6)
  })

  it('the panel filters what is here: the folders go, and what is elsewhere stays out', () => {
    renderAt('/biblioteca/calc')
    fireEvent.click(option(/^limites\b/))
    expect(names()).toEqual(['Limites laterais e continuidade', 'Monitoria de limites'])
    expect(screen.getByText('2 de 6')).toBeInTheDocument()
    fireEvent.click(option(/^limites\b/))
    expect(rows()).toHaveLength(6)
  })

  it('the Pasta filter looks in the chosen folder, wherever the person is', () => {
    renderAt('/biblioteca/fis')
    expect(names()).toEqual(['Ondas'])
    fireEvent.click(option(/^Integrais\b/))
    expect(names()).toEqual(['Stewart, capítulo 2'])
    expect(screen.getByRole('group', { name: 'Filtros ativos' })).toHaveTextContent(/Pasta\s*Integrais/)
  })

  it('browsing a folder is not an active filter', () => {
    renderAt('/biblioteca/calc')
    expect(screen.queryByRole('group', { name: 'Filtros ativos' })).toBeNull()
    expect(screen.queryByText(/\d+ de \d+/)).toBeNull()
    expect(option(/^Cálculo I\b/)).not.toBeChecked()
  })

  it('no Tudo, Entradas and Notas tabs: the folder lists its notes (FR-073)', () => {
    change(files => [...files, entrada('video', 'Aula em vídeo', 'calc', VIDEO), entrada('video2', 'Outra aula', 'calc', VIDEO)])
    renderAt('/biblioteca/calc')
    expect(screen.queryByRole('group', { name: 'Mostrar' })).toBeNull()
    expect(rows()).toHaveLength(6)
  })

  it('"Domínio abaixo de 60%" stays in the toolbar, and is cleared with the rest', () => {
    change(files => files.map(file => (file.id === 'derivadas' ? { ...file, mastery: 40 } : file)))
    renderAt('/biblioteca/calc')
    const chip = screen.getByRole('button', { name: 'Domínio abaixo de 60%' })
    fireEvent.click(chip)
    expect(chip).toHaveAttribute('aria-pressed', 'true')
    expect(names()).toEqual(['Derivadas pela definição'])
    expect(screen.getByText('1 de 6')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Limpar tudo' }))
    expect(chip).toHaveAttribute('aria-pressed', 'false')
    expect(rows()).toHaveLength(6)
  })

  it('a search shows only what it found, with the panel filters still on (FR-074)', async () => {
    useLibraryStore.setState({ opened: {} })
    renderAt('/biblioteca/calc')
    fireEvent.click(option(/^limites\b/))
    expect(screen.getByText('2 de 6')).toBeInTheDocument()
    fireEvent.change(screen.getByRole('searchbox', { name: 'Buscar' }), { target: { value: 'limites' } })
    const found = () => within(screen.getByRole('table', { name: 'Resultados da busca' })).getAllByRole('row').slice(1).map(row => row.getAttribute('aria-label'))
    // "Stewart, capítulo 2" has the tag, in Integrais, and no "limites" in its name or text
    await waitFor(() => expect(found()).toEqual(['Limites laterais e continuidade', 'Monitoria de limites']))
    expect(screen.getByText(/2 resultados/)).toBeInTheDocument()
  })

  it('what changed today says "Hoje", with the time below', () => {
    change(files => files.map(file => (file.id === 'limites' ? { ...file, updated: { ...file.updated, at: new Date().toISOString() } } : file)))
    renderAt('/biblioteca/calc')
    const cell = within(rowNamed('Limites laterais e continuidade')).getAllByRole('cell')[3]
    expect(within(cell).getByText('Hoje')).toBeInTheDocument()
    expect(within(cell).getByText(/^\d{2}:\d{2}$/)).toBeInTheDocument()
  })

  it('/ goes to the search', () => {
    renderAt('/biblioteca/calc')
    fireEvent.keyDown(document.body, { key: '/' })
    expect(screen.getByRole('searchbox', { name: 'Buscar' })).toHaveFocus()
  })

  it('clicking a column header sorts by it', () => {
    const at = (time: string) => ({ at: time, deviceId: 'local', deviceName: 'x' })
    change(files => files.map(file => (file.id === 'limites' ? { ...file, updated: at('2026-10-20T10:00:00Z') } : file.id === 'derivadas' ? { ...file, updated: at('2026-10-30T10:00:00Z') } : file)))
    renderAt('/biblioteca/calc')
    fireEvent.click(within(table()).getByRole('button', { name: 'Atualizado' }))
    expect(names().slice(2, 4)).toEqual(['Derivadas pela definição', 'Limites laterais e continuidade'])
    fireEvent.click(within(table()).getByRole('button', { name: 'Nome' }))
    expect(names().slice(2)).toEqual(['Aula gravada: derivadas', 'Derivadas pela definição', 'Limites laterais e continuidade', 'Monitoria de limites'])
  })
})

describe('"Guardado" in the row, only when it is not with the library', () => {
  const stored = { input: 'file', name: 'a.mp4', mime: 'video/mp4', storage: 'drive', storedFileId: 'drv' } as SourceMeta
  beforeEach(() => {
    useLibraryStore.setState(state => ({ repo: { ...state.repo, kind: 'drive' } as unknown as Repository }))
    change(files => [
      ...files,
      entrada('drive', 'No Drive', 'calc', stored, { kept: 'arquivo' }),
      entrada('apagada', 'Sem mídia', 'calc', { ...VIDEO, removedAt: '2026-11-01T00:00:00Z' }),
      entrada('registro', 'Só anotado', 'calc', VIDEO),
    ])
  })

  it('the entradas are not rows of the folder, and a note never says it is with the library', () => {
    renderAt('/biblioteca/calc')
    expect(names()).not.toContain('Sem mídia')
    expect(nameCell('Limites laterais e continuidade')).not.toHaveTextContent('No meu Drive')
  })

  it('a search result says where an entrada is, and stays quiet about what is in the Drive', async () => {
    renderAt('/biblioteca/calc')
    const result = (name: string) => within(within(screen.getByRole('table', { name: 'Resultados da busca' })).getByRole('row', { name })).getAllByRole('cell')[1]
    fireEvent.change(screen.getByRole('searchbox', { name: 'Buscar' }), { target: { value: 'Sem mídia' } })
    await waitFor(() => expect(result('Sem mídia')).toHaveTextContent('Mídia apagada'))
    fireEvent.change(screen.getByRole('searchbox', { name: 'Buscar' }), { target: { value: 'Só anotado' } })
    await waitFor(() => expect(result('Só anotado')).toHaveTextContent('Só o registro'))
    fireEvent.change(screen.getByRole('searchbox', { name: 'Buscar' }), { target: { value: 'No Drive' } })
    await waitFor(() => expect(result('No Drive')).not.toHaveTextContent('No meu Drive'))
  })
})

describe('the filters in the store', () => {
  it('ui.clearFilters takes the panel filters off too, keeping the tab', () => {
    useUiStore.getState().setFilters({ ...NO_FILTERS, scope: 'notas', kinds: ['nota'], tags: ['a'], period: '7dias' })
    useUiStore.getState().setTag('b')
    useUiStore.getState().clearFilters()
    const { filters, tag } = useUiStore.getState()
    expect(filters).toEqual({ ...NO_FILTERS, scope: 'notas' })
    expect(tag).toBeNull()
  })

  it('the tag of the side bar becomes the Etiqueta filter, and unmarking it there takes it off the side bar', () => {
    useUiStore.getState().setFilters({ ...NO_FILTERS, tags: ['antiga'] })
    useUiStore.getState().setTag('nova')
    expect(useUiStore.getState().filters.tags).toEqual(['nova'])
    useUiStore.getState().setFilters({ ...useUiStore.getState().filters, tags: [] })
    expect(useUiStore.getState().tag).toBeNull()
  })
})

describe('on a narrow screen', () => {
  beforeEach(() => screenLike(/max-width/))

  it('the panel is a drawer opened by a button, and the dates go under the name', () => {
    renderAt('/biblioteca/calc')
    expect(screen.queryByRole('complementary', { name: 'Filtros' })).toBeNull()
    expect(screen.queryByRole('dialog', { name: 'Filtros' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /^Filtros/ }))
    expect(screen.getByRole('dialog', { name: 'Filtros' })).toBeInTheDocument()
    expect(headers()).toEqual(['', 'Nome', ''])
    expect(nameCell('Limites laterais e continuidade')).toHaveTextContent(/Atualizado\s*10\/10\/2026/)
  })
})

describe('selection in the table, beyond the contract', () => {
  it('a checked row a filter hides leaves the selection', () => {
    renderAt('/biblioteca/calc')
    fireEvent.click(box('Limites laterais e continuidade'))
    fireEvent.click(box('Derivadas pela definição'))
    expect(bar()).toHaveTextContent('2 selecionados')
    fireEvent.click(option(/^limites\b/))
    expect(bar()).toHaveTextContent('1 selecionado')
  })

  it('a click beside the check marks the row and does not open it', () => {
    renderAt('/biblioteca/calc')
    fireEvent.click(within(rowNamed('Limites laterais e continuidade')).getAllByRole('cell')[0])
    expect(box('Limites laterais e continuidade')).toBeChecked()
    expect(screen.getByRole('heading', { name: 'Cálculo I' })).toBeInTheDocument()
  })

  it('going to another folder clears the selection', () => {
    renderAt('/biblioteca/calc')
    fireEvent.click(box('Limites laterais e continuidade'))
    fireEvent.click(within(tree()).getByRole('treeitem', { name: 'Física II' }))
    expect(screen.queryByRole('toolbar', { name: 'Seleção' })).toBeNull()
  })

  it('dragging an unchecked row takes only it, and the checks stay', async () => {
    renderAt('/biblioteca/calc')
    fireEvent.click(box('Limites laterais e continuidade'))
    drag(rowNamed('Monitoria de limites'), treeFolder('Física II'), () => {
      expect(within(tree()).getByText('Mover 1 item')).toBeInTheDocument()
    })
    await waitFor(() => expect(fileOf('monitoria').folderId).toBe('fis'))
    expect(fileOf('limites').folderId).toBe('calc')
    expect(bar()).toHaveTextContent('1 selecionado')
  })

  it('a folder does not go into itself: no highlight, nothing moves', () => {
    renderAt('/biblioteca/calc')
    fireEvent.click(box('Integrais'))
    drag(rowNamed('Integrais'), rowNamed('Integrais'), () => {
      expect(rowNamed('Integrais')).not.toHaveClass('drop-on')
      expect(useUiStore.getState().drag?.over).toBeUndefined()
    })
    expect(folderOf('integ').parentId).toBe('calc')
  })

  it('dropping where it already is touches nothing', async () => {
    const before = fileOf('limites').updated.at
    renderAt('/biblioteca/calc')
    drag(rowNamed('Limites laterais e continuidade'), treeFolder('Cálculo I'))
    await waitFor(() => expect(useUiStore.getState().drag).toBeNull())
    expect(fileOf('limites').updated.at).toBe(before)
  })

  it('a folder row dragged alone moves, and the highlight goes away after the drop', async () => {
    renderAt('/biblioteca/calc')
    const target = treeFolder('Física II').closest<HTMLElement>('.tree-row')!
    drag(rowNamed('Exercícios'), treeFolder('Física II'), () => {
      expect(target).toHaveClass('drop-on')
    })
    await waitFor(() => expect(folderOf('exer').parentId).toBe('fis'))
    expect(target).not.toHaveClass('drop-on')
  })

  it('on touch the rows do not drag', () => {
    screenLike(/pointer:\s*coarse|hover:\s*none/)
    renderAt('/biblioteca/calc')
    expect(rowNamed('Limites laterais e continuidade')).not.toHaveAttribute('draggable', 'true')
    expect(rowNamed('Integrais')).not.toHaveAttribute('draggable', 'true')
  })

  it('"Apagar" sends a checked folder to the Lixeira too', async () => {
    renderAt('/biblioteca/calc')
    fireEvent.click(box('Integrais'))
    fireEvent.click(box('Limites laterais e continuidade'))
    fireEvent.click(within(bar()).getByRole('button', { name: 'Apagar' }))
    await waitFor(() => expect(folderOf('integ').deletedAt).not.toBeNull())
    expect(fileOf('limites').deletedAt).not.toBeNull()
  })

  it('"Prova da seleção" takes what is inside a checked folder', () => {
    renderAt('/biblioteca/calc')
    fireEvent.click(box('Integrais'))
    fireEvent.click(box('Derivadas pela definição'))
    fireEvent.click(within(bar()).getByRole('button', { name: /Prova da seleção/ }))
    const overlay = useUiStore.getState().overlay
    expect(overlay).toEqual({ kind: 'folder-exam', folderId: null, fileIds: ['derivadas', 'stewart'] })
  })

  it('"Favoritar" marks the checked folders too', async () => {
    renderAt('/biblioteca/calc')
    fireEvent.click(box('Integrais'))
    fireEvent.click(within(bar()).getByRole('button', { name: /Favoritar/ }))
    await waitFor(() => expect(folderOf('integ').favorite).toBe(true))
  })
})
