// História 9 (spec 003, FR-052 a FR-055, opção A): "Locais", em Configurações › Armazenamento (antes a janela "Onde fica cada coisa").
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import 'fake-indexeddb/auto'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

import type { FolderMeta } from '@/types/domain'
import { PlacesPanel } from '@/components/dialogs/PlacesPanel'
import { SettingsDialog } from '@/components/dialogs/SettingsDialog'
import { CombinedRepository } from '@/lib/storage/combined-repository'
import { type Account, LOCAL_ACCOUNT, useAccountStore } from '@/stores/account'
import { useLibraryStore } from '@/stores/library'
import { usePlacesStore } from '@/stores/places'
import { useUiStore } from '@/stores/ui'
import { FakeDrive, installMemoryStorage, uniqueAccount } from '@/test/storage/fake-drive'

const token = vi.fn(async () => 'tok')
const library = () => useLibraryStore.getState()

let account: string
let trabalho: FolderMeta
let aurora: FolderMeta

function google(id: string): Account {
  return { id, kind: 'google', name: 'Ana', email: 'ana@example.com', picture: '', token: { accessToken: 'at-1', expiresAt: Date.now() + 3600_000 } }
}

async function seed() {
  await library().connect(account, token)
  trabalho = await library().createFolder({ name: 'Trabalho' })
  aurora = await library().createFolder({ name: 'Projeto Aurora — Reuniões semanais com o fornecedor', parentId: trabalho.id, place: 'local' })
  await library().createFile({ name: 'Reunião de kickoff', type: 'class', folderId: aurora.id }, 'fala')
  await library().createFile({ name: 'Ata do kickoff', type: 'meeting', folderId: aurora.id }, 'ata')
  const faculdade = await library().createFolder({ name: 'Faculdade' })
  await library().createFile({ name: 'Lista de exercícios 3', type: 'class', folderId: faculdade.id }, 'lista')
}

const open = () => render(<MemoryRouter><PlacesPanel /></MemoryRouter>)
const tree = () => screen.getByRole('tree', { name: 'Biblioteca inteira' })
const row = (name: string | RegExp) => within(tree()).getByRole('treeitem', { name })
const placeOf = (name: string | RegExp) => within(row(name)).getByRole('combobox') as HTMLSelectElement

beforeEach(async () => {
  installMemoryStorage()
  new FakeDrive().install()
  account = uniqueAccount()
  useUiStore.setState({ overlay: null, toasts: [] })
  usePlacesStore.setState({ running: false, progress: null, failed: [] })
  useAccountStore.setState({ accounts: [LOCAL_ACCOUNT, google(account)], activeId: account, reconnectId: null })
})

afterEach(() => {
  vi.unstubAllGlobals()
  useAccountStore.setState({ activeId: LOCAL_ACCOUNT.id })
})

describe('onde fica', () => {
  it('em Configurações › Armazenamento, na seção "Locais"', async () => {
    await seed()
    render(<MemoryRouter><SettingsDialog initial="storage" /></MemoryRouter>)
    const locais = screen.getByRole('region', { name: 'Locais' })
    expect(within(locais).getByRole('tree', { name: 'Biblioteca inteira' })).toBeInTheDocument()
  })

  it('aberta pelo "Onde fica…" de um item, já vem com as pastas dele abertas', async () => {
    await seed()
    const kickoff = library().files.find(file => file.name === 'Reunião de kickoff')!
    render(<MemoryRouter><SettingsDialog initial="storage" focusId={kickoff.id} /></MemoryRouter>)
    expect(row('Reunião de kickoff')).toBeInTheDocument()
  })
})

describe('a hierarquia inteira, com o lugar de cada item', () => {
  it('mostra pastas, subpastas e notas; sem escolha própria, "Segue" a pasta de cima', async () => {
    await seed()
    open()
    expect(row('Trabalho')).toBeInTheDocument()
    expect(row(/Projeto Aurora/)).toBeInTheDocument()
    // the first level opens by itself; a deeper folder opens on its arrow
    expect(within(tree()).queryByRole('treeitem', { name: 'Reunião de kickoff' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /^Abrir Projeto Aurora/ }))
    expect(row('Reunião de kickoff')).toBeInTheDocument()
    expect(row('Lista de exercícios 3')).toBeInTheDocument()
    expect(placeOf('Trabalho').selectedOptions[0].textContent).toBe('Segue: Google Drive')
    expect(placeOf(/Projeto Aurora/).value).toBe('local')
    expect(placeOf('Reunião de kickoff').selectedOptions[0].textContent).toBe('Segue: Local')
  })

  it('a pasta com itens em lugares diferentes fica marcada', async () => {
    await seed()
    open()
    expect(within(row('Trabalho')).getByText('2 lugares')).toBeInTheDocument()
    expect(within(row('Faculdade')).queryByText('2 lugares')).not.toBeInTheDocument()
  })

  it('App aparece desligado, com o caminho para liberar', async () => {
    await seed()
    open()
    const app = within(placeOf('Faculdade')).getByRole('option', { name: 'App · liberar com um código' }) as HTMLOptionElement
    expect(app.disabled).toBe(true)
  })

  it('o rodapé diz quantas notas, e quantas estão no Drive e só neste navegador', async () => {
    await seed()
    open()
    expect(screen.getByText(/3 notas · .*\. 1 no Google Drive, 2 só neste navegador/)).toBeInTheDocument()
  })

  it('a busca acha a nota e mostra as pastas dela', async () => {
    await seed()
    open()
    fireEvent.change(screen.getByRole('searchbox', { name: 'Buscar pasta ou nota' }), { target: { value: 'ata do' } })
    expect(row('Ata do kickoff')).toBeInTheDocument()
    expect(row(/Projeto Aurora/)).toBeInTheDocument()
    expect(within(tree()).queryByRole('treeitem', { name: 'Faculdade' })).not.toBeInTheDocument()
  })
})

