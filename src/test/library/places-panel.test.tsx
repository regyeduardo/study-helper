// "Locais", em Configurações › Armazenamento: spec 003 (história 9, FR-052 a FR-055) com a opção E da spec 005 (história 3): só a nota tem lugar,
// a pasta marca as notas de dentro e a barra leva as marcadas.
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
  aurora = await library().createFolder({ name: 'Projeto Aurora — Reuniões semanais com o fornecedor', parentId: trabalho.id })
  await library().createFile({ name: 'Reunião de kickoff', type: 'class', folderId: aurora.id, place: 'local' }, 'fala')
  await library().createFile({ name: 'Ata do kickoff', type: 'meeting', folderId: aurora.id, place: 'local' }, 'ata')
  const faculdade = await library().createFolder({ name: 'Faculdade' })
  await library().createFile({ name: 'Lista de exercícios 3', type: 'class', folderId: faculdade.id }, 'lista')
}

const open = () => render(<MemoryRouter><PlacesPanel /></MemoryRouter>)
const tree = () => screen.getByRole('tree', { name: 'Biblioteca inteira' })
const row = (name: string | RegExp) => within(tree()).getByRole('treeitem', { name })
const bar = () => screen.getByRole('toolbar', { name: 'Notas marcadas' })
const mark = (name: string | RegExp) => fireEvent.click(within(row(name)).getByRole('checkbox'))
const sideOf = (name: string) => (library().repo as CombinedRepository).sideOf(library().files.find(file => file.name === name)!.id)

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

describe('a hierarquia inteira, com o lugar de cada nota', () => {
  it('mostra pastas, subpastas e notas; cada nota diz onde fica, a pasta não; nenhum seletor por linha', async () => {
    await seed()
    open()
    expect(row('Trabalho')).toBeInTheDocument()
    expect(row(/Projeto Aurora/)).toBeInTheDocument()
    // the first level opens by itself; a deeper folder opens on its arrow
    expect(within(tree()).queryByRole('treeitem', { name: 'Reunião de kickoff' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /^Abrir Projeto Aurora/ }))
    expect(row('Reunião de kickoff')).toHaveTextContent('Local')
    expect(row('Lista de exercícios 3')).toHaveTextContent('Google Drive')
    expect(row('Trabalho')).not.toHaveTextContent(/Google Drive|Local|App/)
    expect(within(tree()).queryAllByRole('combobox')).toEqual([])
  })

  it('a pasta com notas em lugares diferentes não ganha marca nem lugar', async () => {
    await seed()
    open()
    expect(screen.queryByText('2 lugares')).not.toBeInTheDocument()
    expect(screen.queryByText(/^Segue/)).not.toBeInTheDocument()
  })

  it('App aparece desligado, com o caminho para liberar', async () => {
    await seed()
    open()
    mark('Faculdade')
    expect(within(bar()).getByRole('button', { name: 'Levar para o App (liberar com um código)' })).toBeDisabled()
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
    mark('Faculdade')
    fireEvent.click(within(bar()).getByRole('button', { name: 'Levar para Local' }))
    const ask = screen.getByRole('alertdialog', { name: 'Levar “Lista de exercícios 3” para Local' })
    expect(ask).toHaveTextContent('Vão 1 nota e')
    expect(ask).toHaveTextContent('limpar os dados do navegador apaga')
    fireEvent.click(within(ask).getByRole('button', { name: 'Cancelar' }))
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
    expect(sideOf('Lista de exercícios 3')).toBe('drive')
  })

  it('escolhendo App, a pergunta fala do App (e não do Google Drive)', async () => {
    await seed()
    useLibraryStore.setState({ appOn: true } as never)
    open()
    mark('Faculdade')
    fireEvent.click(within(bar()).getByRole('button', { name: 'Levar para o App' }))
    const ask = screen.getByRole('alertdialog', { name: 'Levar “Lista de exercícios 3” para o App' })
    expect(ask).toHaveTextContent('sua conta do Estudo')
    expect(ask).not.toHaveTextContent('Google Drive')
    expect(within(ask).getByRole('button', { name: 'Levar para o App' })).toBeInTheDocument()
  })

  it('"Levar para Local" leva a nota de verdade: depois, ela está só neste navegador e a linha diz Local', async () => {
    await seed()
    open()
    mark('Faculdade')
    fireEvent.click(within(bar()).getByRole('button', { name: 'Levar para Local' }))
    fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Levar para Local' }))
    const lista = () => library().files.find(file => file.name === 'Lista de exercícios 3')!
    await waitFor(() => expect(sideOf('Lista de exercícios 3')).toBe('local'))
    await waitFor(() => expect(row('Lista de exercícios 3')).toHaveTextContent('Local'))
    expect(await library().openFile(lista().id).then(opened => opened.content)).toBe('lista')
  })

  it('levar as notas de uma pasta de volta para o Google Drive não muda a pasta', async () => {
    await seed()
    open()
    mark(/Projeto Aurora/)
    fireEvent.click(within(bar()).getByRole('button', { name: 'Levar para o Google Drive' }))
    const ask = screen.getByRole('alertdialog', { name: 'Levar 2 notas para o Google Drive' })
    expect(ask).toHaveTextContent('Vão 2 notas e')
    fireEvent.click(within(ask).getByRole('button', { name: 'Levar para o Google Drive' }))
    await waitFor(() => expect(sideOf('Reunião de kickoff')).toBe('drive'))
    await waitFor(() => expect(sideOf('Ata do kickoff')).toBe('drive'))
    expect(library().folders.find(folder => folder.id === aurora.id)).toMatchObject({ name: aurora.name, parentId: trabalho.id, position: aurora.position })
  })
})

