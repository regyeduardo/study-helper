import { beforeEach, describe, expect, it } from 'vitest'
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

import { MoveDialog, NewFolderDialog, RenameDialog } from '@/components/dialogs/SimpleDialogs'
import { ItemMenu } from '@/components/library/ItemMenu'
import { SelectionBar } from '@/components/library/SelectionBar'
import { TrashList } from '@/components/library/TrashList'
import { Toasts } from '@/components/ui/Toasts'
import { useBlockingStore } from '@/stores/blocking'
import { useLibraryStore } from '@/stores/library'
import { useUiStore } from '@/stores/ui'
import { fileNow, jobsNow, settle, slowLibrary, toastsNow } from '@/test/feedback/slow'

// Small writes that still wait for the Drive: the window says "Salvando…", the star lights up, the row leaves the Lixeira.
// What goes on after the click holds the app in the window of the operation (owner's choice F), not in a line of Tarefas.

let slow: ReturnType<typeof slowLibrary>
let id: string

const store = () => useLibraryStore.getState()
/** The operations holding the app in the window (not the failures waiting for "Fechar"). */
const holding = () => useBlockingStore.getState().ops.filter(op => !op.failure)

beforeEach(async () => {
  useBlockingStore.setState({ ops: [] })
  slow = slowLibrary()
  id = (await store().createFile({ name: 'Limites', type: 'class', status: 'ready', folderId: null }, '# Limites')).id
})

describe('Renomear', () => {
  const open = () =>
    render(
      <MemoryRouter>
        <RenameDialog target="file" id={id} />
      </MemoryRouter>,
    )

  it('"Salvar" vira "Salvando…" na hora, o nome novo já vale e o segundo clique não grava de novo', async () => {
    open()
    fireEvent.change(screen.getByLabelText('Nome'), { target: { value: 'Limites e continuidade' } })
    const release = slow.hold()
    const before = slow.writes.saveFile
    fireEvent.click(screen.getByRole('button', { name: 'Salvar' }))
    const busy = screen.getByRole('button', { name: /Salvando/ })
    expect(busy).toBeDisabled()
    expect(busy.querySelector('.spinning')).not.toBeNull()
    expect(fileNow(id)?.name).toBe('Limites e continuidade')
    fireEvent.click(busy)
    await act(async () => {
      await settle()
    })
    expect(slow.writes.saveFile - before).toBe(1)

    await act(async () => {
      release()
      await settle()
    })
    expect(useUiStore.getState().overlay).toBeNull()
  })

  it('não gravou: o botão volta e o motivo aparece', async () => {
    open()
    fireEvent.change(screen.getByLabelText('Nome'), { target: { value: 'Outro nome' } })
    slow.breakWith(new Error('Drive fora do ar'))
    fireEvent.click(screen.getByRole('button', { name: 'Salvar' }))
    await act(async () => {
      await settle()
    })
    expect(screen.getByRole('button', { name: 'Salvar' })).toBeEnabled()
    expect(screen.getByText('Drive fora do ar')).toBeInTheDocument()
    expect(fileNow(id)?.name).toBe('Limites')
  })
})

describe('Nova pasta', () => {
  it('"Criar pasta" vira "Criando…" na hora e o segundo clique não cria outra', async () => {
    render(
      <MemoryRouter>
        <NewFolderDialog parentId={null} />
      </MemoryRouter>,
    )
    fireEvent.change(screen.getByLabelText('Nome'), { target: { value: 'Cálculo' } })
    const release = slow.hold()
    fireEvent.click(screen.getByRole('button', { name: 'Criar pasta' }))
    const busy = screen.getByRole('button', { name: /Criando/ })
    expect(busy).toBeDisabled()
    fireEvent.click(busy)
    expect(slow.writes.saveFolder).toBe(1)
    await act(async () => {
      release()
      await settle()
    })
    expect(store().folders.filter(folder => folder.name === 'Cálculo')).toHaveLength(1)
  })
})