describe('mudar o lugar', () => {
  it('pergunta antes, com quantas notas e quanto espaço, e o aviso de Local; "Cancelar" não muda nada', async () => {
    await seed()
    open()
    fireEvent.change(placeOf('Faculdade'), { target: { value: 'local' } })
    const ask = screen.getByRole('alertdialog', { name: 'Levar Faculdade para Local' })
    expect(ask).toHaveTextContent('Vão 1 nota e')
    expect(ask).toHaveTextContent('limpar os dados do navegador apaga')
    fireEvent.click(within(ask).getByRole('button', { name: 'Cancelar' }))
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
    expect(library().folders.find(folder => folder.name === 'Faculdade')?.place).toBeUndefined()
  })

  it('escolhendo App, a pergunta fala do App (e não do Google Drive)', async () => {
    await seed()
    useLibraryStore.setState({ appOn: true } as never)
    open()
    fireEvent.change(placeOf('Faculdade'), { target: { value: 'app' } })
    const ask = screen.getByRole('alertdialog', { name: 'Levar Faculdade para o App' })
    expect(ask).toHaveTextContent('sua conta do Estudo')
    expect(ask).not.toHaveTextContent('Google Drive')
    expect(within(ask).getByRole('button', { name: 'Levar para o App' })).toBeInTheDocument()
  })

  it('"Levar para Local" leva a pasta e a nota dela de verdade: depois, a nota está só neste navegador', async () => {
    await seed()
    open()
    fireEvent.change(placeOf('Faculdade'), { target: { value: 'local' } })
    fireEvent.click(screen.getByRole('button', { name: 'Levar para Local' }))
    const lista = () => library().files.find(file => file.name === 'Lista de exercícios 3')!
    await waitFor(() => expect((library().repo as CombinedRepository).sideOf(lista().id)).toBe('local'))
    await waitFor(() => expect(placeOf('Faculdade').value).toBe('local'))
    expect(await library().openFile(lista().id).then(opened => opened.content)).toBe('lista')
  })

  it('voltar a "Segue" leva de volta para o lugar da pasta de cima', async () => {
    await seed()
    open()
    fireEvent.change(placeOf(/Projeto Aurora/), { target: { value: 'segue' } })
    expect(screen.getByRole('alertdialog')).toHaveTextContent('para o Google Drive')
    fireEvent.click(screen.getByRole('button', { name: 'Levar para o Google Drive' }))
    const kickoff = () => library().files.find(file => file.name === 'Reunião de kickoff')!
    await waitFor(() => expect((library().repo as CombinedRepository).sideOf(kickoff().id)).toBe('drive'))
    expect(library().folders.find(folder => folder.id === aurora.id)?.place).toBeUndefined()
  })
})

describe('sem login', () => {
  it('tudo fica em Local; escolher o Google Drive pede para entrar primeiro', async () => {
    useAccountStore.setState({ activeId: LOCAL_ACCOUNT.id })
    await library().connect('local')
    const folder = await library().createFolder({ name: `Rascunhos ${account}` })
    open()
    expect(screen.getByText(/Sem login, tudo fica em Local/)).toBeInTheDocument()
    expect(placeOf(folder.name).selectedOptions[0].textContent).toBe('Segue: Local')
    fireEvent.change(placeOf(folder.name), { target: { value: 'drive' } })
    const ask = screen.getByRole('alertdialog', { name: 'Entrar para usar o Google Drive' })
    fireEvent.click(within(ask).getByRole('button', { name: 'Entrar com o Google' }))
    expect(useUiStore.getState().overlay).toEqual({ kind: 'account' })
  })
})

