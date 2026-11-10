// T120 (FR-074, SC-013): a busca procura na biblioteca toda, traz só o que tem o termo, destaca e diz onde achou; o clique leva ao trecho.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'

import type { FileMeta, FileSidecar, RecordingData, SourceMeta } from '@/types/domain'
import { useViewRoute } from '@/hooks/use-view-route'
import { markFound } from '@/lib/found-marks'
import type { Repository } from '@/lib/storage/repository'
import { ReaderWorkspace } from '@/pages/workspace/container/reader'
import { useLibraryStore } from '@/stores/library'
import { useUiStore } from '@/stores/ui'
import { FILES, seedLibrary } from '@/test/library/explorer-fixture'

const audio: SourceMeta = { input: 'recording', name: 'gravacao.webm', mime: 'audio/webm', durationSeconds: 2400, storage: 'none' }
const said: RecordingData = {
  blocks: [
    { speaker: 'mic', start: 12, end: 30, text: 'Bom dia, hoje é revisão.' },
    { speaker: 'mic', start: 95, end: 110, text: 'A assíntota vertical aparece quando o denominador zera.' },
  ],
  speakers: [{ id: 'mic', name: 'Você', suggested: false }],
  marks: [],
}
const TERCA: FileMeta = { ...FILES[0], id: 'aula-terca', name: 'Aula de terça', folderId: 'fis', role: 'entrada', kept: 'registro', tags: [], mastery: null, words: 9, origin: audio }

function withEntry() {
  const repo = useLibraryStore.getState().repo!
  const sidecar = { meta: TERCA, highlights: [], questions: [], attempts: [], transcript: said.blocks.map(block => block.text).join(' '), recording: said } as unknown as FileSidecar
  useLibraryStore.setState(state => ({
    files: [...state.files, TERCA],
    repo: { ...repo, readContent: async (id: string) => (id === TERCA.id ? '' : repo.readContent(id)), readSidecar: async (id: string) => (id === TERCA.id ? sidecar : repo.readSidecar(id)) } as Repository,
  }))
}

function Where() {
  const location = useLocation()
  return <output aria-label="rota">{`${location.pathname}${location.search}`}</output>
}

function Workspace() {
  return <ReaderWorkspace route={useViewRoute()} />
}

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/biblioteca/:folderId?" element={<Workspace />} />
        <Route path="/arquivo/:fileId" element={<Workspace />} />
        <Route path="/entrada/:fileId" element={<Workspace />} />
        <Route path="*" element={<Workspace />} />
      </Routes>
      <Where />
    </MemoryRouter>,
  )
}

beforeEach(() => {
  seedLibrary()
  withEntry()
  useUiStore.setState({ selection: new Set(), query: '', tag: null, lowMastery: false })
  // as in current Chromium, which returns a promise: an effect that returns it breaks the page
  Element.prototype.scrollIntoView = vi.fn(() => Promise.resolve()) as unknown as Element['scrollIntoView']
})

afterEach(() => {
  vi.restoreAllMocks()
})

const search = (value: string) => fireEvent.change(screen.getByRole('searchbox', { name: 'Buscar' }), { target: { value } })
const results = () => screen.getByRole('table', { name: 'Resultados da busca' })
const resultRows = () => within(results()).getAllByRole('row').slice(1)
const resultNames = () => resultRows().map(row => row.getAttribute('aria-label'))
const rowOf = (name: string) => within(results()).getByRole('row', { name })
const marks = (element: HTMLElement) => [...element.querySelectorAll('mark')].map(mark => mark.textContent)
const route = () => screen.getByRole('status', { name: 'rota' }).textContent

describe('a busca procura na biblioteca toda e traz só o que tem o termo (FR-074)', () => {
  it('de dentro de uma pasta, acha o que está em outras pastas, e nada que não tenha o termo', async () => {
    renderAt('/biblioteca/calc')
    search('laterais diferem')
    await waitFor(() => expect(resultNames()).toEqual(['Limites laterais e continuidade', 'Stewart, capítulo 2']))
    expect(screen.queryByRole('row', { name: 'Integrais' })).toBeNull()
    expect(screen.queryByRole('row', { name: 'Derivadas pela definição' })).toBeNull()
    expect(screen.getByText(/2 resultados/)).toBeInTheDocument()
  })

  it('todas as palavras precisam estar no item, sem ligar para acento e maiúscula', async () => {
    renderAt('/biblioteca/fis')
    search('LIMITE nao existe')
    await waitFor(() => expect(resultNames()).toEqual(['Limites laterais e continuidade', 'Monitoria de limites', 'Stewart, capítulo 2']))
  })

  it('sem nada com o termo, diz que não achou', async () => {
    renderAt('/biblioteca/calc')
    search('xilofone')
    expect(await screen.findByText(/Nada com “xilofone” na biblioteca/)).toBeInTheDocument()
  })

  it('quando são os filtros do painel que escondem tudo, diz isso, e não que a biblioteca não tem o termo', async () => {
    renderAt('/biblioteca/calc')
    fireEvent.click(screen.getByRole('checkbox', { name: /^derivadas\b/ }))
    search('laterais diferem')
    expect(await screen.findByText('Nada com “laterais diferem” com esses filtros.')).toBeInTheDocument()
  })

  it('apagar a busca volta à pasta', async () => {
    renderAt('/biblioteca/calc')
    search('laterais diferem')
    await waitFor(() => expect(resultRows()).toHaveLength(2))
    search('')
    await waitFor(() => expect(screen.getByRole('table', { name: 'Notas e pastas' })).toBeInTheDocument())
    expect(screen.queryByRole('table', { name: 'Resultados da busca' })).toBeNull()
  })
})

