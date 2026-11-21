import '@/test/account/storage-shim'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'

import type { StoredQuestion } from '@/types/domain'
import { ExamDialog, FolderExamDialog } from '@/components/dialogs/ExamDialog'
import { useJobsStore } from '@/stores/jobs'
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
  if (overlay?.kind === 'exam') return <ExamDialog fileId={overlay.fileId} />
  if (overlay?.kind === 'folder-exam') return <FolderExamDialog folderId={overlay.folderId} fileIds={overlay.fileIds} />
  return null
}

const setOneAtATime = (on: boolean) => useLibraryStore.setState(state => ({ index: { ...state.index, settings: { ...state.index.settings, examOneAtATime: on } } }))

async function withQuestions(questions = QUESTIONS, folderId: string | null = null): Promise<string> {
  const id = folderId ? (await useLibraryStore.getState().createFile({ name: `Nota ${folderId}`, type: 'class', status: 'ready', folderId }, '# Nota\n\ntexto')).id : await studyNote()
  await useLibraryStore.getState().updateSidecar(id, sidecar => ({ ...sidecar, questions }))
  return id
}

const openExam = (fileId: string) => act(() => useUiStore.getState().open({ kind: 'exam', fileId }))
const escape = () => act(() => void fireEvent.keyDown(window, { key: 'Escape' }))
const draftKeys = () => Object.keys(localStorage).filter(key => key.includes('exam-draft'))

/** Statement and alternatives of each question as drawn: the order of the questions and of the alternatives. */
const layout = () => [...document.querySelectorAll('.q')].map(box => `${box.querySelector('.qh')?.textContent}|${[...box.querySelectorAll('.ans button')].map(button => button.textContent).join(',')}`)
const boxes = () => [...document.querySelectorAll<HTMLElement>('.q')]
const alternative = (box: HTMLElement, position: number) => box.querySelectorAll<HTMLElement>('.ans button')[position]
const submit = () => fireEvent.click(within(document.querySelector<HTMLElement>('.dh')!).getByRole('button', { name: 'Entregar prova' }))
const fromMenu = (name: RegExp) => {
  fireEvent.click(screen.getByRole('button', { name: 'Mais' }))
  fireEvent.click(screen.getByRole('menuitem', { name }))
}
const stoppedLine = () => screen.queryByText(/^Você parou na questão/)

beforeEach(() => {
  localStorage.clear()
  studyLibrary()
  setOneAtATime(false)
})

const jobs = useJobsStore.getState()

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  useJobsStore.setState({ createQuestions: jobs.createQuestions })
})