describe('Favoritar', () => {
  it('pelo menu: a estrela do item muda antes de a gravação acabar', async () => {
    useUiStore.getState().openMenu({ kind: 'file', id, x: 10, y: 10 })
    render(
      <MemoryRouter>
        <ItemMenu />
      </MemoryRouter>,
    )
    slow.hold()
    fireEvent.click(within(screen.getByRole('menu')).getByRole('button', { name: 'Favoritar' }))
    expect(fileNow(id)?.favorite).toBe(true)
  })

  it('pela barra de seleção: todos os itens ficam favoritos de uma vez e a janela conta quantos', async () => {
    const other = (await store().createFile({ name: 'Derivadas', type: 'class', status: 'ready', folderId: null }, '# D')).id
    useUiStore.setState({ selection: new Set([id, other]) })
    render(
      <MemoryRouter>
        <SelectionBar />
      </MemoryRouter>,
    )
    const release = slow.hold()
    fireEvent.click(within(screen.getByRole('toolbar', { name: 'Seleção' })).getByRole('button', { name: 'Favoritar' }))
    expect(fileNow(id)?.favorite).toBe(true)
    expect(fileNow(other)?.favorite).toBe(true)
    expect(holding()[0]).toMatchObject({ title: 'Favoritando 2 itens…', phase: 'Marcando como favorito' })
    await act(async () => {
      release()
      await settle()
    })
    expect(holding()).toHaveLength(0)
    expect(jobsNow()).toHaveLength(0)
    expect(toastsNow()).toContain('2 nos favoritos')
  })
})

