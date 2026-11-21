// T148: with a note or an entrada open, a new generation does not take the person away: it says so, with "Abrir". With nothing open, it goes there as before.
import '@/test/account/storage-shim'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { File as NodeFile } from 'node:buffer'

const { navigate, routerAt } = vi.hoisted(() => ({ navigate: vi.fn(), routerAt: { pathname: '/' } }))

vi.mock('@/routes', () => ({ router: { navigate, state: { location: routerAt } } }))

vi.mock('@/components/reader/GithubMarkdownView', () => ({
  default: ({ markdown }: { markdown: string }) => <div data-testid="markdown">{markdown}</div>,
}))

import { paths } from '@/lib/paths'
import { type CourseProposal, useJobsStore } from '@/stores/jobs'
import { useLibraryStore } from '@/stores/library'
import { useRecorderStore } from '@/stores/recorder'
import { useUiStore } from '@/stores/ui'
import { fileOf, flowLibrary, renderAt, textSource, where } from '@/test/generation/flow-fixture'
import type { StoredQuestion } from '@/types/domain'

const REAL = useJobsStore.getState()

afterEach(() => {
  vi.unstubAllGlobals()
  useJobsStore.setState({ explainGaps: REAL.explainGaps, declineCourse: REAL.declineCourse, acceptCourse: REAL.acceptCourse, saveRecording: REAL.saveRecording })
  useRecorderStore.setState({ result: null })
  navigate.mockClear()
  routerAt.pathname = '/'
  localStorage.clear()
})

const toasts = () => document.querySelector<HTMLElement>('.toasts')!
const newNote = (source: string) => useLibraryStore.getState().files.find(file => file.parentFileId === source)

async function generateLessonFrom(source: string) {
  act(() => useUiStore.getState().open({ kind: 'generate', fileId: source, agent: 'lesson' }))
  fireEvent.click(within(screen.getByRole('dialog', { name: 'Gerar a Aula' })).getByRole('button', { name: 'Gerar' }))
  await waitFor(() => expect(newNote(source)).toBeDefined())
}

describe('"Gerar a Aula" de uma nota', () => {
  it('com a nota aberta: fica nela e avisa, com "Abrir"', async () => {
    flowLibrary()
    const source = await textSource()
    renderAt(paths.file(source))
    await generateLessonFrom(source)
    const made = newNote(source)!
    const notice = await within(toasts()).findByText(/Gerando a Aula\. Você continua aqui\./)
    expect(where()).toBe(paths.file(source))
    fireEvent.click(within(notice).getByRole('button', { name: 'Abrir' }))
    expect(where()).toBe(paths.file(made.id))
  })

  it('quando fica pronta, o aviso do canto também tem "Abrir"', async () => {
    flowLibrary()
    const source = await textSource()
    renderAt(paths.file(source))
    await generateLessonFrom(source)
    const made = newNote(source)!
    await waitFor(() => expect(fileOf(made.id).status).toBe('ready'))
    const ready = await within(toasts()).findByText(/ficou pronta/)
    expect(where()).toBe(paths.file(source))
    fireEvent.click(within(ready).getByRole('button', { name: 'Abrir' }))
    expect(where()).toBe(paths.file(made.id))
  })

  it('na lista da Biblioteca (nada aberto): vai para a nota nova, como antes', async () => {
    flowLibrary()
    const source = await textSource()
    renderAt('/biblioteca')
    await generateLessonFrom(source)
    await waitFor(() => expect(where()).toBe(paths.file(newNote(source)!.id)))
  })
})