describe('Prova: o progresso sobrevive a fechar a janela', () => {
  it('Esc fecha, e ao abrir de novo a ordem, as alternativas, as respostas e a certeza estão como estavam', async () => {
    const id = await withQuestions()
    render(<Host />)
    openExam(id)
    await screen.findByText('0 de 6 respondidas')
    const before = layout()
    const marked = [alternative(boxes()[0], 1), alternative(boxes()[1], 3)]
    const markedText = marked.map(button => button.textContent)
    marked.forEach(button => fireEvent.click(button))
    fireEvent.click(within(boxes()[0]).getByRole('button', { name: 'Alta' }))
    expect(screen.getByText('2 de 6 respondidas')).toBeInTheDocument()

    escape()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    openExam(id)
    await screen.findByText('2 de 6 respondidas')

    expect(layout()).toEqual(before)
    expect(alternative(boxes()[0], 1)).toHaveAttribute('aria-pressed', 'true')
    expect(alternative(boxes()[0], 1).textContent).toBe(markedText[0])
    expect(alternative(boxes()[1], 3)).toHaveAttribute('aria-pressed', 'true')
    expect(alternative(boxes()[2], 0)).toHaveAttribute('aria-pressed', 'false')
    expect(within(boxes()[0]).getByRole('button', { name: 'Alta' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByText('Você parou na questão 3 de 6')).toBeInTheDocument()
  })

  it('clicar fora da janela e o X também guardam', async () => {
    const id = await withQuestions()
    render(<Host />)
    openExam(id)
    await screen.findByText('0 de 6 respondidas')
    fireEvent.click(alternative(boxes()[0], 0))
    fireEvent.click(screen.getByRole('button', { name: 'Fechar' }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    openExam(id)
    await screen.findByText('1 de 6 respondidas')
    fireEvent.click(alternative(boxes()[1], 0))
    fireEvent.mouseDown(document.querySelector('.scrim')!)
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    openExam(id)
    await screen.findByText('2 de 6 respondidas')
    expect(draftKeys()).toHaveLength(1)
  })

  it('uma por vez: volta na questão em que estava, com o modo, mesmo que a configuração tenha mudado', async () => {
    setOneAtATime(true)
    const id = await withQuestions()
    render(<Host />)
    openExam(id)
    await screen.findByText('1 de 6')
    const first = layout()[0]
    fireEvent.click(alternative(boxes()[0], 2))
    fireEvent.click(screen.getByRole('button', { name: /Próxima/ }))
    const second = layout()[0]
    fireEvent.click(alternative(boxes()[0], 4))
    fireEvent.click(screen.getByRole('button', { name: /Próxima/ }))
    fireEvent.click(screen.getByRole('button', { name: /Próxima/ }))
    const fourth = layout()[0]
    expect(screen.getByText('4 de 6')).toBeInTheDocument()

    escape()
    setOneAtATime(false)
    openExam(id)
    await screen.findByText('Você parou na questão 4 de 6')
    expect(screen.getByText('4 de 6')).toBeInTheDocument()
    expect(boxes()).toHaveLength(1)
    expect(layout()[0]).toBe(fourth)
    fireEvent.click(screen.getByRole('button', { name: /Anterior/ }))
    fireEvent.click(screen.getByRole('button', { name: /Anterior/ }))
    expect(layout()[0]).toBe(second)
    expect(alternative(boxes()[0], 4)).toHaveAttribute('aria-pressed', 'true')
    fireEvent.click(screen.getByRole('button', { name: /Anterior/ }))
    expect(layout()[0]).toBe(first)
    expect(alternative(boxes()[0], 2)).toHaveAttribute('aria-pressed', 'true')
  })

  it('a linha some quando a pessoa continua (responde ou muda de questão)', async () => {
    const id = await withQuestions()
    render(<Host />)
    openExam(id)
    await screen.findByText('0 de 6 respondidas')
    fireEvent.click(alternative(boxes()[0], 0))
    escape()
    openExam(id)
    expect(await screen.findByText('Você parou na questão 2 de 6')).toBeInTheDocument()
    fireEvent.click(alternative(boxes()[1], 0))
    expect(stoppedLine()).not.toBeInTheDocument()
  })

  it('"Começar de novo" apaga o rascunho: tudo em branco, sem a linha, e fechar não deixa nada guardado', async () => {
    const id = await withQuestions()
    render(<Host />)
    openExam(id)
    await screen.findByText('0 de 6 respondidas')
    fireEvent.click(alternative(boxes()[0], 0))
    fireEvent.click(alternative(boxes()[1], 0))
    escape()
    openExam(id)
    await screen.findByText('2 de 6 respondidas')

    fireEvent.click(screen.getByRole('button', { name: 'Começar de novo' }))
    expect(screen.getByText('0 de 6 respondidas')).toBeInTheDocument()
    expect(stoppedLine()).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Começar de novo' })).not.toBeInTheDocument()
    expect(boxes().every(box => [...box.querySelectorAll('.ans button')].every(button => button.getAttribute('aria-pressed') === 'false'))).toBe(true)
    expect(draftKeys()).toHaveLength(0)

    escape()
    openExam(id)
    await screen.findByText('0 de 6 respondidas')
    expect(stoppedLine()).not.toBeInTheDocument()
  })

  it('"Entregar" apaga o rascunho: depois do resultado, abrir de novo é uma prova nova', async () => {
    const id = await withQuestions()
    render(<Host />)
    openExam(id)
    await screen.findByText('0 de 6 respondidas')
    fireEvent.click(alternative(boxes()[0], 0))
    expect(draftKeys()).toHaveLength(1)
    submit()
    expect(await screen.findByText(/feita/)).toBeInTheDocument()
    expect(draftKeys()).toHaveLength(0)
    fireEvent.click(screen.getByRole('button', { name: 'Concluir' }))
    openExam(id)
    await screen.findByText('0 de 6 respondidas')
    expect(stoppedLine()).not.toBeInTheDocument()
  })

  it('no resultado, Esc não deixa rascunho; "Refazer" começa em branco e guarda só o que a pessoa fizer depois', async () => {
    const id = await withQuestions()
    render(<Host />)
    openExam(id)
    await screen.findByText('0 de 6 respondidas')
    fireEvent.click(alternative(boxes()[0], 0))
    submit()
    await screen.findByText(/feita/)
    fireEvent.click(screen.getByRole('button', { name: 'Refazer' }))
    expect(screen.getByText('0 de 6 respondidas')).toBeInTheDocument()
    expect(draftKeys()).toHaveLength(0)
    fireEvent.click(alternative(boxes()[0], 0))
    expect(draftKeys()).toHaveLength(1)
  })

  it('"Sair sem salvar" fecha e apaga o rascunho', async () => {
    const id = await withQuestions()
    render(<Host />)
    openExam(id)
    await screen.findByText('0 de 6 respondidas')
    fireEvent.click(alternative(boxes()[0], 0))
    expect(draftKeys()).toHaveLength(1)
    fromMenu(/Sair sem salvar/)
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(draftKeys()).toHaveLength(0)
    openExam(id)
    await screen.findByText('0 de 6 respondidas')
    expect(stoppedLine()).not.toBeInTheDocument()
  })

  it('abrir e não fazer nada não guarda nada', async () => {
    const id = await withQuestions()
    render(<Host />)
    openExam(id)
    await screen.findByText('0 de 6 respondidas')
    escape()
    expect(draftKeys()).toHaveLength(0)
  })

  it('se as questões mudaram (outra prova gerada), o rascunho é descartado e a prova começa em branco', async () => {
    const id = await withQuestions()
    render(<Host />)
    openExam(id)
    await screen.findByText('0 de 6 respondidas')
    fireEvent.click(alternative(boxes()[0], 0))
    escape()
    await useLibraryStore.getState().updateSidecar(id, sidecar => ({ ...sidecar, questions: [...QUESTIONS.slice(1), question('novo', 7)] }))
    openExam(id)
    await screen.findByText('0 de 6 respondidas')
    expect(stoppedLine()).not.toBeInTheDocument()
    expect(draftKeys()).toHaveLength(0)
  })

  it('"Gerar outras questões" também deixa o rascunho antigo para trás', async () => {
    const id = await withQuestions()
    render(<Host />)
    openExam(id)
    await screen.findByText('0 de 6 respondidas')
    fireEvent.click(alternative(boxes()[0], 0))
    expect(draftKeys()).toHaveLength(1)
    // never reaches an AI: the new questions do not come in this test
    useJobsStore.setState({ createQuestions: vi.fn(() => new Promise<never>(() => undefined)) })
    fromMenu(/Gerar outras questões/)
    // the model comes first; going back would still find the exam as it was
    expect(draftKeys()).toHaveLength(1)
    fireEvent.click(screen.getByRole('button', { name: 'Gerar outras questões' }))
    expect(draftKeys()).toHaveLength(0)
  })

  it('cada arquivo tem a sua prova guardada', async () => {
    const one = await withQuestions()
    const two = await withQuestions(QUESTIONS.map((item, index) => ({ ...item, storedId: `o${index}` })))
    render(<Host />)
    openExam(one)
    await screen.findByText('0 de 6 respondidas')
    fireEvent.click(alternative(boxes()[0], 0))
    escape()
    openExam(two)
    await screen.findByText('0 de 6 respondidas')
    expect(stoppedLine()).not.toBeInTheDocument()
    escape()
    openExam(one)
    await screen.findByText('1 de 6 respondidas')
  })

  it('sem armazenamento no navegador a prova funciona do mesmo jeito', async () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new DOMException('bloqueado', 'SecurityError')
    })
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('cheio', 'QuotaExceededError')
    })
    vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => {
      throw new DOMException('bloqueado', 'SecurityError')
    })
    const id = await withQuestions()
    render(<Host />)
    openExam(id)
    await screen.findByText('0 de 6 respondidas')
    fireEvent.click(alternative(boxes()[0], 0))
    expect(screen.getByText('1 de 6 respondidas')).toBeInTheDocument()
    submit()
    expect(await screen.findByText(/feita/)).toBeInTheDocument()
  })
})

