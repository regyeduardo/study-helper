// T144: every action that writes with AI shows who writes (the default preselected) before it starts.
import '@/test/account/storage-shim'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react'

vi.mock('@/components/reader/GithubMarkdownView', () => ({
  default: ({ markdown }: { markdown: string }) => <div data-testid="markdown">{markdown}</div>,
}))

import { ItemMenu } from '@/components/library/ItemMenu'
import { useFileActions } from '@/components/library/use-file-actions'
import { DocumentBody } from '@/components/reader/DocumentArticle'
import { INSTRUCTION_HEAD } from '@/lib/generation/instruction'
import { PROMPTS } from '@/lib/generation/prompts.data'
import { paths } from '@/lib/paths'
import { useJobsStore } from '@/stores/jobs'
import { useLibraryStore } from '@/stores/library'
import { useUiStore } from '@/stores/ui'
import { course, fileOf, FORTE, flowLibrary, GERAL, modelOf, renderAt, sentTo, textSource, userContentOf, where } from '@/test/generation/flow-fixture'
import type { StoredQuestion } from '@/types/domain'

const REAL = useJobsStore.getState()

afterEach(() => {
  useJobsStore.setState({ createQuestions: REAL.createQuestions, explainGaps: REAL.explainGaps })
  vi.unstubAllGlobals()
  localStorage.clear()
})

function Opener({ id }: { id: string }) {
  const { openFile } = useFileActions()
  return <button onClick={() => openFile(fileOf(id))}>abrir a aula</button>
}

const modelIn = (dialog: HTMLElement) => within(dialog).getByLabelText('Modelo da IA')
const instructionIn = (dialog: HTMLElement) => within(dialog).getByLabelText('Instrução extra para a IA (opcional)')

