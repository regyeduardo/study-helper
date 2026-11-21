import '@/test/account/storage-shim'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'

import type { StoredQuestion } from '@/types/domain'
import { ExamDialog, FolderExamDialog } from '@/components/dialogs/ExamDialog'
import { useJobsStore } from '@/stores/jobs'
import { useLibraryStore } from '@/stores/library'
import { useUiStore } from '@/stores/ui'
import { studyLibrary, studyNote } from '@/test/generation/study-fixture'

const question = (n: number): StoredQuestion => ({
  storedId: `b${n}`,
  tipo: 'unica',
  enunciado: `Pergunta ${n}`,
  alternativas: { A: `Alfa ${n}`, B: `Beta ${n}`, C: `Gama ${n}` },
  correta: 'A',
  explicacao: `Porque ${n}.`,
})

const QUESTIONS = Array.from({ length: 4 }, (_, index) => question(index + 1))

function Host() {
  const overlay = useUiStore(state => state.overlay)
  if (overlay?.kind === 'exam') return <ExamDialog fileId={overlay.fileId} />
  if (overlay?.kind === 'folder-exam') return <FolderExamDialog folderId={overlay.folderId} fileIds={overlay.fileIds} />
  return null
}

const setOneAtATime = (on: boolean) => useLibraryStore.setState(state => ({ index: { ...state.index, settings: { ...state.index.settings, examOneAtATime: on } } }))

async function exam(): Promise<string> {
  const id = await studyNote()
  await useLibraryStore.getState().updateSidecar(id, sidecar => ({ ...sidecar, questions: QUESTIONS }))
  return id
}

async function open(oneAtATime: boolean) {
  setOneAtATime(oneAtATime)
  const id = await exam()
  render(<Host />)
  act(() => useUiStore.getState().open({ kind: 'exam', fileId: id }))
  await screen.findByRole('group', { name: 'Ações da prova' })
  return id
}

const header = () => within(document.querySelector<HTMLElement>('.dh')!)
const bar = () => within(screen.getByRole('group', { name: 'Ações da prova' }))
const markFirst = () => fireEvent.click(document.querySelector<HTMLElement>('.q .ans button')!)
const shown = () => document.querySelector('.q .qh')?.textContent
const goToLast = () => {
  for (let step = 1; step < QUESTIONS.length; step++) fireEvent.click(bar().getByRole('button', { name: /Próxima/ }))
}

const jobs = useJobsStore.getState()

beforeEach(() => {
  localStorage.clear()
  studyLibrary()
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  useJobsStore.setState({ createQuestions: jobs.createQuestions })
})

