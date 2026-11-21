import { beforeEach, describe, expect, it } from 'vitest'
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

import { MoveDialog, NewFolderDialog, RenameDialog } from '@/components/dialogs/SimpleDialogs'
import { ItemMenu } from '@/components/library/ItemMenu'
import { SelectionBar } from '@/components/library/SelectionBar'
import { TrashList } from '@/components/library/TrashList'
import { Toasts } from '@/components/ui/Toasts'
import { useLibraryStore } from '@/stores/library'
import { useUiStore } from '@/stores/ui'
import { fileNow, jobsNow, running, settle, slowLibrary, toastsNow } from '@/test/feedback/slow'

// Small writes that still wait for the Drive: the window says "Salvando…", the star lights up, the row leaves the Lixeira.

let slow: ReturnType<typeof slowLibrary>
let id: string

const store = () => useLibraryStore.getState()

beforeEach(async () => {
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

  it('pela barra de seleção: todos os itens ficam favoritos de uma vez e a linha conta quantos', async () => {
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
    expect(running()[0]).toMatchObject({ kind: 'sync', title: 'Favoritando 2 itens…' })
    await act(async () => {
      release()
      await settle()
    })
    expect(running()).toHaveLength(0)
    expect(toastsNow()).toContain('2 nos favoritos')
  })
})

describe('Mover para…', () => {
  it('ao escolher a pasta a janela fecha na hora, a nota já está lá e a linha "Movendo" aparece', async () => {
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
    expect(running()[0]).toMatchObject({ kind: 'sync', title: 'Movendo "Limites"…' })

    await act(async () => {
      release()
      await settle()
    })
    expect(running()).toHaveLength(0)
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
    expect(jobsNow().filter(job => job.status === 'running')).toHaveLength(0)
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

  it('"Apagar de vez": o item some na hora e a linha "Apagando de vez" aparece', async () => {
    await store().trashFiles([id])
    render(<TrashList />)
    fireEvent.click(screen.getByRole('button', { name: 'Apagar de vez' }))
    const release = slow.hold()
    fireEvent.click(within(screen.getByText(/Apagar de vez\? Não dá para desfazer/)).getByRole('button', { name: 'Apagar de vez' }))
    expect(fileNow(id)).toBeUndefined()
    expect(running()[0]).toMatchObject({ kind: 'sync', title: 'Apagando de vez…' })
    await act(async () => {
      release()
      await settle()
    })
    expect(running()).toHaveLength(0)
    expect(toastsNow()).toContain('Apagado de vez')
  })

  it('"Esvaziar a lixeira": a linha aparece quando a confirmação é aceita', async () => {
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
    expect(running()[0]).toMatchObject({ kind: 'sync', title: 'Esvaziando a lixeira…' })
  })
})