describe('sem login', () => {
  it('tudo fica em Local; escolher o Google Drive pede para entrar primeiro', async () => {
    useAccountStore.setState({ activeId: LOCAL_ACCOUNT.id })
    await library().connect('local')
    const folder = await library().createFolder({ name: `Rascunhos ${account}` })
    await library().createFile({ name: `Ideia ${account}`, type: 'class', folderId: folder.id }, 'ideia')
    open()
    expect(screen.getByText(/Sem login, tudo fica em Local/)).toBeInTheDocument()
    expect(row(`Ideia ${account}`)).toHaveTextContent('Local')
    mark(folder.name)
    expect(within(bar()).getByRole('button', { name: /^Levar para Local/ })).toBeDisabled()
    fireEvent.click(within(bar()).getByRole('button', { name: 'Levar para o Google Drive' }))
    const ask = screen.getByRole('alertdialog', { name: 'Entrar para usar o Google Drive' })
    fireEvent.click(within(ask).getByRole('button', { name: 'Entrar com o Google' }))
    expect(useUiStore.getState().overlay).toEqual({ kind: 'account' })
  })
})

describe('mudar o lugar em lote', () => {
  it('marca várias pastas, diz quantas notas, e leva só as que estão em outro lugar com uma pergunta só', async () => {
    await seed()
    useLibraryStore.setState({ appOn: false } as never)
    open()
    expect(screen.queryByRole('toolbar', { name: 'Notas marcadas' })).not.toBeInTheDocument()
    mark('Faculdade')
    mark('Trabalho')
    expect(bar()).toHaveTextContent('3 notas marcadas')
    fireEvent.click(within(bar()).getByRole('button', { name: 'Levar para Local' }))
    // as 2 notas de Trabalho já estão em Local: do lote, só a de Faculdade muda de lugar
    const ask = screen.getByRole('alertdialog', { name: 'Levar “Lista de exercícios 3” para Local' })
    expect(ask).toHaveTextContent('Vão 1 nota e')
    expect(ask).toHaveTextContent('2 já estão em Local')
    expect(ask).toHaveTextContent('limpar os dados do navegador apaga')
    fireEvent.click(within(ask).getByRole('button', { name: 'Levar para Local' }))
    await waitFor(() => expect(sideOf('Lista de exercícios 3')).toBe('local'))
    // depois de levar, nada fica marcado
    expect(screen.queryByRole('toolbar', { name: 'Notas marcadas' })).not.toBeInTheDocument()
  })

  it('"Marcar tudo" marca todas as notas, até as das pastas fechadas', async () => {
    await seed()
    open()
    fireEvent.click(screen.getByRole('checkbox', { name: 'Marcar tudo' }))
    expect(bar()).toHaveTextContent('3 notas marcadas')
    expect(within(row('Trabalho')).getByRole('checkbox')).toBeChecked()
  })

  it('"Marcar tudo" com busca marca só as notas que ela achou; "Limpar" desmarca', async () => {
    await seed()
    useLibraryStore.setState({ appOn: false } as never)
    open()
    fireEvent.change(screen.getByRole('searchbox', { name: 'Buscar pasta ou nota' }), { target: { value: 'kickoff' } })
    fireEvent.click(screen.getByRole('checkbox', { name: 'Marcar tudo' }))
    expect(bar()).toHaveTextContent('2 notas marcadas')
    fireEvent.click(within(bar()).getByRole('button', { name: 'Limpar' }))
    expect(screen.queryByRole('toolbar', { name: 'Notas marcadas' })).not.toBeInTheDocument()
    expect(screen.getByRole('checkbox', { name: 'Marcar tudo' })).not.toBeChecked()
  })

  it('App só fica disponível com a estrutura do app ligada', async () => {
    await seed()
    useLibraryStore.setState({ appOn: false } as never)
    open()
    mark('Faculdade')
    expect(within(bar()).getByRole('button', { name: /Levar para o App/ })).toBeDisabled()
    useLibraryStore.setState({ appOn: true } as never)
    await waitFor(() => expect(within(bar()).getByRole('button', { name: 'Levar para o App' })).toBeEnabled())
    fireEvent.click(within(bar()).getByRole('button', { name: 'Levar para o App' }))
    expect(screen.getByRole('alertdialog', { name: 'Levar “Lista de exercícios 3” para o App' })).toHaveTextContent('sua conta do Estudo')
    useLibraryStore.setState({ appOn: false } as never)
  })
})

