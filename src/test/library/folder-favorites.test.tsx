import { beforeEach, describe, expect, it, type Mock, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'

import { FolderTiles } from '@/components/library/FolderTiles'
import { ItemMenu } from '@/components/library/ItemMenu'
import { useViewRoute } from '@/hooks/use-view-route'
import { defaultIndex } from '@/lib/defaults'
import type { Repository } from '@/lib/storage/repository'
import { ReaderWorkspace } from '@/pages/workspace/container/reader'
import { useLibraryStore } from '@/stores/library'
import { useUiStore } from '@/stores/ui'
import type { FolderColor, FolderMeta } from '@/types/domain'

// US4 scenarios 3 and 4 · FR-038, FR-039 · contracts/ui.md "Explorador":
// "Lateral com Favoritos. Menu da pasta com favoritar e as 7 cores, que têm nome acessível, e não só a cor".

/** The name of each color in the folder menu, and the name its icon says (as FolderIcon does). */
const COLORS: [FolderColor, string, string][] = [
  ['vermelho', 'Vermelho', 'Pasta vermelha'],
  ['laranja', 'Laranja', 'Pasta laranja'],
  ['amarelo', 'Amarelo', 'Pasta amarela'],
  ['verde', 'Verde', 'Pasta verde'],
  ['azul', 'Azul', 'Pasta azul'],
  ['roxo', 'Roxo', 'Pasta roxa'],
  ['cinza', 'Cinza', 'Pasta cinza'],
]
const NO_COLOR = 'Sem cor'
const CHOICES = [...COLORS.map(([, label]) => label), NO_COLOR]

const stamp = { at: '2026-10-10T10:00:00Z', deviceId: 'local', deviceName: 'Este computador' }

function folder(id: string, name: string, parentId: string | null, position: number): FolderMeta {
  return { id, name, parentId, position, description: '', isCourse: false, courseOrigin: null, courseDescription: null, courseMaterial: null, created: stamp, updated: stamp, deletedAt: null }
}

const NAMES: Record<string, string> = { calc: 'Cálculo I', integ: 'Integrais', fis: 'Física II' }

// The real updateFolder, wrapped so the test sees the call and the screen sees the change.
const realUpdateFolder = useLibraryStore.getState().updateFolder
let updateFolder: Mock<typeof realUpdateFolder>

function seed(extra: Record<string, Partial<FolderMeta>> = {}) {
  const folders = [folder('calc', NAMES.calc, null, 0), folder('integ', NAMES.integ, 'calc', 0), folder('fis', NAMES.fis, null, 1)].map(item => ({ ...item, ...extra[item.id] }))
  const repo = {
    kind: 'local',
    accountId: 'local',
    readContent: async () => '',
    saveFile: async (saved: unknown) => saved,
    saveFolder: vi.fn(async (saved: FolderMeta) => saved),
    saveIndex: async () => undefined,
    fileSizes: async () => ({}),
  } as unknown as Repository
  updateFolder = vi.fn(realUpdateFolder)
  useLibraryStore.setState({ repo, accountId: 'local', ready: true, folders, files: [], index: defaultIndex(), opened: {}, openedAt: {}, localMedia: [], sharedView: null, sizes: {}, updateFolder })
  useUiStore.setState({ menu: null, overlay: null, selection: new Set() })
  useUiStore.getState().clearFilters()
}

function Where() {
  return <span data-testid="where">{useLocation().pathname}</span>
}

function Screen() {
  return (
    <>
      <ReaderWorkspace route={useViewRoute()} />
      <ItemMenu />
      <Where />
    </>
  )
}

function renderAt(path: string) {
  render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/biblioteca/:folderId?" element={<Screen />} />
        <Route path="*" element={<Screen />} />
      </Routes>
    </MemoryRouter>,
  )
}

/** Opens the folder's menu, the one the ⋯ of the folder opens. */
function folderMenu(id: string): HTMLElement {
  act(() => useUiStore.getState().openMenu({ kind: 'folder', id, x: 10, y: 10 }))
  return screen.getByRole('menu', { name: `Opções de ${NAMES[id]}` })
}