describe('Prova: barra de baixo que não rola', () => {
  it('fica no rodapé da janela, fora do corpo que rola', async () => {
    await open(true)
    const barBox = screen.getByRole('group', { name: 'Ações da prova' })
    const dialog = screen.getByRole('dialog')
    expect(barBox.closest('.db')).toBeNull()
    expect(barBox.closest('.df')?.parentElement).toBe(dialog)
    expect(dialog.querySelector('.db')?.contains(barBox)).toBe(false)
    // the questions are what scrolls, and the bar comes after them
    expect(dialog.querySelector('.db')?.compareDocumentPosition(barBox)).toBe(Node.DOCUMENT_POSITION_FOLLOWING)
  })

  it('uma por vez: "Anterior" com contorno, "Próxima" preenchida e, entre elas, "1 de 4" e "0 respondidas"', async () => {
    await open(true)
    const previous = bar().getByRole('button', { name: /Anterior/ })
    const next = bar().getByRole('button', { name: /Próxima/ })
    expect(previous).not.toHaveClass('primary')
    expect(previous).toBeDisabled()
    expect(next).toHaveClass('primary')
    expect(bar().getByText('1 de 4')).toBeInTheDocument()
    expect(bar().getByText('0 respondidas')).toBeInTheDocument()
    // order: Anterior, the count, Próxima
    const [first, middle, last] = [...screen.getByRole('group', { name: 'Ações da prova' }).children]
    expect(first).toBe(previous)
    expect(middle).toContainElement(bar().getByText('1 de 4'))
    expect(middle).toContainElement(bar().getByText('0 respondidas'))
    expect(last).toBe(next)
  })

  it('a contagem anda com a pessoa: "2 de 4", "1 respondida"', async () => {
    await open(true)
    markFirst()
    expect(bar().getByText('1 respondida')).toBeInTheDocument()
    fireEvent.click(bar().getByRole('button', { name: /Próxima/ }))
    expect(bar().getByText('2 de 4')).toBeInTheDocument()
    expect(bar().getByRole('button', { name: /Anterior/ })).toBeEnabled()
  })

  it('"Entregar prova" fica no cabeçalho, com contorno (não preenchida), e vem antes do "Mais" e do X', async () => {
    await open(true)
    const submit = header().getByRole('button', { name: 'Entregar prova' })
    expect(submit).not.toHaveClass('primary')
    const names = [...document.querySelectorAll('.dh button')].map(button => button.getAttribute('aria-label') ?? button.textContent)
    expect(names.indexOf('Entregar prova')).toBeLessThan(names.indexOf('Mais'))
    expect(names.indexOf('Mais')).toBeLessThan(names.indexOf('Fechar'))
  })

  it('fora da última questão a barra não tem "Entregar prova"; só o cabeçalho tem, e sem resposta nenhuma ela está desligada', async () => {
    await open(true)
    expect(bar().queryByRole('button', { name: 'Entregar prova' })).not.toBeInTheDocument()
    expect(screen.getAllByRole('button', { name: 'Entregar prova' })).toHaveLength(1)
    expect(header().getByRole('button', { name: 'Entregar prova' })).toBeDisabled()
    markFirst()
    expect(header().getByRole('button', { name: 'Entregar prova' })).toBeEnabled()
  })

  it('na última questão a "Próxima" vira "Entregar prova", preenchida', async () => {
    await open(true)
    markFirst()
    goToLast()
    expect(bar().getByText('4 de 4')).toBeInTheDocument()
    expect(bar().queryByRole('button', { name: /Próxima/ })).not.toBeInTheDocument()
    const submit = bar().getByRole('button', { name: 'Entregar prova' })
    expect(submit).toHaveClass('primary')
    expect(submit).toBeEnabled()
    fireEvent.click(submit)
    expect(await screen.findByText(/feita/)).toBeInTheDocument()
  })

  it('na última questão sem nenhuma resposta, "Entregar prova" espera a primeira resposta', async () => {
    await open(true)
    goToLast()
    expect(bar().getByRole('button', { name: 'Entregar prova' })).toBeDisabled()
    markFirst()
    expect(bar().getByRole('button', { name: 'Entregar prova' })).toBeEnabled()
  })

  it('voltar da última questão traz a "Próxima" de volta', async () => {
    await open(true)
    goToLast()
    fireEvent.click(bar().getByRole('button', { name: /Anterior/ }))
    expect(bar().getByRole('button', { name: /Próxima/ })).toHaveClass('primary')
    expect(bar().queryByRole('button', { name: 'Entregar prova' })).not.toBeInTheDocument()
  })

  it('a janela volta ao topo quando muda de questão (a barra fica, a questão é que rola)', async () => {
    await open(true)
    const body = document.querySelector<HTMLElement>('.db')!
    body.scrollTop = 300
    fireEvent.click(bar().getByRole('button', { name: /Próxima/ }))
    expect(shown()).toContain('2')
    expect(body.scrollTop).toBe(0)
  })
})

