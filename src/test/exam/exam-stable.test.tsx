// 25/11 ("Prova também está bugado: o resultado aparece em ordem diferente das questões da prova; a alternativa que eu marquei foi
// contabilizada outra; a porcentagem ficou sambando até parar em 14%"): a prova sorteava a ordem e as letras de novo sempre que a nota
// era lida outra vez (ao gravar o resultado no App, a nota volta como outra lista com as mesmas questões). As respostas guardam a letra
// clicada, que passava a apontar para outra alternativa, e a nota mudava a cada leitura. O sorteio é um por prova: só "Refazer" sorteia.
import '@/test/account/storage-shim'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'

import type { FileSidecar, StoredQuestion } from '@/types/domain'
import { ExamDialog } from '@/components/dialogs/ExamDialog'
import type { Repository } from '@/lib/storage/repository'
import { useLibraryStore } from '@/stores/library'
import { useUiStore } from '@/stores/ui'
import { studyLibrary, studyNote } from '@/test/generation/study-fixture'

const question = (storedId: string, n: number): StoredQuestion => ({
  storedId,
  tipo: 'unica',
  enunciado: `Pergunta ${n}`,
  alternativas: { A: `Alfa ${n}`, B: `Beta ${n}`, C: `Gama ${n}`, D: `Delta ${n}`, E: `Epsilon ${n}` },
  correta: 'A',
  explicacao: `Porque ${n}.`,
})

const QUESTIONS = Array.from({ length: 6 }, (_, index) => question(`s${index + 1}`, index + 1))

function Host() {
  const overlay = useUiStore(state => state.overlay)
  return overlay?.kind === 'exam' ? <ExamDialog fileId={overlay.fileId} /> : null
}

const boxes = () => [...document.querySelectorAll<HTMLElement>('.q')]
const statements = () => boxes().map(box => box.querySelector('.qh')?.textContent)
const layout = () => boxes().map(box => `${box.querySelector('.qh')?.textContent}|${[...box.querySelectorAll('.ans button')].map(button => button.textContent).join(',')}`)
/** Clicks, in each question, the alternative with this word (Alfa is the right one, Beta a wrong one). */
const mark = (box: HTMLElement, word: string) => fireEvent.click([...box.querySelectorAll<HTMLElement>('.ans button')].find(button => button.textContent?.includes(word))!)
const submit = () => fireEvent.click(within(document.querySelector<HTMLElement>('.dh')!).getByRole('button', { name: 'Entregar prova' }))

/** The note read again, as the App gives it back: the same questions, in another list. */
const readAgain = (id: string) =>
  act(() =>
    useLibraryStore.setState(state => {
      const opened = state.opened[id]
      return { opened: { ...state.opened, [id]: { ...opened, sidecar: JSON.parse(JSON.stringify(opened.sidecar)) as FileSidecar } } }
    }),
  )

beforeEach(() => {
  localStorage.clear()
  studyLibrary()
  useLibraryStore.setState(state => ({ index: { ...state.index, settings: { ...state.index.settings, examOneAtATime: false } } }))
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('Prova: um sorteio por prova', () => {
  it('a nota lida de novo no meio da prova não muda a ordem, as letras nem o que foi marcado', async () => {
    const id = await studyNote()
    await useLibraryStore.getState().updateSidecar(id, sidecar => ({ ...sidecar, questions: QUESTIONS }))
    render(<Host />)
    act(() => useUiStore.getState().open({ kind: 'exam', fileId: id }))
    await screen.findByText('0 de 6 respondidas')
    const before = layout()
    boxes().forEach(box => mark(box, 'Alfa'))
    readAgain(id)
    expect(layout()).toEqual(before)
    expect(screen.getByText('6 de 6 respondidas')).toBeInTheDocument()
  })

  it('ao entregar, com a nota voltando do App como outra lista: o resultado na mesma ordem, contando o que foi marcado', async () => {
    const id = await studyNote()
    await useLibraryStore.getState().updateSidecar(id, sidecar => ({ ...sidecar, questions: QUESTIONS }))
    // the App gives the saved note back as a new object, with the questions in a new list
    const repo = useLibraryStore.getState().repo!
    const save = repo.saveFile.bind(repo)
    useLibraryStore.setState({ repo: { ...repo, saveFile: async (sidecar: FileSidecar, content?: string) => JSON.parse(JSON.stringify(await save(sidecar, content))) as FileSidecar } as Repository })
    render(<Host />)
    act(() => useUiStore.getState().open({ kind: 'exam', fileId: id }))
    await screen.findByText('0 de 6 respondidas')
    const order = statements()
    // four right, two wrong
    boxes().forEach((box, index) => mark(box, index < 4 ? 'Alfa' : 'Beta'))
    submit()
    await screen.findByText(/6 feitas: 4 certas, 2 erradas/)
    readAgain(id)
    expect(statements()).toEqual(order)
    expect(document.querySelector('.score')?.textContent).toBe('67%')
    expect(screen.getByText(/6 feitas: 4 certas, 2 erradas/)).toBeInTheDocument()
    // what is kept in the note is what was marked: Alfa (A) in the first four, Beta (B) in the last two
    const attempt = useLibraryStore.getState().opened[id].sidecar.attempts.at(-1)!
    const byStatement = new Map(QUESTIONS.map(item => [item.storedId, item.enunciado]))
    const given = new Map(attempt.answers.map(answer => [byStatement.get(answer.questionId), answer.answer]))
    expect(order.map(text => given.get(text!.replace(/^\d+/, '').trim()))).toEqual(['A', 'A', 'A', 'A', 'B', 'B'])
  })
})