const side = () => screen.getByRole('complementary', { name: 'Navegação' })
const favorites = () => within(side()).queryByRole('list', { name: 'Favoritos' })
const treeItem = (name: string) => within(within(side()).getByRole('tree', { name: 'Pastas' })).getByRole('treeitem', { name })
const has = (name: string) => (accessible: string) => accessible.includes(name)

function favoritesList(): HTMLElement {
  const list = favorites()
  if (!list) throw new Error('A lateral não tem a lista "Favoritos"')
  return list
}

/** What opens the folder: a link, or a button, whose name has the folder's name. */
const opener = (scope: HTMLElement, name: string): HTMLElement | null => [...within(scope).queryAllByRole('link', { name: has(name) }), ...within(scope).queryAllByRole('button', { name: has(name) })][0] ?? null

/** The folder's item in the "Favoritos" area of the side bar, or null when it is not there. */
function favorite(name: string): HTMLElement | null {
  const list = favorites()
  return list ? (within(list).queryAllByRole('listitem').find(item => opener(item, name)) ?? null) : null
}

/** The folder's row in the main table. */
function tableRow(name: string): HTMLElement {
  const row = within(screen.getByRole('main')).getAllByRole('row').find(item => within(item).queryAllByText(name).length > 0)
  if (!row) throw new Error(`A tabela não tem a linha da pasta "${name}"`)
  return row
}

/** A color of the menu: a button with aria-pressed, or a menuitemradio/radio with aria-checked. */
function colorChoice(menu: HTMLElement, name: string): HTMLElement {
  for (const role of ['button', 'menuitemradio', 'radio'] as const) {
    const found = within(menu).queryByRole(role, { name })
    if (found) return found
  }
  throw new Error(`O menu da pasta não tem a cor "${name}" com esse nome acessível`)
}
const marked = (control: HTMLElement) => control.getAttribute('aria-pressed') === 'true' || control.getAttribute('aria-checked') === 'true'

beforeEach(() => {
  seed()
})

describe('favoritar pasta (FR-038)', () => {
  it('"Favoritar", no menu da pasta, grava o favorito e a pasta aparece em Favoritos na lateral, levando a ela', async () => {
    renderAt('/')
    expect(favorite(NAMES.calc)).toBeNull()

    const menu = folderMenu('calc')
    expect(within(menu).queryByRole('button', { name: 'Tirar dos favoritos' })).toBeNull()
    fireEvent.click(within(menu).getByRole('button', { name: 'Favoritar' }))

    expect(updateFolder).toHaveBeenCalledWith('calc', { favorite: true })
    await waitFor(() => expect(favorite(NAMES.calc)).not.toBeNull())
    expect(within(favoritesList()).getAllByRole('listitem')).toHaveLength(1)

    fireEvent.click(opener(favorite(NAMES.calc)!, NAMES.calc)!)
    expect(screen.getByTestId('where')).toHaveTextContent('/biblioteca/calc')
    expect(treeItem(NAMES.calc)).toHaveAttribute('aria-current', 'page')
  })

  it('pasta já favorita: o menu diz "Tirar dos favoritos", e ela sai da área Favoritos', async () => {
    seed({ calc: { favorite: true }, fis: { favorite: true } })
    renderAt('/')
    expect(favorite(NAMES.calc)).not.toBeNull()
    expect(favorite(NAMES.fis)).not.toBeNull()

    const menu = folderMenu('calc')
    expect(within(menu).queryByRole('button', { name: 'Favoritar' })).toBeNull()
    fireEvent.click(within(menu).getByRole('button', { name: 'Tirar dos favoritos' }))

    expect(updateFolder).toHaveBeenCalledWith('calc', { favorite: false })
    await waitFor(() => expect(favorite(NAMES.calc)).toBeNull())
    expect(favorite(NAMES.fis)).not.toBeNull()
  })

  it('em Favoritos, cada pasta tem a sua cor, até subpasta com a árvore fechada; pasta na lixeira não entra', () => {
    seed({ calc: { favorite: true, color: 'azul' }, integ: { favorite: true, color: 'verde' }, fis: { favorite: true, deletedAt: '2026-10-11T10:00:00Z' } })
    renderAt('/')
    expect(within(favoritesList()).getAllByRole('listitem')).toHaveLength(2)
    expect(within(favorite(NAMES.calc)!).getByRole('img', { name: 'Pasta azul' })).toBeInTheDocument()
    expect(within(favorite(NAMES.integ)!).getByRole('img', { name: 'Pasta verde' })).toBeInTheDocument()
    expect(favorite(NAMES.fis)).toBeNull()
  })
})

