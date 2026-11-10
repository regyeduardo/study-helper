import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, screen, waitFor, within } from '@testing-library/react'

import type { FileMeta, FileSidecar, FolderMeta, SourceMeta } from '@/types/domain'
import { defaultIndex, newFileMeta, newFolderMeta } from '@/lib/defaults'
import type { Repository } from '@/lib/storage/repository'
import { useLibraryStore } from '@/stores/library'
import { useUiStore } from '@/stores/ui'
import { renderAt } from '@/test/library/explorer-fixture'

/* ---------- the library ---------- */

const TZ = 'America/Sao_Paulo'
const stamp = (at: string) => ({ at, deviceId: 'local', deviceName: 'Este computador' })

const folder = (id: string, name: string, parentId: string | null = null): FolderMeta => newFolderMeta({ id, name, parentId })
const note = (id: string, name: string, folderId: string | null, fields: Partial<FileMeta> = {}): FileMeta => newFileMeta({ id, name, folderId, type: 'reading', ...fields })

function seed(folders: FolderMeta[], files: FileMeta[]) {
  const repo = {
    kind: 'local',
    accountId: 'local',
    readContent: async () => '',
    readSidecar: async (id: string) => ({ meta: useLibraryStore.getState().files.find(file => file.id === id)!, highlights: [], questions: [], attempts: [] }) as unknown as FileSidecar,
    saveFile: async (saved: FileSidecar) => saved,
    saveFolder: async () => undefined,
    saveIndex: async () => undefined,
    fileSizes: async () => ({}),
  } as unknown as Repository
  const index = defaultIndex()
  useLibraryStore.setState({ repo, accountId: 'local', ready: true, folders, files, index: { ...index, settings: { ...index.settings, timezone: TZ } }, opened: {}, openedAt: {}, localMedia: [], sharedView: null, sizes: {} })
  useUiStore.getState().clearFilters()
  useUiStore.setState({ overlay: null, menu: null, selection: new Set() })
}

const LIMITES = 'Limites laterais e continuidade'
const DERIVADAS = 'Derivadas pela definição'
const MONITORIA = 'Monitoria de limites'
const CADEIA = 'Regra da cadeia'
const INTEGRAIS = 'Integrais'

function seedCalculo() {
  seed(
    [folder('calc', 'Cálculo I'), folder('integ', INTEGRAIS, 'calc'), folder('fis', 'Física II')],
    [note('limites', LIMITES, 'calc'), note('derivadas', DERIVADAS, 'calc'), note('monitoria', MONITORIA, 'calc'), note('cadeia', CADEIA, 'calc'), note('ondas', 'Ondas', 'fis')],
  )
}

/* ---------- reading the screen ---------- */

const table = () => screen.getByRole('table', { name: 'Notas e pastas' })
const bodyRows = () =>
  within(table())
    .getAllByRole('row')
    .filter(row => !within(row).queryAllByRole('columnheader').length)

function rowOf(name: string): HTMLElement {
  const row = bodyRows().find(item => item.textContent?.includes(name))
  if (!row) throw new Error(`nenhuma linha com "${name}"`)
  return row
}

/** The names, in the order of the rows, of what is on the table among `known`. */
const shown = (known: string[]) => bodyRows().flatMap(row => known.filter(name => row.textContent?.includes(name)))

const box = (name: string) => within(table()).getByRole('checkbox', { name: `Marcar ${name}` })
const allBox = () => within(table()).getByRole('checkbox', { name: 'Marcar todos' })
const mark = (...names: string[]) => names.forEach(name => fireEvent.click(box(name)))
const bar = () => screen.getByRole('toolbar', { name: 'Seleção' })
const noBar = () => screen.queryByRole('toolbar', { name: 'Seleção' })

const fileOf = (id: string) => useLibraryStore.getState().files.find(file => file.id === id)!
const folderOf = (...ids: string[]) => ids.map(id => fileOf(id).folderId)

function moveWindow() {
  const overlay = useUiStore.getState().overlay
  if (overlay?.kind !== 'move') throw new Error(`esperava a janela de mover, veio ${overlay?.kind ?? 'nada'}`)
  return { files: [...overlay.fileIds].sort(), folders: [...overlay.folderIds].sort() }
}

/* ---------- dragging ---------- */

/** jsdom has no DataTransfer; one object goes through the whole gesture, as in the browser. */
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

/** The row itself, or the grip inside it. */
function dragSource(row: HTMLElement): HTMLElement {
  const source = row.getAttribute('draggable') === 'true' ? row : row.querySelector<HTMLElement>('[draggable="true"]')
  if (!source) throw new Error('a linha marcada não pode ser arrastada')
  return source
}