describe('o termo vem destacado, e a linha diz onde foi achado (FR-074, SC-013)', () => {
  it('no nome: o nome tem o termo marcado', async () => {
    renderAt('/biblioteca/calc')
    search('monitoria')
    await waitFor(() => expect(resultNames()).toEqual(['Monitoria de limites']))
    expect(marks(rowOf('Monitoria de limites').querySelector('.ex-name') as HTMLElement)).toEqual(['Monitoria'])
    expect(rowOf('Monitoria de limites')).toHaveTextContent('no nome')
  })

  it('no texto da nota: o trecho tem o termo marcado', async () => {
    renderAt('/biblioteca/calc')
    search('laterais diferem')
    await waitFor(() => expect(resultRows()).toHaveLength(2))
    const stewart = rowOf('Stewart, capítulo 2')
    expect(stewart).toHaveTextContent('na nota')
    expect(stewart).toHaveTextContent('Página 14: o limite não existe quando os laterais diferem.')
    expect(marks(stewart)).toEqual(['laterais', 'diferem'])
  })

  it('na transcrição de uma entrada: "na transcrição · mm:ss", com a fala e o termo marcado', async () => {
    renderAt('/biblioteca/calc')
    search('assintota vertical')
    await waitFor(() => expect(resultNames()).toEqual(['Aula de terça']))
    const terca = rowOf('Aula de terça')
    expect(terca).toHaveTextContent('na transcrição · 01:35')
    expect(terca).toHaveTextContent('A assíntota vertical aparece quando o denominador zera.')
    expect(marks(terca)).toEqual(['assíntota', 'vertical'])
  })

  it('todo resultado tem o termo destacado', async () => {
    renderAt('/biblioteca/calc')
    search('limite')
    await waitFor(() => expect(resultRows().length).toBeGreaterThan(2))
    for (const row of resultRows()) expect(marks(row).length).toBeGreaterThan(0)
  })
})

describe('o clique leva ao trecho (FR-074)', () => {
  it('numa entrada, abre a página da entrada naquela fala, marcada', async () => {
    renderAt('/biblioteca/calc')
    search('assintota')
    await waitFor(() => expect(resultNames()).toEqual(['Aula de terça']))
    fireEvent.click(rowOf('Aula de terça'))
    expect(route()).toBe('/entrada/aula-terca?t=95')
    const speech = await screen.findByText('A assíntota vertical aparece quando o denominador zera.')
    await waitFor(() => expect(speech.closest('li')).toHaveClass('tr-found'))
    expect(Element.prototype.scrollIntoView).toHaveBeenCalled()
    // leaving the page runs the clean-ups of its effects
    fireEvent.click(screen.getByRole('button', { name: /^Início/ }))
    expect(await screen.findByRole('region', { name: 'Últimas notas' })).toBeInTheDocument()
  })

  it('numa nota, abre a nota com o termo da busca', async () => {
    renderAt('/biblioteca/calc')
    search('laterais diferem')
    await waitFor(() => expect(resultRows()).toHaveLength(2))
    fireEvent.click(rowOf('Stewart, capítulo 2'))
    expect(route()).toBe('/arquivo/stewart?busca=laterais%20diferem')
    expect(await screen.findByRole('heading', { level: 1, name: 'Stewart, capítulo 2' })).toBeInTheDocument()
  })

  it('a nota aberta marca o termo no parágrafo do trecho e rola até ele', () => {
    const article = document.createElement('article')
    article.innerHTML = '<h2>Limites</h2><p>Os laterais aparecem aqui.</p><p>Página 14: o limite não existe quando os <em>laterais</em> diferem.</p>'
    const found = markFound(article, 'laterais diferem')
    expect(found?.tagName).toBe('P')
    expect(found?.textContent).toContain('Página 14')
    expect([...article.querySelectorAll('mark.hl-found')].map(mark => mark.textContent)).toEqual(['laterais', 'diferem'])
    expect(article.querySelectorAll('p')[0].querySelector('mark')).toBeNull()
  })
})