describe('Mover para…', () => {
  it('ao escolher a pasta a janela fecha na hora, a nota já está lá e a janela "Movendo" segura o app', async () => {
    const folder = await store().createFolder({ name: 'Cálculo' })
    useUiStore.setState({ overlay: { kind: 'move', fileIds: [id], folderIds: [] } })
    render(
      <MemoryRouter>
        <MoveDialog fileIds={[id]} folderIds={[]} />
        <Toasts />
      </MemoryRouter>,
    )
    const release = slow.hold()
    fireEvent.click(await screen.findByRole('treeitem', { name: /Cálculo/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Mover' }))

    expect(useUiStore.getState().overlay).toBeNull()
    expect(fileNow(id)?.folderId).toBe(folder.id)
    expect(holding()[0]).toMatchObject({ title: 'Movendo "Limites"…', phase: 'Levando para Cálculo', done: 0, total: 1, current: 'Limites' })

    await act(async () => {
      release()
      await settle()
    })
    expect(holding()).toHaveLength(0)
    expect(jobsNow()).toHaveLength(0)
    expect(toastsNow()).toContain('Movido para Cálculo')
  })

  it('não moveu: a nota volta para onde estava e o motivo aparece', async () => {
    const folder = await store().createFolder({ name: 'Cálculo' })
    useUiStore.setState({ overlay: { kind: 'move', fileIds: [id], folderIds: [] } })
    render(
      <MemoryRouter>
        <MoveDialog fileIds={[id]} folderIds={[]} />
      </MemoryRouter>,
    )
    slow.breakWith(new Error('Drive fora do ar'))
    fireEvent.click(await screen.findByRole('treeitem', { name: /Cálculo/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Mover' }))
    await act(async () => {
      await settle()
    })
    expect(fileNow(id)?.folderId).toBeNull()
    expect(folder.id).toBeTruthy()
    expect(toastsNow().join(' ')).toMatch(/Não deu para mover: Drive fora do ar/)
    expect(holding()).toHaveLength(0)
  })
})

// FR-021 (spec 005, 25/11): "no mesmo diretório não pode existir nem pasta de nome igual nem arquivo". O que a pessoa faz com um nome que
// já existe ali é bloqueado, dizendo qual, e nada é gravado.
describe('um nome que já existe na pasta', () => {
  it('renomear: o motivo aparece na janela, que fica aberta, e nada é gravado', async () => {
    const other = (await store().createFile({ name: 'Derivadas', type: 'class', status: 'ready', folderId: null }, '# D')).id
    useUiStore.setState({ overlay: { kind: 'rename', target: 'file', id: other } })
    render(
      <MemoryRouter>
        <RenameDialog target="file" id={other} />
      </MemoryRouter>,
    )
    const before = slow.writes.saveFile
    fireEvent.change(screen.getByLabelText('Nome'), { target: { value: ' limites ' } })
    fireEvent.click(screen.getByRole('button', { name: 'Salvar' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Já existe uma nota chamada "Limites" na Biblioteca.')
    expect(useUiStore.getState().overlay).not.toBeNull()
    expect(fileNow(other)?.name).toBe('Derivadas')
    expect(slow.writes.saveFile).toBe(before)
  })

  it('nova pasta: o motivo aparece e nenhuma pasta é criada', async () => {
    await store().createFolder({ name: 'Cálculo' })
    render(
      <MemoryRouter>
        <NewFolderDialog parentId={null} />
      </MemoryRouter>,
    )
    fireEvent.change(screen.getByLabelText('Nome'), { target: { value: 'cálculo' } })
    fireEvent.click(screen.getByRole('button', { name: 'Criar pasta' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Já existe uma pasta chamada "Cálculo" na Biblioteca.')
    expect(slow.writes.saveFolder).toBe(1)
    expect(store().folders.filter(folder => folder.name.toLowerCase() === 'cálculo')).toHaveLength(1)
  })

  it('mover: nada se move e o aviso diz qual', async () => {
    const folder = await store().createFolder({ name: 'Cálculo' })
    await store().createFile({ name: 'limites', type: 'class', status: 'ready', folderId: folder.id }, '# L')
    useUiStore.setState({ overlay: { kind: 'move', fileIds: [id], folderIds: [] } })
    render(
      <MemoryRouter>
        <MoveDialog fileIds={[id]} folderIds={[]} />
      </MemoryRouter>,
    )
    fireEvent.click(await screen.findByRole('treeitem', { name: /Cálculo/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Mover' }))
    await act(async () => {
      await settle()
    })
    expect(fileNow(id)?.folderId).toBeNull()
    expect(toastsNow()).toContain('Não deu para mover: Já existe uma nota chamada "limites" em Cálculo.')
    expect(holding()).toHaveLength(0)
  })
})

describe('Lixeira', () => {
  it('"Restaurar": o item sai da lixeira na hora', async () => {
    await store().trashFiles([id])
    render(<TrashList />)
    const release = slow.hold()
    fireEvent.click(screen.getByRole('button', { name: /Restaurar/ }))
    expect(fileNow(id)?.deletedAt).toBeFalsy()
    expect(screen.queryByText('Limites')).not.toBeInTheDocument()
    await act(async () => {
      release()
      await settle()
    })
    expect(toastsNow()).toContain('Restaurado')
  })

  it('"Apagar de vez": o item some na hora e a janela "Apagando de vez" segura o app', async () => {
    await store().trashFiles([id])
    render(<TrashList />)
    fireEvent.click(screen.getByRole('button', { name: 'Apagar de vez' }))
    const release = slow.hold()
    fireEvent.click(within(screen.getByText(/Apagar de vez\? Não dá para desfazer/)).getByRole('button', { name: 'Apagar de vez' }))
    expect(fileNow(id)).toBeUndefined()
    expect(holding()[0]).toMatchObject({ title: 'Apagando de vez…', phase: 'Limites' })
    await act(async () => {
      release()
      await settle()
    })
    expect(holding()).toHaveLength(0)
    expect(toastsNow()).toContain('Apagado de vez')
  })

  it('"Esvaziar a lixeira": a janela aparece quando a confirmação é aceita, contando os itens', async () => {
    await store().trashFiles([id])
    render(
      <MemoryRouter>
        <TrashList />
      </MemoryRouter>,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Esvaziar a lixeira' }))
    const overlay = useUiStore.getState().overlay
    if (overlay?.kind !== 'confirm') throw new Error('sem confirmação')
    slow.hold()
    void overlay.onConfirm()
    expect(holding()[0]).toMatchObject({ title: 'Esvaziando a lixeira…', total: 1, current: 'Limites' })
  })
})
