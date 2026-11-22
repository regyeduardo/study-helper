import { beforeEach, describe, expect, it } from 'vitest'
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

import { Overlays } from '@/components/dialogs/Overlays'
import { ItemMenu } from '@/components/library/ItemMenu'
import { SelectionBar } from '@/components/library/SelectionBar'
import { BlockingWindow } from '@/components/ui/BlockingWindow'
import { useBlockingStore } from '@/stores/blocking'
import { useLibraryStore } from '@/stores/library'
import { useUiStore } from '@/stores/ui'
import { fileNow, jobsNow, settle, slowLibrary, toastsNow } from '@/test/feedback/slow'

// Apagar writes one file at a time (one Drive write each). The click must show it at once:
// the items leave the list and the window that holds the app (owner's choice F) says how many are being removed.

let slow: ReturnType<typeof slowLibrary>
let ids: string[]

const store = () => useLibraryStore.getState()
/** The operations holding the app in the window (not the failures waiting for "Fechar"). */
const holding = () => useBlockingStore.getState().ops.filter(op => !op.failure)

async function note(name: string, extra: object = {}) {
  return (await store().createFile({ name, type: 'class', status: 'ready', folderId: null, ...extra }, `# ${name}`)).id
}

beforeEach(async () => {
  useBlockingStore.setState({ ops: [] })
  slow = slowLibrary()
  ids = [await note('Limites'), await note('Derivadas'), await note('Integrais')]
})

const renderApp = () =>
  render(
    <MemoryRouter>
      <ItemMenu />
      <SelectionBar />
      <Overlays />
    </MemoryRouter>,
  )

describe('Apagar: o clique responde na hora', () => {
  it('pelo menu de uma nota: ela sai da lista e aparece "Apagando" antes de o Drive responder', async () => {
    useUiStore.getState().openMenu({ kind: 'file', id: ids[0], x: 10, y: 10 })
    renderApp()
    const release = slow.hold()
    fireEvent.click(within(screen.getByRole('menu')).getByRole('button', { name: 'Apagar' }))

    expect(fileNow(ids[0])?.deletedAt).toBeTruthy()
    expect(holding()).toHaveLength(1)
    expect(holding()[0]).toMatchObject({ title: 'Apagando "Limites"…', phase: 'Mandando para a lixeira' })

    await act(async () => {
      release()
      await settle()
    })
    expect(holding()).toHaveLength(0)
    // the window leaves (nothing goes to Tarefas); the toast says it is done
    expect(jobsNow()).toHaveLength(0)
    expect(toastsNow()).toContain('"Limites" foi para a lixeira')
  })

  it('pela barra de seleção: "Apagando 3 itens…" e os três saem da lista de uma vez', async () => {
    useUiStore.setState({ selection: new Set(ids) })
    renderApp()
    const release = slow.hold()
    fireEvent.click(within(screen.getByRole('toolbar', { name: 'Seleção' })).getByRole('button', { name: 'Apagar' }))

    for (const id of ids) expect(fileNow(id)?.deletedAt).toBeTruthy()
    expect(holding()).toHaveLength(1)
    expect(holding()[0].title).toBe('Apagando 3 itens…')

    await act(async () => {
      release()
      await settle()
    })
    expect(holding()).toHaveLength(0)
    expect(toastsNow()).toContain('3 na lixeira')
    expect(useUiStore.getState().selection.size).toBe(0)
  })

  it('"Apagar tudo" de uma nota com filhas: a família sai da lista e a janela conta quantos', async () => {
    const filha = await note('Resumo', { parentFileId: ids[0] })
    useUiStore.getState().open({ kind: 'delete-family', fileId: ids[0] })
    renderApp()
    const release = slow.hold()
    fireEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Apagar tudo' }))

    expect(fileNow(ids[0])?.deletedAt).toBeTruthy()
    expect(fileNow(filha)?.deletedAt).toBeTruthy()
    expect(holding()).toHaveLength(1)
    expect(holding()[0].title).toBe('Apagando 2 itens…')
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()

    await act(async () => {
      release()
      await settle()
    })
    expect(holding()).toHaveLength(0)
    expect(toastsNow().at(-1)).toMatch(/foram para a Lixeira/)
  })

  it('o Drive falha: os itens voltam para a lista e a janela diz o motivo até "Fechar"', async () => {
    useUiStore.setState({ selection: new Set(ids) })
    renderApp()
    render(<BlockingWindow />)
    slow.repo.saveFile = async () => {
      throw new Error('Drive fora do ar')
    }
    fireEvent.click(within(screen.getByRole('toolbar', { name: 'Seleção' })).getByRole('button', { name: 'Apagar' }))
    await act(async () => {
      await settle()
    })
    for (const id of ids) expect(fileNow(id)?.deletedAt).toBeFalsy()
    expect(holding()).toHaveLength(0)
    const window_ = screen.getByRole('alertdialog', { name: 'Apagando 3 itens…' })
    expect(window_).toHaveTextContent('Drive fora do ar')
    expect(toastsNow().join(' ')).not.toMatch(/na lixeira/)
    fireEvent.click(within(window_).getByRole('button', { name: 'Fechar' }))
    expect(screen.queryByRole('alertdialog')).toBeNull()
  })
})
