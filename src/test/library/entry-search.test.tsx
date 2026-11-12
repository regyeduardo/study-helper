// A lista de Entradas tem a mesma busca das pastas: só as entradas com o termo, o termo destacado, e o clique leva à fala achada.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'

import type { FileMeta, FileSidecar, RecordingData, SourceMeta } from '@/types/domain'
import { useViewRoute } from '@/hooks/use-view-route'
import type { Repository } from '@/lib/storage/repository'
import { ReaderWorkspace } from '@/pages/workspace/container/reader'
import { useLibraryStore } from '@/stores/library'
import { useUiStore } from '@/stores/ui'
import { FILES, seedLibrary } from '@/test/library/explorer-fixture'

const audio: SourceMeta = { input: 'recording', name: 'gravacao.webm', mime: 'audio/webm', durationSeconds: 2400, storage: 'none' }
const pdf: SourceMeta = { input: 'file', name: 'contrato.pdf', mime: 'application/pdf', storage: 'none' }
const said: RecordingData = {
  blocks: [
    { speaker: 'mic', start: 12, end: 30, text: 'Bom dia, hoje é revisão.' },
    { speaker: 'mic', start: 95, end: 110, text: 'A assíntota vertical aparece quando o denominador zera.' },
  ],
  speakers: [{ id: 'mic', name: 'Você', suggested: false }],
  marks: [],
}
const TERCA: FileMeta = { ...FILES[0], id: 'aula-terca', name: 'Aula de terça', folderId: 'fis', role: 'entrada', kept: 'registro', tags: [], mastery: null, words: 9, origin: audio }
const CONTRATO: FileMeta = { ...FILES[0], id: 'contrato', name: 'Contrato do fornecedor', folderId: 'fis', role: 'entrada', kept: 'registro', tags: [], mastery: null, words: 4, origin: pdf }

function withEntries() {
  const repo = useLibraryStore.getState().repo!
  const sidecars: Record<string, FileSidecar> = {
    [TERCA.id]: { meta: TERCA, highlights: [], questions: [], attempts: [], transcript: said.blocks.map(block => block.text).join(' '), recording: said } as unknown as FileSidecar,
    [CONTRATO.id]: { meta: CONTRATO, highlights: [], questions: [], attempts: [] } as unknown as FileSidecar,
  }
  const contents: Record<string, string> = { [TERCA.id]: '', [CONTRATO.id]: 'Cláusula 3: o pagamento é mensal.' }
  useLibraryStore.setState(state => ({
    files: [...state.files, TERCA, CONTRATO],
    repo: { ...repo, readContent: async (id: string) => (id in contents ? contents[id] : repo.readContent(id)), readSidecar: async (id: string) => sidecars[id] ?? repo.readSidecar(id) } as Repository,
  }))
}

function Where() {
  const location = useLocation()
  return <output aria-label="rota">{`${location.pathname}${location.search}`}</output>
}

function Workspace() {
  return <ReaderWorkspace route={useViewRoute()} />
}

function renderEntries() {
  return render(
    <MemoryRouter initialEntries={['/entradas']}>
      <Routes>
        <Route path="/entrada/:fileId" element={<Workspace />} />
        <Route path="*" element={<Workspace />} />
      </Routes>
      <Where />
    </MemoryRouter>,
  )
}

beforeEach(() => {
  seedLibrary()
  withEntries()
  useUiStore.setState({ selection: new Set(), query: '', tag: null, lowMastery: false })
  Element.prototype.scrollIntoView = vi.fn(() => Promise.resolve()) as unknown as Element['scrollIntoView']
})

afterEach(() => {
  vi.restoreAllMocks()
})

const search = (value: string) => fireEvent.change(screen.getByRole('searchbox', { name: 'Buscar' }), { target: { value } })
const table = () => screen.getByRole('table', { name: 'Entradas' })
const names = () => within(table()).getAllByRole('row').slice(1).map(row => row.getAttribute('aria-label'))
const found = () => document.querySelector('.ex-found')
const marks = (element: HTMLElement) => [...element.querySelectorAll('mark')].map(mark => mark.textContent)

describe('busca na lista de Entradas', () => {
  it('tem a caixa "Buscar"; sem termo, mostra todas as entradas', async () => {
    renderEntries()
    expect(screen.getByRole('searchbox', { name: 'Buscar' })).toBeInTheDocument()
    expect(names().sort()).toEqual(['Aula de terça', 'Contrato do fornecedor'])
  })

  it('pelo que foi dito: só a entrada com o termo, a fala com o termo marcado, e o clique leva à fala', async () => {
    renderEntries()
    search('assintota vertical')
    await waitFor(() => expect(names()).toEqual(['Aula de terça']))
    const row = within(table()).getByRole('row', { name: 'Aula de terça' })
    expect(row).toHaveTextContent('na transcrição · 01:35')
    expect(marks(row)).toEqual(['assíntota', 'vertical'])
    expect(found()).toHaveTextContent('1 resultado para “assintota vertical”')
    fireEvent.click(within(row).getByText('Aula de terça'))
    await waitFor(() => expect(screen.getByLabelText('rota')).toHaveTextContent('/entrada/aula-terca?t=95'))
  })

  it('pelo nome e pelo conteúdo, só entre as entradas: uma nota com o termo não entra', async () => {
    renderEntries()
    search('fornecedor')
    await waitFor(() => expect(names()).toEqual(['Contrato do fornecedor']))
    search('limite')
    await waitFor(() => expect(found()).toHaveTextContent('Nada com “limite” nas entradas.'))
  })

  it('sem resultado: fica só a frase, sem o cabeçalho de uma tabela vazia; apagar a busca traz a tabela de volta', async () => {
    renderEntries()
    search('limite')
    await waitFor(() => expect(found()).toHaveTextContent('Nada com “limite” nas entradas.'))
    expect(screen.queryByRole('table')).not.toBeInTheDocument()
    search('')
    await waitFor(() => expect(names().sort()).toEqual(['Aula de terça', 'Contrato do fornecedor']))
  })

  it('apagar a busca volta à lista inteira', async () => {
    renderEntries()
    search('fornecedor')
    await waitFor(() => expect(names()).toEqual(['Contrato do fornecedor']))
    search('')
    await waitFor(() => expect(names().sort()).toEqual(['Aula de terça', 'Contrato do fornecedor']))
  })
})
