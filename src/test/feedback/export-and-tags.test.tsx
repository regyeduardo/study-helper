import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

const { printing } = vi.hoisted(() => ({ printing: { current: null as null | { promise: Promise<void>; resolve(): void } } }))

vi.mock('@/lib/exports/pdf', () => ({
  printMarkdownAsPdf: vi.fn(() => {
    let resolve!: () => void
    const promise = new Promise<void>(done => (resolve = done))
    printing.current = { promise, resolve }
    return promise
  }),
}))
vi.mock('@/utils/download', async importOriginal => ({ ...(await importOriginal<typeof import('@/utils/download')>()), downloadBlob: vi.fn() }))

import { ItemMenu } from '@/components/library/ItemMenu'
import { SelectionBar } from '@/components/library/SelectionBar'
import { BlockingWindow } from '@/components/ui/BlockingWindow'
import { Toasts } from '@/components/ui/Toasts'
import { useBlockingStore } from '@/stores/blocking'
import { useJobsStore } from '@/stores/jobs'
import { useLibraryStore } from '@/stores/library'
import { useUiStore } from '@/stores/ui'
import { type Deferred, deferred, jobsNow, settle, slowLibrary, toastsNow } from '@/test/feedback/slow'
import { downloadBlob } from '@/utils/download'

// Exportar and Sugerir etiquetas read the note (a Drive read), render or call the AI, and only then show something.
// From the click the window of the operation holds the app (owner's choice F), in place of the old line in Tarefas.

let slow: ReturnType<typeof slowLibrary>
let id: string

/** The operations holding the app in the window (not the failures waiting for "Fechar"). */
const holding = () => useBlockingStore.getState().ops.filter(op => !op.failure)

const menu = (fileId: string) => {
  useUiStore.getState().openMenu({ kind: 'file', id: fileId, x: 10, y: 10 })
  render(
    <MemoryRouter>
      <ItemMenu />
      <SelectionBar />
      <Toasts />
      <BlockingWindow />
    </MemoryRouter>,
  )
  return screen.getByRole('menu')
}

beforeEach(async () => {
  useBlockingStore.setState({ ops: [] })
  slow = slowLibrary()
  vi.mocked(downloadBlob).mockClear()
  id = (await useLibraryStore.getState().createFile({ name: 'Limites', type: 'class', status: 'ready', folderId: null }, '# Limites\n\nSe os laterais diferem, o limite não existe.')).id
  // the note is not in memory: reading it is a trip to the Drive
  useLibraryStore.setState({ opened: {} })
})

describe('Exportar: "Preparando" desde o clique', () => {
  it('PDF: aparece "Preparando o PDF…" antes de a nota ser lida, e some quando o arquivo sai', async () => {
    const release = slow.hold()
    fireEvent.click(within(menu(id)).getByRole('button', { name: 'Exportar PDF' }))
    expect(holding()).toHaveLength(1)
    expect(holding()[0]).toMatchObject({ title: 'Preparando o PDF…', phase: 'Montando o arquivo' })

    await act(async () => {
      release()
      await settle()
    })
    // still rendering the paper: the window stays
    expect(holding()).toHaveLength(1)
    await act(async () => {
      printing.current!.resolve()
      await settle()
    })
    expect(holding()).toHaveLength(0)
    expect(jobsNow()).toHaveLength(0)
  })

  it('.md: a janela aparece na hora e o arquivo é entregue', async () => {
    const release = slow.hold()
    fireEvent.click(within(menu(id)).getByRole('button', { name: 'Exportar .md' }))
    expect(holding()[0]).toMatchObject({ title: 'Preparando o arquivo .md…' })
    await act(async () => {
      release()
      await settle()
    })
    expect(downloadBlob).toHaveBeenCalledTimes(1)
    expect(holding()).toHaveLength(0)
  })

  it('.zip: a janela aparece na hora', async () => {
    slow.hold()
    fireEvent.click(within(menu(id)).getByRole('button', { name: /Exportar .zip/ }))
    expect(holding()[0]).toMatchObject({ title: 'Preparando o arquivo .zip…' })
  })

  it('a leitura falha: a janela diz o motivo até "Fechar" e nada é baixado', async () => {
    slow.breakWith(new Error('Drive fora do ar'))
    fireEvent.click(within(menu(id)).getByRole('button', { name: 'Exportar .md' }))
    await act(async () => {
      await settle()
    })
    expect(downloadBlob).not.toHaveBeenCalled()
    expect(holding()).toHaveLength(0)
    const window_ = screen.getByRole('alertdialog', { name: 'Preparando o arquivo .md…' })
    expect(window_).toHaveTextContent('Drive fora do ar')
    fireEvent.click(within(window_).getByRole('button', { name: 'Fechar' }))
    expect(screen.queryByRole('alertdialog')).toBeNull()
  })

  it('da barra de seleção: "Exportar" também mostra a janela na hora', async () => {
    useUiStore.setState({ selection: new Set([id]) })
    slow.hold()
    render(
      <MemoryRouter>
        <SelectionBar />
      </MemoryRouter>,
    )
    fireEvent.click(within(screen.getByRole('toolbar', { name: 'Seleção' })).getByRole('button', { name: 'Exportar' }))
    expect(holding()[0]).toMatchObject({ title: 'Preparando o arquivo .zip…', phase: 'Montando o arquivo com 1 nota' })
  })
})

describe('Sugerir etiquetas: o clique mostra que a IA está lendo', () => {
  let suggesting: Deferred

  beforeEach(() => {
    suggesting = deferred()
    useJobsStore.setState({
      suggestTags: async fileId => {
        await suggesting.promise
        await useLibraryStore.getState().updateFile(fileId, { suggestedTags: ['limites', 'continuidade'] })
      },
    })
  })

  it('aparece "Sugerindo etiquetas…" na hora; no fim, um aviso com o que saiu e o atalho para a nota', async () => {
    fireEvent.click(within(menu(id)).getByRole('button', { name: 'Sugerir etiquetas' }))
    expect(holding()).toHaveLength(1)
    expect(holding()[0]).toMatchObject({ title: 'Sugerindo etiquetas…', phase: 'A IA está lendo a nota' })

    await act(async () => {
      suggesting.resolve()
      await settle()
    })
    expect(holding()).toHaveLength(0)
    expect(toastsNow()).toContain('2 etiquetas sugeridas.')
    expect(screen.getByRole('button', { name: 'Ver na nota' })).toBeInTheDocument()
  })

  it('a IA não achou nada novo: o aviso diz isso', async () => {
    useJobsStore.setState({ suggestTags: async () => undefined })
    fireEvent.click(within(menu(id)).getByRole('button', { name: 'Sugerir etiquetas' }))
    await act(async () => {
      await settle()
    })
    expect(toastsNow()).toContain('Não saíram etiquetas novas para esta nota.')
  })
})