describe('Prova: menu "Mais"', () => {
  it('o botão fica no cabeçalho e abre "Sair sem salvar" e "Gerar outras questões"', async () => {
    await open(true)
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    fireEvent.click(header().getByRole('button', { name: 'Mais' }))
    const menu = screen.getByRole('menu', { name: 'Mais' })
    expect(within(menu).getByRole('menuitem', { name: /Sair sem salvar/ })).toBeInTheDocument()
    expect(within(menu).getByRole('menuitem', { name: /Gerar outras questões/ })).toBeInTheDocument()
  })

  it('no celular o menu também entrega a prova, dizendo quantas questões foram respondidas', async () => {
    await open(true)
    markFirst()
    fireEvent.click(header().getByRole('button', { name: 'Mais' }))
    const submit = within(screen.getByRole('menu')).getByRole('menuitem', { name: /Entregar prova/ })
    expect(submit).toHaveTextContent('1 de 4 respondidas')
    fireEvent.click(submit)
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    expect(await screen.findByText(/feita/)).toBeInTheDocument()
  })

  it('"Sair sem salvar" do menu fecha a prova', async () => {
    await open(true)
    markFirst()
    fireEvent.click(header().getByRole('button', { name: 'Mais' }))
    fireEvent.click(screen.getByRole('menuitem', { name: /Sair sem salvar/ }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(useUiStore.getState().overlay).toBeNull()
  })

  it('"Gerar outras questões" do menu fecha o menu, mostra o modelo e só então pede outras questões', async () => {
    const createQuestions = vi.fn(() => new Promise<never>(() => undefined))
    useJobsStore.setState({ createQuestions })
    const id = await open(true)
    fireEvent.click(header().getByRole('button', { name: 'Mais' }))
    fireEvent.click(screen.getByRole('menuitem', { name: /Gerar outras questões/ }))
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    expect(createQuestions).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Gerar outras questões' }))
    expect(createQuestions).toHaveBeenCalledWith(id, undefined, expect.anything(), '')
  })

  it('Esc com o menu aberto fecha só o menu', async () => {
    await open(true)
    fireEvent.click(header().getByRole('button', { name: 'Mais' }))
    act(() => void fireEvent.keyDown(window, { key: 'Escape' }))
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    act(() => void fireEvent.keyDown(window, { key: 'Escape' }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('na prova de uma pasta não há "Gerar outras questões"', async () => {
    const folder = await useLibraryStore.getState().createFolder({ name: 'Cálculo' })
    const note = await useLibraryStore.getState().createFile({ name: 'Nota', type: 'class', status: 'ready', folderId: folder.id }, '# Nota')
    await useLibraryStore.getState().updateSidecar(note.id, sidecar => ({ ...sidecar, questions: QUESTIONS }))
    setOneAtATime(true)
    render(<Host />)
    act(() => useUiStore.getState().open({ kind: 'folder-exam', folderId: folder.id }))
    fireEvent.click(await screen.findByRole('button', { name: /Todas/ }))
    fireEvent.click(await screen.findByRole('button', { name: 'Mais' }))
    expect(screen.getByRole('menuitem', { name: /Sair sem salvar/ })).toBeInTheDocument()
    expect(screen.queryByRole('menuitem', { name: /Gerar outras questões/ })).not.toBeInTheDocument()
  })
})

describe('Prova: todas as questões numa lista', () => {
  it('a barra fica, sem Anterior nem Próxima, com "Entregar prova" preenchida no fim', async () => {
    await open(false)
    expect(bar().queryByRole('button', { name: /Anterior/ })).not.toBeInTheDocument()
    expect(bar().queryByRole('button', { name: /Próxima/ })).not.toBeInTheDocument()
    expect(bar().getByText('0 de 4 respondidas')).toBeInTheDocument()
    const submit = bar().getByRole('button', { name: 'Entregar prova' })
    expect(submit).toHaveClass('primary')
    expect(submit).toBeDisabled()
    expect(screen.getByRole('group', { name: 'Ações da prova' }).lastElementChild).toBe(submit)
    markFirst()
    expect(bar().getByText('1 de 4 respondidas')).toBeInTheDocument()
    expect(submit).toBeEnabled()
    fireEvent.click(submit)
    expect(await screen.findByText(/feita/)).toBeInTheDocument()
  })

  it('o "Entregar prova" do cabeçalho continua com contorno', async () => {
    await open(false)
    expect(header().getByRole('button', { name: 'Entregar prova' })).not.toHaveClass('primary')
  })
})

describe('Prova: o resultado não muda', () => {
  it('o rodapé do resultado segue com "Refazer" e "Concluir", sem a barra nem os botões do cabeçalho', async () => {
    await open(true)
    markFirst()
    fireEvent.click(header().getByRole('button', { name: 'Entregar prova' }))
    await screen.findByText(/feita/)
    expect(screen.queryByRole('group', { name: 'Ações da prova' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Refazer' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Concluir' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Mais' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Entregar prova' })).not.toBeInTheDocument()
    expect(document.querySelector('.dh h2')?.textContent).toMatch(/^Resultado/)
  })
})