describe('mudar o lugar em lote · revisão de design', () => {
  it('com a pergunta aberta, a barra espera: um lugar para responder por vez', async () => {
    await seed()
    useLibraryStore.setState({ appOn: false } as never)
    open()
    mark('Faculdade')
    mark('Trabalho')
    fireEvent.click(within(bar()).getByRole('button', { name: 'Levar para Local' }))
    expect(screen.getByRole('alertdialog')).toBeInTheDocument()
    expect(within(bar()).getByRole('button', { name: 'Levar para Local' })).toBeDisabled()
    expect(within(bar()).getByRole('button', { name: 'Levar para o Google Drive' })).toBeDisabled()
    fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Cancelar' }))
    expect(within(bar()).getByRole('button', { name: 'Levar para Local' })).toBeEnabled()
  })
})

describe('mudar o lugar em lote · acessibilidade', () => {
  it('setas andam pela barra, a contagem é anunciada e "Limpar" devolve o foco a "Marcar tudo"', async () => {
    await seed()
    useLibraryStore.setState({ appOn: false } as never)
    open()
    mark('Faculdade')
    mark('Trabalho')
    expect(within(bar()).getByText(/^3 notas marcadas · /)).toHaveAttribute('aria-live', 'polite')
    const drive = within(bar()).getByRole('button', { name: 'Levar para o Google Drive' })
    drive.focus()
    fireEvent.keyDown(drive, { key: 'ArrowRight' })
    expect(within(bar()).getByRole('button', { name: 'Levar para Local' })).toHaveFocus()
    // o App desabilitado é pulado; End vai para o último que dá para usar, Home para o primeiro
    fireEvent.keyDown(document.activeElement!, { key: 'End' })
    expect(within(bar()).getByRole('button', { name: 'Limpar' })).toHaveFocus()
    fireEvent.keyDown(document.activeElement!, { key: 'Home' })
    expect(drive).toHaveFocus()
    fireEvent.click(within(bar()).getByRole('button', { name: 'Limpar' }))
    expect(screen.getByRole('checkbox', { name: 'Marcar tudo' })).toHaveFocus()
  })
})