describe('"Gerar agora", "Tentar de novo" e "Gerar as aulas que faltam" perguntam quem escreve', () => {
  it('"Gerar agora" de uma aula ainda não escrita: a janela mostra o modelo com o padrão marcado e usa o escolhido', async () => {
    const { calls } = flowLibrary()
    const { ids } = await course(['Aula 1'])
    renderAt('/biblioteca', <Opener id={ids[0]} />)
    fireEvent.click(screen.getByRole('button', { name: 'abrir a aula' }))
    const dialog = await screen.findByRole('dialog', { name: 'Gerar a Aula' })
    expect(dialog).toHaveTextContent('Esta aula ainda não foi escrita. O recorte do material já está guardado.')
    expect(modelIn(dialog)).toHaveValue(GERAL)
    expect(calls).toHaveLength(0)
    fireEvent.change(modelIn(dialog), { target: { value: FORTE } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Gerar' }))
    await waitFor(() => expect(fileOf(ids[0]).status).toBe('ready'))
    expect(sentTo(calls, PROMPTS.LESSON_PROMPT).map(modelOf)).toEqual(['forte'])
    expect(fileOf(ids[0]).made).toMatchObject({ model: FORTE })
    // she clicked the lesson to open it
    expect(where()).toBe(paths.file(ids[0]))
  })

  it('"Cancelar" não gera nada', async () => {
    const { calls } = flowLibrary()
    const { ids } = await course(['Aula 1'])
    renderAt('/biblioteca', <Opener id={ids[0]} />)
    fireEvent.click(screen.getByRole('button', { name: 'abrir a aula' }))
    fireEvent.click(within(await screen.findByRole('dialog', { name: 'Gerar a Aula' })).getByRole('button', { name: 'Cancelar' }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(calls).toHaveLength(0)
    expect(fileOf(ids[0]).status).toBe('pending')
  })

  it('"Tentar de novo" de uma nota que falhou: o modelo e a instrução da última vez voltam, à vista, e o que for escolhido vale', async () => {
    const { calls } = flowLibrary()
    const source = await textSource()
    const note = (
      await useLibraryStore.getState().createFile(
        { name: 'Aula: Pauta', type: 'class', status: 'pending', parentFileId: source, folderId: null, pendingExcerpt: '# Conteúdo\n\nO material guardado.', made: { model: FORTE, instruction: 'foque nos exemplos', at: '2026-11-01T10:00:00.000Z' } },
        '',
      )
    ).id
    renderAt(paths.file(note), <DocumentBody fileId={note} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Tentar de novo' }))
    const dialog = screen.getByRole('dialog', { name: 'Tentar de novo' })
    expect(modelIn(dialog)).toHaveValue(FORTE)
    expect(instructionIn(dialog)).toBeVisible()
    expect(instructionIn(dialog)).toHaveValue('foque nos exemplos')
    fireEvent.change(modelIn(dialog), { target: { value: GERAL } })
    fireEvent.change(instructionIn(dialog), { target: { value: 'foque nas definições' } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Gerar' }))
    await waitFor(() => expect(fileOf(note).status).toBe('ready'))
    const [call] = sentTo(calls, PROMPTS.LESSON_PROMPT)
    expect(modelOf(call)).toBe('geral')
    expect(userContentOf(call)).toContain('O material guardado.')
    expect(userContentOf(call).endsWith(`${INSTRUCTION_HEAD}\n\nfoque nas definições`)).toBe(true)
    expect(fileOf(note).made).toMatchObject({ model: GERAL, instruction: 'foque nas definições' })
  })

  it('"Gerar as aulas que faltam…": uma escolha vale para todas as aulas', async () => {
    const { calls } = flowLibrary()
    const { root, ids } = await course(['Aula 1', 'Aula 2'])
    useUiStore.getState().openMenu({ kind: 'folder', id: root, x: 1, y: 1 })
    renderAt('/biblioteca', <ItemMenu />)
    fireEvent.click(screen.getByRole('button', { name: 'Gerar as aulas que faltam…' }))
    const dialog = await screen.findByRole('dialog', { name: 'Gerar as aulas que faltam' })
    expect(dialog).toHaveTextContent('2 aulas ainda não escritas em “Cálculo”.')
    expect(calls).toHaveLength(0)
    fireEvent.change(modelIn(dialog), { target: { value: FORTE } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Gerar' }))
    await waitFor(() => expect(ids.map(id => fileOf(id).status)).toEqual(['ready', 'ready']))
    expect(sentTo(calls, PROMPTS.LESSON_PROMPT).map(modelOf)).toEqual(['forte', 'forte'])
  })
})

const QUESTION: StoredQuestion = { storedId: 'q1', tipo: 'unica', enunciado: 'O limite existe se os laterais diferem?', alternativas: { A: 'Não', B: 'Sim' }, correta: 'A', explicacao: 'Os laterais precisam ser iguais.' }

async function noteWithExam(): Promise<string> {
  const id = await textSource('Limites')
  await useLibraryStore.getState().updateSidecar(id, sidecar => ({ ...sidecar, questions: [QUESTION] }))
  return id
}

describe('Prova: o que escreve com IA mostra o modelo antes', () => {
  it('"Gerar outras questões" abre a escolha do modelo e da instrução; só pede depois de "Gerar"', async () => {
    flowLibrary()
    const createQuestions = vi.fn(async () => ({ count: 1, web: { found: 1, note: '' } }))
    useJobsStore.setState({ createQuestions })
    const id = await noteWithExam()
    renderAt(paths.file(id))
    act(() => useUiStore.getState().open({ kind: 'exam', fileId: id }))
    await screen.findByRole('group', { name: 'Ações da prova' })
    fireEvent.click(screen.getByRole('button', { name: 'Mais' }))
    fireEvent.click(screen.getByRole('menuitem', { name: /Gerar outras questões/ }))
    const dialog = screen.getByRole('dialog', { name: 'Gerar outras questões · Limites' })
    expect(createQuestions).not.toHaveBeenCalled()
    expect(modelIn(dialog)).toHaveValue(GERAL)
    fireEvent.change(modelIn(dialog), { target: { value: FORTE } })
    fireEvent.change(instructionIn(dialog), { target: { value: 'só cálculo de limites' } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Gerar outras questões' }))
    await waitFor(() => expect(createQuestions).toHaveBeenCalledWith(id, undefined, FORTE, 'só cálculo de limites'))
  })

  it('"Voltar à prova" volta sem pedir nada', async () => {
    flowLibrary()
    const createQuestions = vi.fn(async () => ({ count: 1, web: { found: 1, note: '' } }))
    useJobsStore.setState({ createQuestions })
    const id = await noteWithExam()
    renderAt(paths.file(id))
    act(() => useUiStore.getState().open({ kind: 'exam', fileId: id }))
    await screen.findByRole('group', { name: 'Ações da prova' })
    fireEvent.click(screen.getByRole('button', { name: 'Mais' }))
    fireEvent.click(screen.getByRole('menuitem', { name: /Gerar outras questões/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Voltar à prova' }))
    expect(await screen.findByRole('group', { name: 'Ações da prova' })).toBeInTheDocument()
    expect(createQuestions).not.toHaveBeenCalled()
  })

  it('Diagnóstico: "Gerar explicações" mostra quem escreve e usa o escolhido', async () => {
    flowLibrary()
    const explainGaps = vi.fn(async () => ['explicada'])
    useJobsStore.setState({ explainGaps })
    const id = await noteWithExam()
    renderAt(paths.file(id))
    act(() => useUiStore.getState().open({ kind: 'exam', fileId: id }))
    await screen.findByRole('group', { name: 'Ações da prova' })
    // the wrong one
    fireEvent.click(screen.getByRole('button', { name: /Sim/ }))
    fireEvent.click(screen.getAllByRole('button', { name: 'Entregar prova' })[0])
    fireEvent.click(await screen.findByRole('button', { name: /Ver o que faltou aprender/ }))
    const dialog = await screen.findByRole('dialog', { name: 'Diagnóstico · Limites' })
    await within(dialog).findByText('Limites laterais')
    expect(modelIn(dialog)).toHaveValue(GERAL)
    fireEvent.change(modelIn(dialog), { target: { value: FORTE } })
    fireEvent.click(within(dialog).getByRole('button', { name: /Gerar explicações/ }))
    await waitFor(() => expect(explainGaps).toHaveBeenCalledWith({ fileId: id, folderId: null }, [expect.objectContaining({ title: 'O que faltou em Limites' })], FORTE))
  })
})