function drag(row: HTMLElement, target: HTMLElement, whileOver?: () => void) {
  const source = dragSource(row)
  const transfer = dataTransfer()
  fireEvent.dragStart(source, { dataTransfer: transfer })
  fireEvent.dragEnter(target, { dataTransfer: transfer })
  fireEvent.dragOver(target, { dataTransfer: transfer })
  whileOver?.()
  fireEvent.drop(target, { dataTransfer: transfer })
  fireEvent.dragEnd(source, { dataTransfer: transfer })
}

const tree = () => screen.getByRole('tree', { name: 'Pastas' })
const treeFolder = (name: string) => within(within(tree()).getByRole('treeitem', { name })).getByText(name)

/* ---------- touch ---------- */

function touchScreen() {
  vi.spyOn(window, 'matchMedia').mockImplementation(
    query =>
      ({
        matches: /pointer:\s*coarse|hover:\s*none/.test(query),
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

afterEach(() => {
  vi.restoreAllMocks()
})

describe('marcar vários na tabela (FR-036)', () => {
  beforeEach(seedCalculo)

  it('toda linha, de pasta ou de nota, tem a sua caixa, e sem nada marcado não há barra', () => {
    renderAt('/biblioteca/calc')
    expect(bodyRows()).toHaveLength(5)
    for (const row of bodyRows()) expect(within(row).getAllByRole('checkbox')).toHaveLength(1)
    for (const name of [INTEGRAIS, LIMITES, DERIVADAS, MONITORIA, CADEIA]) expect(box(name)).not.toBeChecked()
    expect(noBar()).toBeNull()
  })

  it('marcar várias mostra a barra com a contagem e as ações, sem abrir a nota', () => {
    renderAt('/biblioteca/calc')
    mark(LIMITES, DERIVADAS)
    expect(box(LIMITES)).toBeChecked()
    expect(box(DERIVADAS)).toBeChecked()
    expect(box(MONITORIA)).not.toBeChecked()
    expect(screen.getByRole('heading', { name: 'Cálculo I' })).toBeInTheDocument()
    expect(bar()).toHaveTextContent('2 selecionados')
    expect(within(bar()).getByRole('button', { name: 'Mover para…' })).toBeInTheDocument()
    expect(within(bar()).getByRole('button', { name: 'Apagar' })).toBeInTheDocument()
    expect(within(bar()).getByRole('button', { name: /Limpar seleção/ })).toBeInTheDocument()
  })

  it('desmarcar atualiza a contagem, e "Limpar seleção" desmarca tudo', () => {
    renderAt('/biblioteca/calc')
    mark(LIMITES, DERIVADAS)
    mark(DERIVADAS)
    expect(box(DERIVADAS)).not.toBeChecked()
    expect(bar()).toHaveTextContent('1 selecionado')
    expect(bar()).not.toHaveTextContent('1 selecionados')
    fireEvent.click(within(bar()).getByRole('button', { name: /Limpar seleção/ }))
    expect(box(LIMITES)).not.toBeChecked()
    expect(noBar()).toBeNull()
  })

  it('a caixa do cabeçalho fica parcial com parte marcada, marca a tabela inteira e depois desmarca', () => {
    renderAt('/biblioteca/calc')
    expect(allBox()).not.toBeChecked()
    mark(LIMITES)
    expect(allBox()).toBePartiallyChecked()
    fireEvent.click(allBox())
    expect(allBox()).toBeChecked()
    for (const name of [INTEGRAIS, LIMITES, DERIVADAS, MONITORIA, CADEIA]) expect(box(name)).toBeChecked()
    expect(bar()).toHaveTextContent('5 selecionados')
    fireEvent.click(allBox())
    expect(allBox()).not.toBeChecked()
    expect(noBar()).toBeNull()
  })

  it('"Apagar" na barra manda todas as marcadas para a Lixeira, e só elas', async () => {
    renderAt('/biblioteca/calc')
    mark(LIMITES, DERIVADAS)
    fireEvent.click(within(bar()).getByRole('button', { name: 'Apagar' }))
    await waitFor(() => expect(shown([LIMITES, DERIVADAS, MONITORIA, CADEIA]).sort()).toEqual([MONITORIA, CADEIA].sort()))
    expect(fileOf('limites').deletedAt).not.toBeNull()
    expect(fileOf('derivadas').deletedAt).not.toBeNull()
    expect(fileOf('monitoria').deletedAt).toBeNull()
    expect(noBar()).toBeNull()
  })

  it('"Mover para…" leva as notas e as pastas marcadas', () => {
    renderAt('/biblioteca/calc')
    mark(INTEGRAIS, MONITORIA)
    expect(bar()).toHaveTextContent('2 selecionados')
    fireEvent.click(within(bar()).getByRole('button', { name: 'Mover para…' }))
    expect(moveWindow()).toEqual({ files: ['monitoria'], folders: ['integ'] })
  })
})

describe('arrastar os marcados para uma pasta (FR-037, SC-008)', () => {
  beforeEach(seedCalculo)

  it('soltar numa pasta da lateral move todas as marcadas e só elas, e a pasta diz quantos itens vão', async () => {
    renderAt('/biblioteca/calc')
    mark(LIMITES, DERIVADAS, MONITORIA)
    drag(rowOf(LIMITES), treeFolder('Física II'), () => {
      expect(within(tree()).getByText('Mover 3 itens')).toBeInTheDocument()
    })
    await waitFor(() => expect(folderOf('limites', 'derivadas', 'monitoria')).toEqual(['fis', 'fis', 'fis']))
    expect(folderOf('cadeia')).toEqual(['calc'])
    await waitFor(() => expect(shown([LIMITES, DERIVADAS, MONITORIA, CADEIA])).toEqual([CADEIA]))
    expect(within(tree()).queryByText('Mover 3 itens')).toBeNull()
    expect(noBar()).toBeNull()
  })

  it('soltar numa linha de pasta da tabela também move todas as marcadas', async () => {
    renderAt('/biblioteca/calc')
    mark(LIMITES, DERIVADAS)
    drag(rowOf(DERIVADAS), within(rowOf(INTEGRAIS)).getByText(INTEGRAIS))
    await waitFor(() => expect(folderOf('limites', 'derivadas')).toEqual(['integ', 'integ']))
    expect(folderOf('monitoria', 'cadeia')).toEqual(['calc', 'calc'])
  })

  it('uma pasta marcada vai junto com as notas', async () => {
    renderAt('/biblioteca/calc')
    mark(INTEGRAIS, MONITORIA)
    drag(rowOf(MONITORIA), treeFolder('Física II'))
    await waitFor(() => expect(folderOf('monitoria')).toEqual(['fis']))
    await waitFor(() => expect(useLibraryStore.getState().folders.find(item => item.id === 'integ')?.parentId).toBe('fis'))
  })
})

describe('em tela de toque (FR-037)', () => {
  beforeEach(() => {
    touchScreen()
    seedCalculo()
  })

  it('a caixa está sempre à vista e mover é por "Mover para…"', () => {
    renderAt('/biblioteca/calc')
    for (const row of bodyRows()) expect(within(row).getByRole('checkbox')).toBeVisible()
    mark(LIMITES, DERIVADAS)
    fireEvent.click(within(bar()).getByRole('button', { name: 'Mover para…' }))
    expect(moveWindow()).toEqual({ files: ['derivadas', 'limites'], folders: [] })
  })
})

describe('as datas e a ordem por coluna (FR-040)', () => {
  const ALGEBRA = 'Álgebra linear'
  const BIO = 'Bioestatística'
  const VETORIAL = 'Cálculo vetorial'
  const NAMES = [ALGEBRA, BIO, VETORIAL]

  beforeEach(() => {
    // the order by name, by Criado and by Atualizado are all different
    seed(
      [folder('fis', 'Física II')],
      [
        note('algebra', ALGEBRA, 'fis', { created: stamp('2026-09-01T15:00:00Z'), updated: stamp('2026-10-20T16:30:00Z') }),
        note('bio', BIO, 'fis', { created: stamp('2026-10-05T15:00:00Z'), updated: stamp('2026-10-06T15:00:00Z') }),
        note('vetorial', VETORIAL, 'fis', { created: stamp('2026-09-15T15:00:00Z'), updated: stamp('2026-10-30T15:00:00Z') }),
      ],
    )
  })

  const header = (label: string) => within(table()).getByRole('columnheader', { name: new RegExp(`^${label}`) })
  const sortOf = (label: string) => header(label).getAttribute('aria-sort') ?? 'none'
  const sortBy = (label: string) => fireEvent.click(within(header(label)).getByRole('button', { name: new RegExp(`^${label}`) }))
  const cellUnder = (label: string, row: HTMLElement) => row.children[[...header(label).closest('tr')!.children].indexOf(header(label))] as HTMLElement

  it('"Criado" e "Atualizado" mostram a data e, em outra linha, a hora, no fuso da pessoa', () => {
    renderAt('/biblioteca/fis')
    const created = cellUnder('Criado', rowOf(ALGEBRA))
    expect(within(created).getByText('01/09/2026')).toBeInTheDocument()
    expect(within(created).getByText('12:00')).toBeInTheDocument()
    const updated = cellUnder('Atualizado', rowOf(ALGEBRA))
    expect(within(updated).getByText('20/10/2026')).toBeInTheDocument()
    expect(within(updated).getByText('13:30')).toBeInTheDocument()
  })

  it('o clique ordena da mais nova para a mais antiga, o segundo inverte, e só a coluna em uso indica a ordem', () => {
    renderAt('/biblioteca/fis')
    sortBy('Criado')
    expect(sortOf('Criado')).toBe('descending')
    expect(shown(NAMES)).toEqual([BIO, VETORIAL, ALGEBRA])
    sortBy('Criado')
    expect(sortOf('Criado')).toBe('ascending')
    expect(shown(NAMES)).toEqual([ALGEBRA, VETORIAL, BIO])
    sortBy('Atualizado')
    expect(sortOf('Atualizado')).toBe('descending')
    expect(sortOf('Criado')).toBe('none')
    expect(shown(NAMES)).toEqual([VETORIAL, ALGEBRA, BIO])
    sortBy('Atualizado')
    expect(sortOf('Atualizado')).toBe('ascending')
    expect(shown(NAMES)).toEqual([BIO, ALGEBRA, VETORIAL])
  })
})

describe('os filtros ativos acima da tabela (FR-044, FR-045)', () => {
  const NOTA_DERIVADAS = 'Derivadas pela definição'
  const NOTA_LIMITES = 'Limites laterais'
  const NOTA_CADEIA = 'Regra da cadeia'
  const AULA = 'Aula gravada de derivadas'
  const STEWART = 'Stewart, capítulo 2'
  const NAMES = [NOTA_DERIVADAS, NOTA_LIMITES, NOTA_CADEIA, AULA, STEWART]
  const inOrder = (names: string[]) => [...names].sort()
  const onTable = () => inOrder(shown(NAMES))

  const video: SourceMeta = { input: 'file', name: 'aula.mp4', mime: 'video/mp4', storage: 'none' }
  const pdf: SourceMeta = { input: 'file', name: 'stewart.pdf', mime: 'application/pdf', storage: 'none' }

  beforeEach(() => {
    // no folders: the 5 of the root are the whole library, so "N de 5" can only mean one thing
    seed(
      [],
      [
        note('derivadas', NOTA_DERIVADAS, null, { tags: ['derivadas'] }),
        note('limites', NOTA_LIMITES, null, { tags: ['limites'] }),
        note('cadeia', NOTA_CADEIA, null, { tags: ['derivadas'] }),
        note('aula', AULA, null, { role: 'entrada', kept: 'registro', origin: video, tags: ['derivadas'] }),
        note('stewart', STEWART, null, { role: 'entrada', kept: 'registro', origin: pdf }),
      ],
    )
  })

  const active = () => screen.getByRole('group', { name: 'Filtros ativos' })
  const noActive = () => screen.queryByRole('group', { name: 'Filtros ativos' })
  const option = (name: RegExp) => screen.getByRole('checkbox', { name })
  const NOTA = /^Nota\b/
  const TAG = /^derivadas\b/

  it('cada filtro vira uma etiqueta removível, com "N de M" e "Limpar tudo"', () => {
    renderAt('/biblioteca')
    expect(noActive()).toBeNull()
    expect(screen.queryByRole('button', { name: 'Limpar tudo' })).toBeNull()

    fireEvent.click(option(NOTA))
    expect(active()).toHaveTextContent(/Tipo\s*nota/)
    expect(screen.getByText('3 de 5')).toBeInTheDocument()
    expect(onTable()).toEqual(inOrder([NOTA_DERIVADAS, NOTA_LIMITES, NOTA_CADEIA]))

    fireEvent.click(option(TAG))
    expect(active()).toHaveTextContent(/Tipo\s*nota/)
    expect(active()).toHaveTextContent(/Etiqueta\s*derivadas/)
    expect(screen.getByText('2 de 5')).toBeInTheDocument()
    expect(onTable()).toEqual(inOrder([NOTA_DERIVADAS, NOTA_CADEIA]))

    fireEvent.click(within(active()).getByRole('button', { name: /Tipo/ }))
    expect(active()).not.toHaveTextContent(/Tipo\s*nota/)
    expect(active()).toHaveTextContent(/Etiqueta\s*derivadas/)
    expect(option(NOTA)).not.toBeChecked()
    expect(option(TAG)).toBeChecked()
    expect(screen.getByText('3 de 5')).toBeInTheDocument()
    expect(onTable()).toEqual(inOrder([NOTA_DERIVADAS, NOTA_CADEIA, AULA]))

    fireEvent.click(option(NOTA))
    expect(screen.getByText('2 de 5')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Limpar tudo' }))
    expect(noActive()).toBeNull()
    expect(screen.queryByRole('button', { name: 'Limpar tudo' })).toBeNull()
    expect(option(NOTA)).not.toBeChecked()
    expect(option(TAG)).not.toBeChecked()
    expect(onTable()).toEqual(inOrder(NAMES))
  })
})
