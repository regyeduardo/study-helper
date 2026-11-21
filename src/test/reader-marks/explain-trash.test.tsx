import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter, useLocation } from 'react-router-dom'

import { DocumentBody } from '@/components/reader/DocumentArticle'
import { paths } from '@/lib/paths'
import { useLibraryStore } from '@/stores/library'
import { studyLibrary } from '@/test/generation/study-fixture'

const CONTENT = ['# Limites', '', 'O limite lateral define a continuidade. A derivada usa limite lateral.', '', 'Depois vem a integral. Revise a derivada antes da prova.'].join('\n')

function Where() {
  return <div data-testid="where">{useLocation().pathname}</div>
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const library = () => useLibraryStore.getState()

async function note() {
  studyLibrary()
  return library().createFile({ name: 'Limites', type: 'class', status: 'ready', folderId: null }, CONTENT)
}

async function explain(source: string, excerpt: string, fields: { folderId?: string | null; status?: 'ready' | 'generating' } = {}) {
  return library().createFile(
    { name: `Explicação: ${excerpt}`, type: 'explanation', status: fields.status ?? 'ready', folderId: fields.folderId ?? null, parentFileId: source, sourceExcerpt: excerpt },
    fields.status === 'generating' ? '' : `# ${excerpt}\n\ntexto`,
  )
}

/** The note on screen, once its text is painted. */
async function shown(fileId: string): Promise<() => ShadowRoot> {
  render(
    <MemoryRouter initialEntries={[paths.file(fileId)]}>
      <DocumentBody fileId={fileId} />
      <Where />
    </MemoryRouter>,
  )
  const root = () => document.querySelector('[data-testid="github-viewer"]')!.shadowRoot!
  await waitFor(() => expect(document.querySelector('[data-testid="github-viewer"]')?.shadowRoot?.textContent).toContain('continuidade'))
  return root
}

const marked = (root: ShadowRoot) => [...root.querySelectorAll<HTMLElement>('mark.ex-mark')].map(mark => mark.textContent?.toLowerCase())
const markOf = (root: ShadowRoot, text: string) => [...root.querySelectorAll<HTMLElement>('mark.ex-strong')].find(mark => mark.textContent?.toLowerCase() === text)

describe('explicação na Lixeira não marca o texto', () => {
  it('uma explicação que já está na Lixeira não marca o trecho; as outras continuam', async () => {
    const source = await note()
    const gone = await explain(source.id, 'limite lateral')
    await explain(source.id, 'integral')
    await library().trashFiles([gone.id])

    const root = await shown(source.id)
    await waitFor(() => expect(markOf(root(), 'integral')).toBeTruthy())
    expect(markOf(root(), 'limite lateral')).toBeUndefined()
    expect(marked(root())).toEqual(['integral'])
    expect(root().textContent).toContain('limite lateral')
  })

  it('uma explicação dentro de uma pasta na Lixeira (ou numa subpasta dela) também não marca', async () => {
    const source = await note()
    const folder = await library().createFolder({ name: 'Cálculo' })
    const inner = await library().createFolder({ name: 'Limites', parentId: folder.id })
    await explain(source.id, 'limite lateral', { folderId: folder.id })
    await explain(source.id, 'derivada', { folderId: inner.id })
    await explain(source.id, 'integral')
    await library().trashFolder(folder.id)

    const root = await shown(source.id)
    await waitFor(() => expect(markOf(root(), 'integral')).toBeTruthy())
    expect(marked(root())).toEqual(['integral'])
  })

  it('apagar a explicação com a nota aberta tira a marca na hora, e restaurar a traz de volta', async () => {
    const source = await note()
    const lateral = await explain(source.id, 'limite lateral')
    await explain(source.id, 'integral')
    const root = await shown(source.id)
    await waitFor(() => expect(marked(root())).toContain('limite lateral'))

    await act(async () => {
      await library().trashFiles([lateral.id])
    })
    await waitFor(() => expect(markOf(root(), 'limite lateral')).toBeUndefined())
    expect(root().querySelectorAll('mark.ex-mark[data-ids*="' + lateral.id + '"]')).toHaveLength(0)
    expect(marked(root())).toEqual(['integral'])
    expect(root().textContent).toContain('O limite lateral define a continuidade')

    await act(async () => {
      await library().restoreFile(lateral.id)
    })
    await waitFor(() => expect(markOf(root(), 'limite lateral')).toBeTruthy())
  })

  it('mandar a pasta da explicação para a Lixeira com a nota aberta tira a marca na hora', async () => {
    const source = await note()
    const folder = await library().createFolder({ name: 'Explicações' })
    await explain(source.id, 'derivada', { folderId: folder.id })
    const root = await shown(source.id)
    await waitFor(() => expect(marked(root())).toContain('derivada'))

    await act(async () => {
      await library().trashFolder(folder.id)
    })
    await waitFor(() => expect(marked(root())).toEqual([]))
  })

  it('apagar enquanto ela é escrita tira a marca e o "gerando", e ela não volta quando a escrita termina', async () => {
    const source = await note()
    const writing = await explain(source.id, 'limite lateral', { status: 'generating' })
    const root = await shown(source.id)
    await waitFor(() => expect(root().querySelector('.ex-loading')).toBeTruthy())

    await act(async () => {
      await library().trashFiles([writing.id])
    })
    await waitFor(() => expect(marked(root())).toEqual([]))
    expect(root().querySelector('.ex-loading')).toBeNull()

    // the job that was writing it finishes afterwards
    await act(async () => {
      await library().saveContent(writing.id, '# Limite lateral\n\ntexto pronto', { status: 'ready' })
    })
    expect(library().files.find(file => file.id === writing.id)?.deletedAt).toBeTruthy()
    expect(marked(root())).toEqual([])
  })
})

describe('o clique numa marca nunca leva a um item da Lixeira', () => {
  it('uma marca que ainda está na tela quando a explicação é apagada não navega', async () => {
    const source = await note()
    const lateral = await explain(source.id, 'limite lateral')
    const root = await shown(source.id)
    await waitFor(() => expect(markOf(root(), 'limite lateral')).toBeTruthy())
    const stale = markOf(root(), 'limite lateral')!

    // the store already knows it is in the Lixeira, the screen has not repainted yet
    useLibraryStore.setState(state => ({ files: state.files.map(file => (file.id === lateral.id ? { ...file, deletedAt: new Date().toISOString() } : file)) }))
    fireEvent.click(stale)

    expect(screen.getByTestId('where')).toHaveTextContent(paths.file(source.id))
    expect(screen.queryByRole('menu')).toBeNull()
  })

  it('a marca de um trecho com duas explicações, uma na Lixeira, abre a que ficou', async () => {
    const source = await note()
    const first = await explain(source.id, 'derivada')
    const second = await library().createFile({ name: 'Explicação: derivada de novo', type: 'explanation', status: 'ready', folderId: null, parentFileId: source.id, sourceExcerpt: 'derivada' }, '# d\n\ntexto')
    const root = await shown(source.id)
    await waitFor(() => expect(markOf(root(), 'derivada')?.dataset.ids?.split(',')).toHaveLength(2))

    await act(async () => {
      await library().trashFiles([first.id])
    })
    await waitFor(() => expect(markOf(root(), 'derivada')?.dataset.ids).toBe(second.id))
    fireEvent.click(markOf(root(), 'derivada')!)
    await waitFor(() => expect(screen.getByTestId('where')).toHaveTextContent(paths.file(second.id)))
  })

  it('o menu de um trecho com duas explicações não lista a que foi para a Lixeira', async () => {
    const source = await note()
    const first = await explain(source.id, 'derivada')
    await library().createFile({ name: 'Explicação: derivada de novo', type: 'explanation', status: 'ready', folderId: null, parentFileId: source.id, sourceExcerpt: 'derivada' }, '# d\n\ntexto')
    const root = await shown(source.id)
    await waitFor(() => expect(markOf(root(), 'derivada')?.dataset.ids?.split(',')).toHaveLength(2))

    fireEvent.click(markOf(root(), 'derivada')!)
    const menu = await screen.findByRole('menu', { name: 'Escolha a explicação' })
    expect(within(menu).getByText('Explicação: derivada')).toBeInTheDocument()

    await act(async () => {
      await library().trashFiles([first.id])
    })
    await waitFor(() => expect(within(menu).queryByText('Explicação: derivada')).toBeNull())
    expect(within(menu).getByText('Explicação: derivada de novo')).toBeInTheDocument()
  })

  it('a explicação numa pasta da Lixeira não aparece no menu nem recebe o clique', async () => {
    const source = await note()
    const folder = await library().createFolder({ name: 'Antigas' })
    await explain(source.id, 'derivada', { folderId: folder.id })
    const live = await library().createFile({ name: 'Explicação: derivada de novo', type: 'explanation', status: 'ready', folderId: null, parentFileId: source.id, sourceExcerpt: 'derivada' }, '# d\n\ntexto')
    await library().trashFolder(folder.id)
    const root = await shown(source.id)
    await waitFor(() => expect(markOf(root(), 'derivada')).toBeTruthy())
    expect(markOf(root(), 'derivada')?.dataset.ids).toBe(live.id)

    fireEvent.click(markOf(root(), 'derivada')!)
    await waitFor(() => expect(screen.getByTestId('where')).toHaveTextContent(paths.file(live.id)))
    expect(screen.queryByRole('menu')).toBeNull()
  })
})
