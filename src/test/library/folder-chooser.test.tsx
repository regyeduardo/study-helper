import { readFileSync } from 'node:fs'
import path from 'node:path'

import { useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'

import { FolderChooser, FolderChooserDialog, FolderField } from '@/components/dialogs/FolderChooser'
import { Dialog } from '@/components/ui/Dialog'
import { useLibraryStore } from '@/stores/library'
import type { FolderColor, FolderMeta } from '@/types/domain'

const stamp = { at: '2026-10-10T10:00:00Z', deviceId: 'local', deviceName: 'Este computador' }

function folder(id: string, name: string, parentId: string | null, extra: { favorite?: boolean; color?: FolderColor; deletedAt?: string } = {}): FolderMeta {
  return { id, name, parentId, position: 0, description: '', isCourse: false, courseOrigin: null, courseDescription: null, courseMaterial: null, created: stamp, updated: stamp, deletedAt: null, ...extra } as FolderMeta
}

const LONG = 'Reunião de alinhamento com o cliente sobre o cronograma do Projeto Aurora, 28 de outubro'
// Pessoal › Nível 1 › … › Nível 12: deeper than any real library
const DEEP = Array.from({ length: 12 }, (_, index) => folder(`d${index + 1}`, `Nível ${index + 1} ${LONG}`, index ? `d${index}` : 'pes'))

const FOLDERS = [
  folder('trab', 'Trabalho', null, { favorite: true, color: 'azul' }),
  folder('cli', 'Clientes', 'trab'),
  folder('aurora', 'Projeto Aurora', 'trab'),
  folder('atas', 'Atas', 'aurora'),
  folder('kick', 'Kickoff do cliente, 14 de outubro', 'atas'),
  folder('est', 'Estudos', null, { color: 'verde' }),
  folder('ing', 'Inglês (curso)', 'est'),
  folder('mod1', 'Módulo 1', 'ing', { favorite: true, color: 'verde' }),
  folder('pes', 'Pessoal', null),
  folder('velhas', 'Atas antigas', 'pes'),
  folder('lixo', 'Atas apagadas', null, { favorite: true, deletedAt: '2026-10-20T10:00:00Z' }),
  ...DEEP,
]

// The proposed default folder: named after the note, not made yet (the NEW_HOME of FromNoteFields).
const PROPOSED = { id: 'pasta-nova', name: 'Pauta', parentId: 'atas' }

let made = 0
const createFolder = vi.fn(async (fields: Partial<FolderMeta> & { name: string }) => {
  const created = folder(`nova-${++made}`, fields.name, fields.parentId ?? null)
  useLibraryStore.setState(state => ({ folders: [...state.folders, created] }))
  return created
})

beforeEach(() => {
  made = 0
  createFolder.mockClear()
  useLibraryStore.setState({ folders: FOLDERS, files: [], createFolder })
  Element.prototype.scrollIntoView = vi.fn()
})

afterEach(cleanup)

const changes: (string | null)[] = []
const confirmed: (string | null)[] = []

/** The panel as a caller uses it: it owns the value. */
function Panel({ start, ...props }: { start: string | null } & Omit<Parameters<typeof FolderChooser>[0], 'value' | 'onChange'>) {
  const [value, setValue] = useState(start)
  return <FolderChooser {...props} value={value} onChange={id => (changes.push(id), setValue(id))} onConfirm={id => confirmed.push(id)} />
}

beforeEach(() => {
  changes.length = 0
  confirmed.length = 0
})

const tree = () => screen.getByRole('tree', { name: 'Todas as pastas' })
const item = (name: string | RegExp, within_: HTMLElement = tree()) => within(within_).getByRole('treeitem', { name: typeof name === 'string' ? new RegExp(`^(Pasta \\w+ )?${name.replace(/[()]/g, '\\$&')}$`) : name })
const marked = (scope: HTMLElement = tree()) => within(scope).queryAllByRole('treeitem', { selected: true })
const destination = () => screen.getByRole('group', { name: 'Fica em' })

describe('abre com a pasta padrão marcada e visível', () => {
  it('a pasta padrão vem marcada, com os pais abertos e rolada até ela; o resto fica fechado', () => {
    render(<Panel start="atas" />)
    expect(marked()).toEqual([item('Atas')])
    expect(item('Trabalho')).toHaveAttribute('aria-expanded', 'true')
    expect(item('Projeto Aurora')).toHaveAttribute('aria-expanded', 'true')
    expect(item('Atas')).toHaveAttribute('aria-expanded', 'false')
    expect(item('Estudos')).toHaveAttribute('aria-expanded', 'false')
    expect(within(tree()).queryByRole('treeitem', { name: /Inglês/ })).not.toBeInTheDocument()
    expect(Element.prototype.scrollIntoView).toHaveBeenCalled()
    expect(vi.mocked(Element.prototype.scrollIntoView).mock.contexts.at(-1)).toBe(item('Atas'))
  })

  it('a raiz é "Biblioteca (raiz)" e as pastas apagadas não aparecem', () => {
    render(<Panel start={null} />)
    expect(marked()).toEqual([item('Biblioteca (raiz)')])
    expect(screen.queryByText('Atas apagadas')).not.toBeInTheDocument()
  })

  it('a pasta padrão que ainda não existe aparece marcada como nova e só é criada por quem confirma', () => {
    render(<FolderChooserDialog value={PROPOSED.id} extra={PROPOSED} title="Onde salvar a nota nova" leaf="Ata: Pauta" onConfirm={id => confirmed.push(id)} onClose={() => undefined} />)
    const dialog = screen.getByRole('dialog', { name: 'Onde salvar a nota nova' })
    expect(marked()).toEqual([item('Pauta (pasta nova)')])
    expect(item('Atas')).toHaveAttribute('aria-expanded', 'true')
    expect(destination()).toHaveTextContent('Trabalho › … › Atas › Pauta › Ata: Pauta')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Usar esta pasta' }))
    expect(confirmed).toEqual(['pasta-nova'])
    expect(createFolder).not.toHaveBeenCalled()
  })
})

describe('filtro por nome', () => {
  it('só as que batem aparecem, cada uma com o caminho; sem acento nem caixa', () => {
    render(<Panel start="trab" />)
    fireEvent.change(screen.getByRole('searchbox', { name: 'Filtrar pastas' }), { target: { value: 'ATAS' } })
    expect(screen.queryByRole('tree', { name: 'Todas as pastas' })).not.toBeInTheDocument()
    const found = screen.getByRole('tree', { name: 'Pastas encontradas' })
    const names = within(found)
      .getAllByRole('treeitem')
      .map(row => row.querySelector('.fc-name')?.textContent)
    expect(names).toEqual(['Atas', 'Atas antigas'])
    expect(item('Atas', found)).toHaveTextContent('Trabalho › Projeto Aurora')
    expect(item('Atas antigas', found)).toHaveTextContent('Pessoal')
    fireEvent.change(screen.getByRole('searchbox', { name: 'Filtrar pastas' }), { target: { value: 'ingles' } })
    expect(item('Inglês (curso)', screen.getByRole('tree', { name: 'Pastas encontradas' }))).toHaveTextContent('Estudos')
  })

  it('marcar um resultado e limpar o filtro mostra a árvore aberta até ele', () => {
    render(<Panel start="trab" />)
    const filter = screen.getByRole('searchbox', { name: 'Filtrar pastas' })
    fireEvent.change(filter, { target: { value: 'módulo' } })
    fireEvent.click(item('Módulo 1', screen.getByRole('tree', { name: 'Pastas encontradas' })))
    expect(changes).toEqual(['mod1'])
    fireEvent.keyDown(filter, { key: 'Escape' })
    expect(filter).toHaveValue('')
    expect(marked()).toEqual([item('Módulo 1')])
    expect(item('Estudos')).toHaveAttribute('aria-expanded', 'true')
  })

  it('o leitor de tela ouve quantas pastas o filtro achou', () => {
    render(<Panel start="trab" />)
    const live = screen.getByRole('status')
    const filter = screen.getByRole('searchbox', { name: 'Filtrar pastas' })
    expect(live).toBeEmptyDOMElement()
    fireEvent.change(filter, { target: { value: 'atas' } })
    expect(live).toHaveTextContent('2 pastas encontradas')
    fireEvent.change(filter, { target: { value: 'ingles' } })
    expect(live).toHaveTextContent('1 pasta encontrada')
    fireEvent.change(filter, { target: { value: 'zzz' } })
    expect(live).toHaveTextContent('Nenhuma pasta encontrada')
  })

  it('sem resultado, diz que não achou', () => {
    render(<Panel start="trab" />)
    fireEvent.change(screen.getByRole('searchbox', { name: 'Filtrar pastas' }), { target: { value: 'zzz' } })
    expect(screen.getByText('Nenhuma pasta com esse nome.')).toBeInTheDocument()
  })
})

describe('favoritas em cima, com a cor', () => {
  it('as favoritas vêm antes da árvore, com a cor e o caminho; marcar uma abre a árvore até ela', () => {
    render(<Panel start="atas" />)
    const favorites = screen.getByRole('list', { name: 'Favoritas' })
    expect(favorites.compareDocumentPosition(tree()) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    const rows = within(favorites).getAllByRole('button')
    expect(rows.map(row => row.querySelector('.fc-name')?.textContent)).toEqual(['Módulo 1', 'Trabalho'])
    expect(within(rows[0]).getByRole('img', { name: 'Pasta verde' })).toBeInTheDocument()
    expect(rows[0]).toHaveTextContent('Estudos › Inglês (curso)')
    expect(within(rows[1]).getByRole('img', { name: 'Pasta azul' })).toBeInTheDocument()
    // the color shows in the tree too
    expect(within(item('Trabalho')).getByRole('img', { name: 'Pasta azul' })).toBeInTheDocument()
    fireEvent.click(rows[0])
    expect(changes).toEqual(['mod1'])
    expect(rows[0]).toHaveAttribute('aria-pressed', 'true')
    expect(marked()).toEqual([item('Módulo 1')])
    expect(item('Inglês (curso)')).toHaveAttribute('aria-expanded', 'true')
  })

  it('Enter numa favorita confirma, como na árvore', () => {
    render(<Panel start="trab" />)
    const [modulo] = within(screen.getByRole('list', { name: 'Favoritas' })).getAllByRole('button')
    fireEvent.keyDown(modulo, { key: 'Enter' })
    expect(changes).toEqual(['mod1'])
    expect(confirmed).toEqual(['mod1'])
  })

  it('nos resultados do filtro, as favoritas vêm primeiro', () => {
    useLibraryStore.setState(state => ({ folders: [...state.folders, folder('zatas', 'Atas do clube', 'pes', { favorite: true })] }))
    render(<Panel start="trab" />)
    fireEvent.change(screen.getByRole('searchbox', { name: 'Filtrar pastas' }), { target: { value: 'atas' } })
    const names = within(screen.getByRole('tree', { name: 'Pastas encontradas' }))
      .getAllByRole('treeitem')
      .map(row => row.querySelector('.fc-name')?.textContent)
    expect(names).toEqual(['Atas do clube', 'Atas', 'Atas antigas'])
  })
})

describe('criar pasta no lugar', () => {
  it('cria dentro da marcada, e a nova fica marcada e visível', async () => {
    render(<Panel start="aurora" />)
    const name = screen.getByRole('textbox', { name: 'Nome da pasta nova' })
    expect(screen.getByRole('button', { name: 'Criar' })).toBeDisabled()
    fireEvent.change(name, { target: { value: '  Contratos ' } })
    fireEvent.click(screen.getByRole('button', { name: 'Criar' }))
    await waitFor(() => expect(marked()).toEqual([item('Contratos')]))
    expect(createFolder).toHaveBeenCalledWith({ name: 'Contratos', parentId: 'aurora' })
    expect(changes).toEqual(['nova-1'])
    expect(name).toHaveValue('')
    expect(item('Projeto Aurora')).toHaveAttribute('aria-expanded', 'true')
  })

  it('se não der para criar, avisa e continua na marcada', async () => {
    createFolder.mockRejectedValueOnce(new Error('sem rede'))
    render(<Panel start="aurora" />)
    fireEvent.change(screen.getByRole('textbox', { name: 'Nome da pasta nova' }), { target: { value: 'Contratos' } })
    fireEvent.click(screen.getByRole('button', { name: 'Criar' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Não deu para criar a pasta.')
    expect(changes).toEqual([])
    expect(screen.getByRole('textbox', { name: 'Nome da pasta nova' })).toHaveValue('Contratos')
  })

  it('enquanto cria, o botão diz "Criando…" e não deixa criar de novo', async () => {
    let finish: (made: FolderMeta) => void = () => undefined
    createFolder.mockImplementationOnce(() => new Promise<FolderMeta>(resolve => (finish = resolve)))
    render(<Panel start="aurora" />)
    fireEvent.change(screen.getByRole('textbox', { name: 'Nome da pasta nova' }), { target: { value: 'Contratos' } })
    fireEvent.click(screen.getByRole('button', { name: 'Criar' }))
    expect(screen.getByRole('button', { name: 'Criando…' })).toBeDisabled()
    await act(async () => finish(folder('nova-x', 'Contratos', 'aurora')))
    expect(screen.getByRole('button', { name: 'Criar' })).toBeInTheDocument()
  })

  it('Enter no nome cria (não confirma), também na raiz', async () => {
    render(<Panel start={null} />)
    fireEvent.change(screen.getByRole('textbox', { name: 'Nome da pasta nova' }), { target: { value: 'Viagens' } })
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Nome da pasta nova' }), { key: 'Enter' })
    await waitFor(() => expect(createFolder).toHaveBeenCalledWith({ name: 'Viagens', parentId: null }))
    await waitFor(() => expect(marked()).toEqual([item('Viagens')]))
    expect(confirmed).toEqual([])
  })

  it('dentro da pasta padrão que ainda não existe, cria ela primeiro e a nova dentro dela', async () => {
    render(<Panel start={PROPOSED.id} extra={PROPOSED} />)
    fireEvent.change(screen.getByRole('textbox', { name: 'Nome da pasta nova' }), { target: { value: 'Rascunhos' } })
    fireEvent.click(screen.getByRole('button', { name: 'Criar' }))
    await waitFor(() => expect(createFolder).toHaveBeenCalledTimes(2))
    expect(createFolder.mock.calls).toEqual([[{ name: 'Pauta', parentId: 'atas' }], [{ name: 'Rascunhos', parentId: 'nova-1' }]])
    await waitFor(() => expect(changes).toEqual(['nova-2']))
  })
})

describe('teclado: setas, Enter e Esc', () => {
  it('cima e baixo andam, direita abre e entra, esquerda fecha e sobe, Enter confirma', () => {
    render(<Panel start="trab" />)
    const trab = item('Trabalho')
    trab.focus()
    fireEvent.keyDown(trab, { key: 'ArrowRight' })
    expect(item('Trabalho')).toHaveAttribute('aria-expanded', 'true')
    fireEvent.keyDown(item('Trabalho'), { key: 'ArrowRight' })
    expect(marked()).toEqual([item('Clientes')])
    expect(item('Clientes')).toHaveFocus()
    fireEvent.keyDown(item('Clientes'), { key: 'ArrowDown' })
    expect(marked()).toEqual([item('Projeto Aurora')])
    expect(item('Projeto Aurora')).toHaveFocus()
    fireEvent.keyDown(item('Projeto Aurora'), { key: 'ArrowLeft' })
    expect(marked()).toEqual([item('Trabalho')])
    fireEvent.keyDown(item('Trabalho'), { key: 'ArrowLeft' })
    expect(item('Trabalho')).toHaveAttribute('aria-expanded', 'false')
    fireEvent.keyDown(item('Trabalho'), { key: 'ArrowUp' })
    expect(marked()).toEqual([item('Pessoal')])
    fireEvent.keyDown(item('Pessoal'), { key: 'Home' })
    expect(marked()).toEqual([item('Biblioteca (raiz)')])
    fireEvent.keyDown(item('Biblioteca (raiz)'), { key: 'ArrowDown' })
    fireEvent.keyDown(item('Estudos'), { key: 'Enter' })
    expect(confirmed).toEqual(['est'])
  })

  it('a setinha abre e fecha sem mudar a marcada; End vai à última', () => {
    render(<Panel start="trab" />)
    fireEvent.click(screen.getByRole('button', { name: 'Abrir Estudos' }))
    expect(item('Estudos')).toHaveAttribute('aria-expanded', 'true')
    expect(item('Inglês (curso)')).toBeInTheDocument()
    expect(marked()).toEqual([item('Trabalho')])
    fireEvent.click(screen.getByRole('button', { name: 'Fechar Estudos' }))
    expect(within(tree()).queryByRole('treeitem', { name: /Inglês/ })).not.toBeInTheDocument()
    fireEvent.keyDown(item('Trabalho'), { key: 'End' })
    expect(marked()).toEqual([item('Trabalho')])
    fireEvent.keyDown(item('Trabalho'), { key: 'Home' })
    fireEvent.keyDown(item('Biblioteca (raiz)'), { key: 'End' })
    expect(marked()).toEqual([item('Trabalho')])
  })

  it('Esc no nome da pasta nova só apaga o nome, não fecha nada', () => {
    const onClose = vi.fn()
    render(<FolderChooserDialog value="atas" onConfirm={() => undefined} onClose={onClose} />)
    const name = screen.getByRole('textbox', { name: 'Nome da pasta nova' })
    fireEvent.change(name, { target: { value: 'Contr' } })
    fireEvent.keyDown(name, { key: 'Escape' })
    expect(name).toHaveValue('')
    expect(onClose).not.toHaveBeenCalled()
  })

  it('no toque, o filtro não ganha foco sozinho, para o teclado não cobrir a árvore', () => {
    const real = window.matchMedia
    window.matchMedia = ((query: string) => ({ matches: query === '(pointer: coarse)' })) as typeof window.matchMedia
    render(<FolderChooserDialog value="atas" onConfirm={() => undefined} onClose={() => undefined} />)
    expect(screen.getByRole('searchbox', { name: 'Filtrar pastas' })).not.toHaveFocus()
    window.matchMedia = real
  })

  it('só a marcada entra no Tab; do filtro, a seta para baixo vai até ela; "/" volta ao filtro', () => {
    render(<Panel start="atas" />)
    expect(within(tree()).getAllByRole('treeitem').filter(row => row.tabIndex === 0)).toEqual([item('Atas')])
    const filter = screen.getByRole('searchbox', { name: 'Filtrar pastas' })
    fireEvent.keyDown(filter, { key: 'ArrowDown' })
    expect(item('Atas')).toHaveFocus()
    fireEvent.keyDown(item('Atas'), { key: '/' })
    expect(filter).toHaveFocus()
  })

  it('o filtro vazio mostra a dica "/", e "/" numa favorita também vai ao filtro; nos campos, "/" é só texto', () => {
    render(<Panel start="atas" />)
    const filter = screen.getByRole('searchbox', { name: 'Filtrar pastas' })
    const box = filter.closest('.fc-filter') as HTMLElement
    expect(box.querySelector('.fc-kbd')).toHaveTextContent('/')
    const favorite = within(screen.getByRole('list', { name: 'Favoritas' })).getAllByRole('button')[0]
    favorite.focus()
    fireEvent.keyDown(favorite, { key: '/' })
    expect(filter).toHaveFocus()
    const name = screen.getByRole('textbox', { name: 'Nome da pasta nova' })
    name.focus()
    expect(fireEvent.keyDown(name, { key: '/' })).toBe(true)
    expect(name).toHaveFocus()
    fireEvent.change(filter, { target: { value: 'a' } })
    expect(box.querySelector('.fc-kbd')).toBeNull()
  })

  it('com filtro, Enter no filtro marca o primeiro resultado e o segundo Enter confirma', () => {
    render(<Panel start="trab" />)
    const filter = screen.getByRole('searchbox', { name: 'Filtrar pastas' })
    fireEvent.change(filter, { target: { value: 'clien' } })
    fireEvent.keyDown(filter, { key: 'Enter' })
    expect(changes).toEqual(['cli'])
    expect(confirmed).toEqual([])
    fireEvent.keyDown(filter, { key: 'Enter' })
    expect(confirmed).toEqual(['cli'])
  })

  it('na janela, Esc limpa o filtro primeiro e depois fecha só o seletor, não a janela de baixo', () => {
    const closeChooser = vi.fn()
    const closeParent = vi.fn()
    render(
      <>
        <Dialog title="Gerar a Ata" onClose={closeParent}>
          <p>De “Pauta”.</p>
        </Dialog>
        <FolderChooserDialog value="atas" onConfirm={() => undefined} onClose={closeChooser} />
      </>,
    )
    const filter = screen.getByRole('searchbox', { name: 'Filtrar pastas' })
    expect(filter).toHaveFocus()
    fireEvent.change(filter, { target: { value: 'atas' } })
    fireEvent.keyDown(filter, { key: 'Escape' })
    expect(filter).toHaveValue('')
    expect(closeChooser).not.toHaveBeenCalled()
    fireEvent.keyDown(item('Atas'), { key: 'Escape' })
    expect(closeChooser).toHaveBeenCalledTimes(1)
    fireEvent.keyDown(screen.getByRole('button', { name: 'Voltar' }), { key: 'Escape' })
    expect(closeChooser).toHaveBeenCalledTimes(2)
    expect(closeParent).not.toHaveBeenCalled()
  })
})

describe('foco ao fechar', () => {
  it('volta para o botão que abriu o seletor', () => {
    const Host = () => {
      const [open, setOpen] = useState(false)
      return (
        <>
          <button onClick={() => setOpen(true)}>Abrir</button>
          {open && <FolderChooserDialog value="atas" onConfirm={() => undefined} onClose={() => setOpen(false)} />}
        </>
      )
    }
    render(<Host />)
    const opener = screen.getByRole('button', { name: 'Abrir' })
    opener.focus()
    fireEvent.click(opener)
    expect(screen.getByRole('searchbox', { name: 'Filtrar pastas' })).toHaveFocus()
    fireEvent.click(screen.getByRole('button', { name: 'Voltar' }))
    expect(opener).toHaveFocus()
  })
})

describe('Esc com o foco fora do miolo da janela', () => {
  it('no "Fechar" ou em lugar nenhum, fecha só o seletor, não a janela de baixo', () => {
    const closeChooser = vi.fn()
    const closeParent = vi.fn()
    render(
      <>
        <Dialog title="Gerar a Ata" onClose={closeParent}>
          <p>De “Pauta”.</p>
        </Dialog>
        <FolderChooserDialog value="atas" onConfirm={() => undefined} onClose={closeChooser} />
      </>,
    )
    const chooser = screen.getByRole('dialog', { name: 'Escolher pasta' })
    fireEvent.keyDown(within(chooser).getByRole('button', { name: 'Fechar' }), { key: 'Escape' })
    expect(closeChooser).toHaveBeenCalledTimes(1)
    fireEvent.keyDown(document.body, { key: 'Escape' })
    expect(closeChooser).toHaveBeenCalledTimes(2)
    expect(closeParent).not.toHaveBeenCalled()
  })
})

describe('limpar o filtro', () => {
  it('o botão só existe com texto, limpa, e devolve o foco ao filtro', () => {
    render(<Panel start="trab" />)
    const filter = screen.getByRole('searchbox', { name: 'Filtrar pastas' })
    expect(screen.queryByRole('button', { name: 'Limpar filtro' })).not.toBeInTheDocument()
    fireEvent.change(filter, { target: { value: 'atas' } })
    fireEvent.click(screen.getByRole('button', { name: 'Limpar filtro' }))
    expect(filter).toHaveValue('')
    expect(filter).toHaveFocus()
    expect(tree()).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Limpar filtro' })).not.toBeInTheDocument()
  })
})

describe('nome longo e pasta funda não quebram', () => {
  const css = readFileSync(path.resolve(__dirname, '../../styles/folder-chooser.css'), 'utf8')
  const rule = (selector: string) => {
    const at = css.indexOf(`${selector}{`)
    return at < 0 ? '' : css.slice(at, css.indexOf('}', at))
  }

  it('o nome corta com reticências, e o caminho inteiro fica no title; o recuo tem teto', () => {
    render(<Panel start="d12" />)
    const deepest = item(/^Nível 12 /)
    expect(deepest).toHaveAttribute('aria-selected', 'true')
    expect(deepest).toHaveAttribute('title', ['Pessoal', ...DEEP.map(row => row.name)].join(' › '))
    expect(deepest.querySelector('.fc-name')).toHaveTextContent(`Nível 12 ${LONG}`)
    const row = deepest.closest('.fc-row') as HTMLElement
    expect(Number(row.style.getPropertyValue('--fc-indent'))).toBeLessThanOrEqual(8)
    expect(rule('.fc-name')).toContain('text-overflow:ellipsis')
    expect(rule('.fc-name')).toContain('white-space:nowrap')
    expect(rule('.fc-tree')).toContain('overflow-x:hidden')
  })

  it('no celular (390 px), as linhas e os botões têm ao menos 36 px de toque', () => {
    const phone = css.slice(css.indexOf('@media (max-width:760px)'))
    expect(phone).toMatch(/\.fc-it[^{]*\{[^}]*min-height:36px/)
    expect(phone).toMatch(/\.fc-tw[^{]*\{[^}]*height:36px/)
    expect(phone).toMatch(/\.fc [^{]*\.btn[^{]*\{[^}]*height:36px/)
  })

  it('nenhum pedaço do caminho encolhe com peso menor que 1: a linha passaria da janela', () => {
    const weights = [...css.matchAll(/\.fc-seg[^{]*\{[^}]*?flex(?:-shrink)?:(?:0 )?([\d.]+)/g)].map(match => Number(match[1]))
    expect(weights.length).toBeGreaterThan(0)
    for (const weight of weights) expect(weight).toBeGreaterThanOrEqual(1)
  })

  it('no celular, a pasta marcada mostra o nome inteiro, já que toque não tem title', () => {
    const touch = css.slice(css.indexOf('@media (max-width:760px) and (hover:none)'))
    expect(css).toContain('@media (max-width:760px) and (hover:none)')
    expect(touch).toMatch(/\.fc-it\[aria-selected="true"\] \.fc-name[^{]*\{[^}]*white-space:normal/)
  })

  it('nome curto no caminho não fica com vão depois dele', () => {
    render(<Panel start="atas" leaf="Ata: Pauta" />)
    const atas = [...destination().querySelectorAll('.fc-seg')].find(segment => segment.textContent === 'Atas')
    expect(atas).toHaveClass('fc-short')
    const long = [...destination().querySelectorAll('.fc-seg')].find(segment => segment.textContent === 'Projeto Aurora')
    expect(long).not.toHaveClass('fc-short')
    expect(rule('.fc-seg.fc-short')).toContain('min-width:0')
  })

  it('numa janela baixa (a flutuante da gravação), a árvore fica no lugar das favoritas', () => {
    const short = css.slice(css.indexOf('@media (max-height:480px)'))
    expect(css).toContain('@media (max-height:480px)')
    expect(short).toMatch(/\.fc-sec[^{]*\{display:none/)
    expect(short).toMatch(/\.fc-it[^{]*\{[^}]*min-height:36px/)
    expect(short).toMatch(/\.fc \.input[^{]*\{[^}]*min-height:36px/)
    expect(short).toMatch(/\.ibtn[^{]*\{[^}]*height:36px/)
  })

  it('a estrela da favorita é cheia: a regra vence o fill:none de todo ícone', () => {
    expect(rule('.fc .fc-star')).toContain('fill:currentColor')
  })

  it('"Fica em" corta o meio de um caminho fundo e guarda o inteiro no title', () => {
    render(<Panel start="d12" leaf="Ata: Pauta" />)
    expect(destination()).toHaveTextContent(`Pessoal › … › Nível 11 ${LONG} › Nível 12 ${LONG} › Ata: Pauta`)
    expect(destination()).toHaveAttribute('title', ['Pessoal', ...DEEP.map(row => row.name), 'Ata: Pauta'].join(' › '))
  })
})

describe('"Fica em" segue a pasta marcada', () => {
  it('mostra o caminho da marcada e o nome do que vai ser salvo', () => {
    render(<Panel start="atas" leaf="Ata: Pauta" />)
    expect(destination()).toHaveTextContent('Fica em Trabalho › Projeto Aurora › Atas › Ata: Pauta')
    fireEvent.click(item('Clientes'))
    expect(destination()).toHaveTextContent('Fica em Trabalho › Clientes › Ata: Pauta')
    fireEvent.click(item('Biblioteca (raiz)'))
    expect(destination()).toHaveTextContent('Fica em Biblioteca › Ata: Pauta')
  })

  it('mostra a dica de quem chama para a pasta marcada', () => {
    render(<Panel start="atas" hint={id => (id === 'atas' ? 'A nota vai junto.' : 'Só a nota nova vai.')} />)
    expect(screen.getByText('A nota vai junto.')).toBeInTheDocument()
    fireEvent.click(item('Clientes'))
    expect(screen.getByText('Só a nota nova vai.')).toBeInTheDocument()
  })
})

describe('FolderField: o campo que troca o FolderPicker', () => {
  it('mostra a pasta atual e "Trocar" abre o seletor; confirmar troca, Voltar não', () => {
    const onChange = vi.fn()
    render(<FolderField value="atas" onChange={onChange} />)
    const field = screen.getByRole('group', { name: 'Pasta' })
    expect(field).toHaveTextContent('Trabalho › Projeto Aurora › Atas')
    fireEvent.click(within(field).getByRole('button', { name: 'Trocar' }))
    let dialog = screen.getByRole('dialog', { name: 'Escolher pasta' })
    fireEvent.click(item('Clientes'))
    fireEvent.click(within(dialog).getByRole('button', { name: 'Voltar' }))
    expect(onChange).not.toHaveBeenCalled()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    fireEvent.click(within(field).getByRole('button', { name: 'Trocar' }))
    dialog = screen.getByRole('dialog', { name: 'Escolher pasta' })
    expect(marked()).toEqual([item('Atas')])
    fireEvent.click(item('Clientes'))
    fireEvent.click(within(dialog).getByRole('button', { name: 'Usar esta pasta' }))
    expect(onChange).toHaveBeenCalledWith('cli')
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('a pasta proposta aparece como nova; título, rótulo e botão vêm de quem chama; dá para abrir por fora', () => {
    const Host = () => {
      const [open, setOpen] = useState(false)
      return (
        <>
          <button onClick={() => setOpen(true)}>Criar nota nova</button>
          <FolderField value={PROPOSED.id} onChange={() => undefined} extra={PROPOSED} label="Salvar em" title="Onde salvar a nota nova" confirmLabel="Salvar aqui" leaf="Ata: Pauta" open={open} onOpenChange={setOpen} />
        </>
      )
    }
    render(<Host />)
    expect(screen.getByRole('group', { name: 'Salvar em' })).toHaveTextContent('Trabalho › Projeto Aurora › Atas › Pauta (pasta nova)')
    fireEvent.click(screen.getByRole('button', { name: 'Criar nota nova' }))
    const dialog = screen.getByRole('dialog', { name: 'Onde salvar a nota nova' })
    expect(within(dialog).getByRole('button', { name: 'Salvar aqui' })).toBeInTheDocument()
    expect(marked()).toEqual([item('Pauta (pasta nova)')])
  })

  it('exclude esconde as pastas (e o que está dentro) na árvore, nas favoritas e no filtro', () => {
    render(<FolderChooser value={null} onChange={() => undefined} exclude={['trab']} />)
    expect(within(tree()).queryByRole('treeitem', { name: /Trabalho/ })).not.toBeInTheDocument()
    expect(within(screen.getByRole('list', { name: 'Favoritas' })).queryByText('Trabalho')).not.toBeInTheDocument()
    fireEvent.change(screen.getByRole('searchbox', { name: 'Filtrar pastas' }), { target: { value: 'atas' } })
    const names = within(screen.getByRole('tree', { name: 'Pastas encontradas' }))
      .getAllByRole('treeitem')
      .map(row => row.querySelector('.fc-name')?.textContent)
    expect(names).toEqual(['Atas antigas'])
  })
})

describe('na janela flutuante da gravação', () => {
  afterEach(() => {
    cleanup()
    document.querySelectorAll('iframe').forEach(frame => frame.remove())
  })

  /** A second window, as the floating one is: its own document, with the field inside. */
  const floating = () => {
    const frame = document.body.appendChild(document.createElement('iframe'))
    const inner = frame.contentDocument as Document
    return { inner, body: inner.body, host: inner.body.appendChild(inner.createElement('div')) }
  }

  it('"Trocar" abre o seletor na janela do próprio campo, e não na aba principal, atrás dela', () => {
    const onChange = vi.fn()
    const { inner, body, host } = floating()
    render(<FolderField value="atas" onChange={onChange} />, { container: host, baseElement: body })
    fireEvent.click(within(body).getByRole('button', { name: 'Trocar' }))
    const dialog = within(body).getByRole('dialog', { name: 'Escolher pasta' })
    expect(dialog.ownerDocument).toBe(inner)
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    fireEvent.click(within(dialog).getByRole('treeitem', { name: /Clientes/ }))
    fireEvent.click(within(dialog).getByRole('button', { name: 'Usar esta pasta' }))
    expect(onChange).toHaveBeenCalledWith('cli')
    expect(within(body).queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('Esc com o foco no "Fechar" fecha o seletor lá também, onde o Esc da janela comum não chega', () => {
    const { body, host } = floating()
    render(<FolderField value="atas" onChange={() => undefined} />, { container: host, baseElement: body })
    fireEvent.click(within(body).getByRole('button', { name: 'Trocar' }))
    const dialog = within(body).getByRole('dialog', { name: 'Escolher pasta' })
    fireEvent.keyDown(within(dialog).getByRole('button', { name: 'Fechar' }), { key: 'Escape' })
    expect(within(body).queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('lá também dá para digitar "/" nos campos: os elementos são de outra janela', () => {
    const { body, host } = floating()
    render(<FolderField value="atas" onChange={() => undefined} />, { container: host, baseElement: body })
    fireEvent.click(within(body).getByRole('button', { name: 'Trocar' }))
    expect(fireEvent.keyDown(within(body).getByRole('searchbox', { name: 'Filtrar pastas' }), { key: '/' })).toBe(true)
  })

  it('aberto por fora desde o começo, também abre na janela do campo', () => {
    const { body, host } = floating()
    render(<FolderField value="atas" onChange={() => undefined} open onOpenChange={() => undefined} />, { container: host, baseElement: body })
    expect(within(body).getByRole('dialog', { name: 'Escolher pasta' })).toBeInTheDocument()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })
})
