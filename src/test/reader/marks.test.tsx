import { afterEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter, useLocation } from 'react-router-dom'

import { DocumentBody } from '@/components/reader/DocumentArticle'
import { paths } from '@/lib/paths'
import { useLibraryStore } from '@/stores/library'
import { studyLibrary } from '@/test/generation/study-fixture'

const CONTENT = [
  '# Limites',
  '',
  'O limite lateral define a continuidade. A derivada usa limite lateral.',
  '',
  'Depois vem a integral. Revise a derivada antes da prova.',
].join('\n')

function Where() {
  return <div data-testid="where">{useLocation().pathname}</div>
}

async function noteWithExplanations() {
  studyLibrary()
  const library = useLibraryStore.getState()
  const source = await library.createFile({ name: 'Limites', type: 'class', status: 'ready', folderId: null }, CONTENT)
  const explain = (name: string, excerpt: string) =>
    useLibraryStore.getState().createFile({ name, type: 'explanation', status: 'ready', folderId: null, parentFileId: source.id, sourceExcerpt: excerpt }, `# ${name}\n\ntexto`)
  // Criadas fora da ordem em que aparecem no texto.
  const integral = await explain('Explicação: integral', 'integral')
  const derivada = await explain('Explicação: derivada', 'derivada')
  const lateral = await explain('Explicação: limite lateral', 'limite lateral')
  const derivada2 = await explain('Explicação: derivada de novo', 'derivada')
  const at = new Date().toISOString()
  await useLibraryStore.getState().saveHighlight(source.id, { id: 'h1', kind: 'highlight', quote: 'continuidade', text: '', color: 'yellow', startOffset: null, endOffset: null, createdAt: at, updatedAt: at })
  return { source: source.id, integral: integral.id, derivada: derivada.id, lateral: lateral.id, derivada2: derivada2.id }
}

async function shown(fileId: string): Promise<ShadowRoot> {
  render(
    <MemoryRouter initialEntries={[paths.file(fileId)]}>
      <DocumentBody fileId={fileId} />
      <Where />
    </MemoryRouter>,
  )
  let root: ShadowRoot | null = null
  await waitFor(() => {
    root = document.querySelector('[data-testid="github-viewer"]')?.shadowRoot ?? null
    expect(root?.querySelector('mark.ex-strong')).toBeTruthy()
  })
  return root as unknown as ShadowRoot
}

const markOf = (root: ShadowRoot, cls: string, text: string) => [...root.querySelectorAll<HTMLElement>(`mark.${cls}`)].find(mark => mark.textContent?.toLowerCase() === text)

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('marcas de explicação no texto', () => {
  it('o lugar exato fica forte, as repetições fracas, e a cor segue a ordem em que o trecho aparece', async () => {
    const ids = await noteWithExplanations()
    const root = await shown(ids.source)

    const lateral = markOf(root, 'ex-strong', 'limite lateral')
    const derivada = markOf(root, 'ex-strong', 'derivada')
    const integral = markOf(root, 'ex-strong', 'integral')
    expect(lateral?.getAttribute('style')).toContain('--ex: var(--ex-0-strong)')
    expect(lateral?.getAttribute('style')).toContain('--exbg: var(--ex-0-soft)')
    expect(derivada?.getAttribute('style')).toContain('--ex: var(--ex-1-strong)')
    expect(integral?.getAttribute('style')).toContain('--ex: var(--ex-2-strong)')

    // Uma só marca forte por trecho; as demais ocorrências são fracas, com a mesma cor.
    expect(root.querySelectorAll('mark.ex-strong')).toHaveLength(3)
    const weakLateral = markOf(root, 'ex-weak', 'limite lateral')
    const weakDerivada = markOf(root, 'ex-weak', 'derivada')
    expect(weakLateral?.getAttribute('style')).toContain('--ex: var(--ex-0-weak)')
    expect(weakDerivada?.getAttribute('style')).toContain('--ex: var(--ex-1-weak)')

    // Os dois trechos com explicações ligadas levam os ids; o destaque amarelo continua.
    expect(derivada?.dataset.ids?.split(',').sort()).toEqual([ids.derivada, ids.derivada2].sort())
    expect(lateral?.dataset.ids).toBe(ids.lateral)
    expect(root.textContent).toContain('continuidade')
    expect([...root.querySelectorAll('mark')].some(mark => mark.textContent === 'continuidade' && !mark.classList.contains('ex-mark'))).toBe(true)
  })

  it('tocar numa palavra com duas explicações mostra um menu com as duas, e cada uma abre a sua', async () => {
    const ids = await noteWithExplanations()
    const root = await shown(ids.source)

    fireEvent.click(markOf(root, 'ex-strong', 'derivada')!)
    let menu = await screen.findByRole('menu', { name: 'Escolha a explicação' })
    expect(within(menu).getByText('2 explicações neste trecho')).toBeInTheDocument()
    expect(within(menu).getByText('Explicação: derivada')).toBeInTheDocument()
    expect(within(menu).getByText('Explicação: derivada de novo')).toBeInTheDocument()

    fireEvent.click(within(menu).getByText('Explicação: derivada'))
    await waitFor(() => expect(screen.getByTestId('where')).toHaveTextContent(paths.file(ids.derivada)))

    fireEvent.click(markOf(root, 'ex-weak', 'derivada')!)
    menu = await screen.findByRole('menu', { name: 'Escolha a explicação' })
    fireEvent.click(within(menu).getByText('Explicação: derivada de novo'))
    await waitFor(() => expect(screen.getByTestId('where')).toHaveTextContent(paths.file(ids.derivada2)))
  })
})