describe('cor da pasta (FR-039)', () => {
  it('o menu da pasta tem as 7 cores e "Sem cor", cada uma com o seu nome, e marca a atual', () => {
    seed({ calc: { color: 'verde' } })
    renderAt('/biblioteca')

    const colored = folderMenu('calc')
    for (const name of CHOICES) expect(marked(colorChoice(colored, name)), name).toBe(name === 'Verde')

    const plain = folderMenu('fis')
    for (const name of CHOICES) expect(marked(colorChoice(plain, name)), name).toBe(name === NO_COLOR)
  })

  it.each(COLORS)('escolher %s grava a cor, e o ícone da pasta usa essa cor e diz o nome dela, na lateral e na tabela', async (color, label, spoken) => {
    renderAt('/biblioteca')
    expect(within(treeItem(NAMES.calc)).queryByRole('img')).toBeNull()

    fireEvent.click(colorChoice(folderMenu('calc'), label))

    expect(updateFolder).toHaveBeenCalledWith('calc', { color })
    await waitFor(() => expect(within(treeItem(NAMES.calc)).getByRole('img', { name: spoken })).toBeInTheDocument())
    expect(within(tableRow(NAMES.calc)).getByRole('img', { name: spoken })).toBeInTheDocument()
    expect(within(treeItem(NAMES.fis)).queryByRole('img')).toBeNull()
    expect(within(tableRow(NAMES.fis)).queryByRole('img')).toBeNull()
  })

  it('"Sem cor" volta ao ícone padrão em todos os lugares', async () => {
    seed({ calc: { color: 'roxo', favorite: true } })
    renderAt('/biblioteca')
    expect(within(treeItem(NAMES.calc)).getByRole('img', { name: 'Pasta roxa' })).toBeInTheDocument()

    fireEvent.click(colorChoice(folderMenu('calc'), NO_COLOR))

    expect(updateFolder).toHaveBeenCalledWith('calc', { color: undefined })
    await waitFor(() => expect(within(treeItem(NAMES.calc)).queryByRole('img')).toBeNull())
    expect(within(tableRow(NAMES.calc)).queryByRole('img')).toBeNull()
    expect(within(favorite(NAMES.calc)!).queryByRole('img')).toBeNull()
    expect(useLibraryStore.getState().folders.find(item => item.id === 'calc')?.color).toBeUndefined()
  })

  it('nos blocos de pasta (Colunas, Comandos e Foco), o ícone tem a cor e diz o nome dela', () => {
    const [calc, , fis] = useLibraryStore.getState().folders
    render(
      <MemoryRouter>
        <FolderTiles
          tiles={[
            { folder: { ...calc, color: 'laranja' }, files: 2, subfolders: 1, bytes: 0 },
            { folder: fis, files: 0, subfolders: 0, bytes: 0 },
          ]}
        />
      </MemoryRouter>,
    )
    const icons = screen.getAllByRole('img')
    expect(icons.map(icon => icon.getAttribute('aria-label'))).toEqual(['Pasta laranja'])
    expect(icons[0].closest('[role="button"]')).toHaveTextContent(NAMES.calc)
  })
})