describe('Prova da pasta: o progresso também fica guardado', () => {
  async function folderWithQuestions() {
    const folder = await useLibraryStore.getState().createFolder({ name: 'Cálculo' })
    await withQuestions(QUESTIONS.slice(0, 3), folder.id)
    await withQuestions(QUESTIONS.slice(3).map(item => ({ ...item, storedId: `b-${item.storedId}` })), folder.id)
    return folder.id
  }
  const openFolder = (folderId: string) => act(() => useUiStore.getState().open({ kind: 'folder-exam', folderId }))

  it('depois de escolher quantas, Esc guarda; ao abrir de novo volta direto na prova, sem perguntar quantas', async () => {
    const folderId = await folderWithQuestions()
    render(<Host />)
    openFolder(folderId)
    fireEvent.change(await screen.findByLabelText(/Quantas questões/), { target: { value: '4' } })
    fireEvent.click(screen.getByRole('button', { name: 'Começar' }))
    await screen.findByText('0 de 4 respondidas')
    const before = layout()
    fireEvent.click(alternative(boxes()[1], 2))
    escape()

    openFolder(folderId)
    await screen.findByText('1 de 4 respondidas')
    expect(screen.queryByLabelText(/Quantas questões/)).not.toBeInTheDocument()
    expect(layout()).toEqual(before)
    expect(alternative(boxes()[1], 2)).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByText('Você parou na questão 1 de 4')).toBeInTheDocument()
  })

  it('"Sair sem salvar" na pasta apaga: abrir de novo pergunta quantas questões', async () => {
    const folderId = await folderWithQuestions()
    render(<Host />)
    openFolder(folderId)
    fireEvent.click(await screen.findByRole('button', { name: /Todas/ }))
    await screen.findByText('0 de 6 respondidas')
    fireEvent.click(alternative(boxes()[0], 0))
    fromMenu(/Sair sem salvar/)
    openFolder(folderId)
    expect(await screen.findByLabelText(/Quantas questões/)).toBeInTheDocument()
  })

  it('se uma questão do rascunho não existe mais na pasta, o rascunho não volta', async () => {
    const folderId = await folderWithQuestions()
    render(<Host />)
    openFolder(folderId)
    fireEvent.click(await screen.findByRole('button', { name: /Todas/ }))
    await screen.findByText('0 de 6 respondidas')
    fireEvent.click(alternative(boxes()[0], 0))
    escape()
    const file = useLibraryStore.getState().files.find(item => item.folderId === folderId)!
    await useLibraryStore.getState().updateSidecar(file.id, sidecar => ({ ...sidecar, questions: sidecar.questions.slice(1) }))
    openFolder(folderId)
    expect(await screen.findByLabelText(/Quantas questões/)).toBeInTheDocument()
    await waitFor(() => expect(screen.getByText(/disponíveis/)).toBeInTheDocument())
  })
})