describe('Novo conteúdo', () => {
  async function newText() {
    act(() => useUiStore.getState().open({ kind: 'new' }))
    const dialog = screen.getByRole('dialog', { name: 'Novo conteúdo' })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Texto' }))
    fireEvent.change(within(dialog).getByLabelText('Texto'), { target: { value: 'Se os laterais diferem, o limite não existe.' } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Gerar aula' }))
    await waitFor(() => expect(useLibraryStore.getState().files.some(file => file.type === 'class')).toBe(true))
    return useLibraryStore.getState().files.find(file => file.type === 'class')!
  }

  it('com uma entrada aberta: a janela fecha, a página fica e o aviso oferece "Abrir"', async () => {
    flowLibrary()
    const open = await textSource()
    renderAt(paths.entry(open))
    const made = await newText()
    const notice = await within(toasts()).findByText(/Gerando a Aula\. Você continua aqui\./)
    await waitFor(() => expect(screen.queryByRole('dialog', { name: /Novo conteúdo|Lendo/ })).not.toBeInTheDocument())
    expect(where()).toBe(paths.entry(open))
    fireEvent.click(within(notice).getByRole('button', { name: 'Abrir' }))
    expect(where()).toBe(paths.file(made.id))
  })

  it('no início (nada aberto): vai para a nota nova, como antes', async () => {
    flowLibrary()
    renderAt('/')
    const made = await newText()
    await waitFor(() => expect(where()).toBe(paths.file(made.id)))
  })
})

const proposal = { analysis: { isCourse: true, name: 'Cálculo', description: '', lessonCount: 2, modules: [] }, request: { folderId: null }, resolved: {} } as unknown as CourseProposal

describe('A proposta de pasta com aulas', () => {
  it('"Não, uma aula só" com uma nota aberta: fica nela, com "Abrir"', async () => {
    flowLibrary()
    useJobsStore.setState({ proposals: [proposal], declineCourse: vi.fn(async () => 'aula-unica') })
    renderAt('/arquivo/lendo')
    fireEvent.click(screen.getByRole('button', { name: 'Não, uma aula só' }))
    const notice = await within(toasts()).findByText(/Você continua aqui/)
    expect(where()).toBe('/arquivo/lendo')
    fireEvent.click(within(notice).getByRole('button', { name: 'Abrir' }))
    expect(where()).toBe(paths.file('aula-unica'))
  })

  it('"Criar a pasta com as aulas" com uma nota aberta: fica nela, com "Abrir" para a pasta', async () => {
    flowLibrary()
    useJobsStore.setState({ proposals: [proposal], acceptCourse: vi.fn(async () => 'pasta-curso') })
    renderAt('/arquivo/lendo')
    fireEvent.click(screen.getByRole('button', { name: 'Criar a pasta com as aulas' }))
    const notice = await within(toasts()).findByText(/Você continua aqui/)
    expect(where()).toBe('/arquivo/lendo')
    fireEvent.click(within(notice).getByRole('button', { name: 'Abrir' }))
    expect(where()).toBe(paths.folder('pasta-curso'))
  })

  it('sem nada aberto: vai para a pasta, como antes', async () => {
    flowLibrary()
    useJobsStore.setState({ proposals: [proposal], acceptCourse: vi.fn(async () => 'pasta-curso') })
    renderAt('/biblioteca')
    fireEvent.click(screen.getByRole('button', { name: 'Criar a pasta com as aulas' }))
    await waitFor(() => expect(where()).toBe(paths.folder('pasta-curso')))
  })
})

const QUESTION: StoredQuestion = { storedId: 'q1', tipo: 'unica', enunciado: 'O limite existe se os laterais diferem?', alternativas: { A: 'Não', B: 'Sim' }, correta: 'A', explicacao: 'Os laterais precisam ser iguais.' }

describe('Diagnóstico da prova', () => {
  it('"Gerar explicações" com a nota aberta: fica nela, com "Abrir"', async () => {
    flowLibrary()
    useJobsStore.setState({ explainGaps: vi.fn(async () => ['explicada']) })
    const id = await textSource('Limites')
    await useLibraryStore.getState().updateSidecar(id, sidecar => ({ ...sidecar, questions: [QUESTION] }))
    renderAt(paths.file(id))
    act(() => useUiStore.getState().open({ kind: 'exam', fileId: id }))
    await screen.findByRole('group', { name: 'Ações da prova' })
    fireEvent.click(screen.getByRole('button', { name: /Sim/ }))
    fireEvent.click(screen.getAllByRole('button', { name: 'Entregar prova' })[0])
    fireEvent.click(await screen.findByRole('button', { name: /Ver o que faltou aprender/ }))
    const dialog = await screen.findByRole('dialog', { name: 'Diagnóstico · Limites' })
    await within(dialog).findByText('Limites laterais')
    fireEvent.click(within(dialog).getByRole('button', { name: /Gerar explicações/ }))
    const notice = await within(toasts()).findByText(/Gerando a explicação\. Você continua aqui\./)
    expect(where()).toBe(paths.file(id))
    fireEvent.click(within(notice).getByRole('button', { name: 'Abrir' }))
    expect(where()).toBe(paths.file('explicada'))
  })
})

describe('Gravação pronta', () => {
  // "Só guardar": no model to choose in this library
  const keepOnly = () => fireEvent.click(within(screen.getByRole('radiogroup', { name: 'O que fazer com a gravação' })).getByRole('radio', { name: /Só guardar/ }))
  const recorded = () => ({ file: new NodeFile([new Uint8Array(8)], 'Reunião.webm', { type: 'audio/webm' }) as unknown as File, mime: 'audio/webm', durationSeconds: 30, storedName: 'gravacao-1.webm', marks: [] })

  it('salva com uma nota aberta: fica nela, com "Abrir"', async () => {
    flowLibrary()
    useJobsStore.setState({ saveRecording: vi.fn(async () => 'gravada') })
    useRecorderStore.setState({ result: recorded(), resultPlace: 'dialog' })
    routerAt.pathname = '/arquivo/lendo'
    renderAt('/arquivo/lendo')
    keepOnly()
    fireEvent.click(within(screen.getByRole('dialog', { name: 'Gravação pronta' })).getByRole('button', { name: 'Salvar' }))
    const notice = await within(toasts()).findByText(/Você continua aqui/)
    expect(navigate).not.toHaveBeenCalled()
    fireEvent.click(within(notice).getByRole('button', { name: 'Abrir' }))
    expect(where()).toBe(paths.file('gravada'))
  })

  it('salva sem nada aberto: abre a gravação, como antes', async () => {
    flowLibrary()
    useJobsStore.setState({ saveRecording: vi.fn(async () => 'gravada') })
    useRecorderStore.setState({ result: recorded(), resultPlace: 'dialog' })
    routerAt.pathname = '/biblioteca'
    renderAt('/biblioteca')
    keepOnly()
    fireEvent.click(within(screen.getByRole('dialog', { name: 'Gravação pronta' })).getByRole('button', { name: 'Salvar' }))
    await waitFor(() => expect(navigate).toHaveBeenCalledWith(paths.file('gravada')))
  })
})