describe('mudar o lugar em lote', () => {
  const bar = () => screen.getByRole('toolbar', { name: 'Marcados' })
  const mark = (name: string | RegExp) => fireEvent.click(within(row(name)).getByRole('checkbox'))

  it('marca várias, diz quantas, e leva todas de uma vez com uma pergunta só (somando o lote)', async () => {
    await seed()
    useLibraryStore.setState({ appOn: false } as never)
    open()
    expect(screen.queryByRole('toolbar', { name: 'Marcados' })).not.toBeInTheDocument()
    mark('Faculdade')
    mark('Trabalho')
    expect(bar()).toHaveTextContent('2 marcados')
    fireEvent.click(within(bar()).getByRole('button', { name: 'Levar para Local' }))
    const ask = screen.getByRole('alertdialog', { name: 'Levar 2 itens para Local' })
    // Trabalho já tem a subpasta em Local: do lote, só a nota de Faculdade muda de lugar
    expect(ask).toHaveTextContent('Vão 1 nota e')
    expect(ask).toHaveTextContent('limpar os dados do navegador apaga')
    fireEvent.click(within(ask).getByRole('button', { name: 'Levar para Local' }))
    const lista = () => library().files.find(file => file.name === 'Lista de exercícios 3')!
    await waitFor(() => expect((library().repo as CombinedRepository).sideOf(lista().id)).toBe('local'))
    await waitFor(() => expect(placeOf('Trabalho').value).toBe('local'))
    expect(placeOf('Faculdade').value).toBe('local')
    // depois de levar, nada fica marcado
    expect(screen.queryByRole('toolbar', { name: 'Marcados' })).not.toBeInTheDocument()
  })

  it('"Marcar tudo" marca o que está na lista, inclusive com busca; "Limpar" desmarca', async () => {
    await seed()
    useLibraryStore.setState({ appOn: false } as never)
    open()
    fireEvent.change(screen.getByRole('searchbox', { name: 'Buscar pasta ou nota' }), { target: { value: 'kickoff' } })
    fireEvent.click(screen.getByRole('checkbox', { name: 'Marcar tudo' }))
    const visible = within(tree()).getAllByRole('treeitem').length
    expect(bar()).toHaveTextContent(`${visible} marcados`)
    fireEvent.click(within(bar()).getByRole('button', { name: 'Limpar' }))
    expect(screen.queryByRole('toolbar', { name: 'Marcados' })).not.toBeInTheDocument()
    expect(screen.getByRole('checkbox', { name: 'Marcar tudo' })).not.toBeChecked()
  })

  it('App só fica disponível com a estrutura do app ligada, como no seletor de cada linha', async () => {
    await seed()
    useLibraryStore.setState({ appOn: false } as never)
    open()
    mark('Faculdade')
    expect(within(bar()).getByRole('button', { name: /Levar para o App/ })).toBeDisabled()
    useLibraryStore.setState({ appOn: true } as never)
    await waitFor(() => expect(within(bar()).getByRole('button', { name: 'Levar para o App' })).toBeEnabled())
    fireEvent.click(within(bar()).getByRole('button', { name: 'Levar para o App' }))
    expect(screen.getByRole('alertdialog', { name: 'Levar Faculdade para o App' })).toHaveTextContent('sua conta do Estudo')
    useLibraryStore.setState({ appOn: false } as never)
  })
})

describe('mudar o lugar em lote · revisão de design', () => {
  it('com a pergunta aberta, a barra espera: um lugar para responder por vez', async () => {
    await seed()
    useLibraryStore.setState({ appOn: false } as never)
    open()
    fireEvent.click(within(row('Faculdade')).getByRole('checkbox'))
    const bar = screen.getByRole('toolbar', { name: 'Marcados' })
    fireEvent.click(within(bar).getByRole('button', { name: 'Levar para Local' }))
    expect(screen.getByRole('alertdialog')).toBeInTheDocument()
    expect(within(bar).getByRole('button', { name: 'Levar para Local' })).toBeDisabled()
    expect(within(bar).getByRole('button', { name: 'Levar para o Google Drive' })).toBeDisabled()
    fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Cancelar' }))
    expect(within(bar).getByRole('button', { name: 'Levar para Local' })).toBeEnabled()
  })
})

describe('mudar o lugar em lote · acessibilidade', () => {
  it('setas andam pela barra, a contagem é anunciada e "Limpar" devolve o foco a "Marcar tudo"', async () => {
    await seed()
    useLibraryStore.setState({ appOn: false } as never)
    open()
    fireEvent.click(within(row('Faculdade')).getByRole('checkbox'))
    const bar = screen.getByRole('toolbar', { name: 'Marcados' })
    expect(within(bar).getByText('1 marcado')).toHaveAttribute('aria-live', 'polite')
    const drive = within(bar).getByRole('button', { name: 'Levar para o Google Drive' })
    drive.focus()
    fireEvent.keyDown(drive, { key: 'ArrowRight' })
    expect(within(bar).getByRole('button', { name: 'Levar para Local' })).toHaveFocus()
    // o App desabilitado é pulado; End vai para o último que dá para usar
    fireEvent.keyDown(document.activeElement!, { key: 'End' })
    expect(within(bar).getByRole('button', { name: 'Limpar' })).toHaveFocus()
    fireEvent.keyDown(document.activeElement!, { key: 'Home' })
    expect(drive).toHaveFocus()
    fireEvent.click(within(bar).getByRole('button', { name: 'Limpar' }))
    expect(screen.getByRole('checkbox', { name: 'Marcar tudo' })).toHaveFocus()
  })
})
