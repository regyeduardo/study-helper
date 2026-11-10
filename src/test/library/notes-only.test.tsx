import { beforeEach, describe, expect, it } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

import type { FileMeta, FileSidecar, StoredQuestion } from '@/types/domain'
import { CommandPalette } from '@/components/dialogs/CommandPalette'
import { FolderExamDialog } from '@/components/dialogs/ExamDialog'
import { today } from '@/lib/generation/cards'
import { useLibraryStore } from '@/stores/library'
import { FILES, renderAt, seedLibrary } from '@/test/library/explorer-fixture'

const ENTRY_NAME = 'Gravação do corredor'
const SAID = 'O limite não existe quando os laterais diferem.'

function question(storedId: string): StoredQuestion {
  return { storedId, enunciado: `Pergunta ${storedId}`, alternativas: { a: '1', b: '2' }, correta: 'a', explicacao: '' }
}

/** An entrada that would show up everywhere if it counted as a note: low mastery, cards due, untranscribed media, questions. */
const entry: FileMeta = {
  ...FILES[0],
  id: 'entrada-corredor',
  name: ENTRY_NAME,
  role: 'entrada',
  kept: 'arquivo',
  tags: [],
  mastery: 40,
  cardDue: [today()],
  words: 0,
  origin: { input: 'recording', name: 'corredor.webm', mime: 'audio/webm', durationSeconds: 120, storage: 'none' },
  updated: { at: '2026-11-07T10:00:00Z', deviceId: 'local', deviceName: 'Este computador' },
}

const opened = (meta: FileMeta, content: string, questions: StoredQuestion[] = []) => ({ content, sidecar: { meta, questions, attempts: [], highlights: [] } as FileSidecar })

beforeEach(() => {
  seedLibrary()
  useLibraryStore.setState(state => ({ files: [...state.files, entry], opened: { [entry.id]: opened(entry, SAID, [question('e1'), question('e2'), question('e3')]) } }))
})

const rows = () => within(screen.getByRole('table', { name: 'Notas e pastas' })).getAllByRole('row').slice(1)
const entryRow = () => rows().find(row => row.textContent?.includes(ENTRY_NAME))

describe('revisão, painel inicial, busca por conteúdo e prova consideram só notas', () => {
  // "Gravações sem transcrição" lists it (FR-053): explorer-search.test.tsx
  it('o painel inicial não mostra a entrada em nenhum bloco de notas', () => {
    renderAt('/')
    const blocks = ['Para revisar', 'Cartões para hoje', 'Últimas notas'].map(name => screen.queryByRole('region', { name })?.textContent ?? '')
    expect(blocks.join(' ')).not.toContain(ENTRY_NAME)
    expect(blocks[2]).toContain('Limites laterais e continuidade')
  })

  it('"Para revisar" não lista nem conta a entrada', () => {
    renderAt('/revisar')
    expect(entryRow()).toBeUndefined()
    expect(within(screen.getByRole('complementary', { name: 'Navegação' })).getByRole('button', { name: /Para revisar/ })).toHaveTextContent(/^Para revisar0$/)
  })

  it('a busca não acha a entrada pelo conteúdo, só pelo nome', async () => {
    renderAt('/biblioteca/calc')
    const search = screen.getByRole('searchbox', { name: 'Buscar' })
    const found = () => within(screen.getByRole('table', { name: 'Resultados da busca' })).getAllByRole('row').slice(1)
    fireEvent.change(search, { target: { value: 'limite não existe' } })
    await waitFor(() => expect(found()).toHaveLength(3))
    expect(found().some(row => row.textContent?.includes(ENTRY_NAME))).toBe(false)
    fireEvent.change(search, { target: { value: 'corredor' } })
    await waitFor(() => expect(found().map(row => row.getAttribute('aria-label'))).toEqual([ENTRY_NAME]))
  })

  it('a paleta não acha a entrada pelo conteúdo, só pelo nome', () => {
    render(
      <MemoryRouter>
        <CommandPalette />
      </MemoryRouter>,
    )
    const input = screen.getByRole('textbox', { name: 'Buscar arquivos, pastas e ações' })
    fireEvent.change(input, { target: { value: 'laterais diferem' } })
    expect(screen.queryByText(ENTRY_NAME)).toBeNull()
    fireEvent.change(input, { target: { value: 'corredor' } })
    expect(screen.getByText(ENTRY_NAME)).toBeInTheDocument()
  })

  it('a prova da pasta não junta as questões da entrada', async () => {
    useLibraryStore.setState(state => ({ opened: { ...state.opened, limites: opened(FILES[0], '# Limites', [question('n1'), question('n2')]) } }))
    render(
      <MemoryRouter>
        <FolderExamDialog folderId="calc" />
      </MemoryRouter>,
    )
    expect(await screen.findByText(/Quantas questões\?/)).toHaveTextContent('Quantas questões? (2 disponíveis)')
  })
})
