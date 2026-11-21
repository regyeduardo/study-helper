// T147: a generation that fails never loses what the person chose: "Tentar de novo" brings the same window back, filled in.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react'

vi.mock('@/components/reader/GithubMarkdownView', () => ({
  default: ({ markdown }: { markdown: string }) => <div data-testid="markdown">{markdown}</div>,
}))

import { EntryPage } from '@/components/reader/EntryPage'
import { useJobsStore } from '@/stores/jobs'
import { useLibraryStore } from '@/stores/library'
import { useUiStore } from '@/stores/ui'
import type { CapturedRequest } from '@/test/ai/fake-provider'
import { answer, FORTE, flowLibrary, renderAt } from '@/test/generation/flow-fixture'

afterEach(() => {
  vi.unstubAllGlobals()
})

const LINK = 'https://exemplo.com/limites'

/** The page of the link cannot be read: Jina answers with an error (after `gate`, when given). */
function linkFails(gate?: Promise<void>) {
  return (request: CapturedRequest): Response | Promise<Response> => {
    if (request.url.startsWith('https://r.jina.ai/')) return (gate ?? Promise.resolve()).then(() => new Response('fora do ar', { status: 503 }))
    return answer(request)
  }
}

const instructionIn = (dialog: HTMLElement) => within(dialog).getByLabelText('Instrução extra para a IA (opcional)')
const modelIn = (dialog: HTMLElement) => within(dialog).getByLabelText('Modelo da IA')
const corner = () => document.querySelector<HTMLElement>('.jobs')!

/** Novo conteúdo filled in: a link, a name, a model and an instruction. */
function fillNewContent(): HTMLElement {
  act(() => useUiStore.getState().open({ kind: 'new' }))
  const dialog = screen.getByRole('dialog', { name: 'Novo conteúdo' })
  fireEvent.change(within(dialog).getByLabelText('Link'), { target: { value: LINK } })
  fireEvent.change(within(dialog).getByLabelText('Nome (opcional)'), { target: { value: 'Limites laterais' } })
  fireEvent.change(modelIn(dialog), { target: { value: FORTE } })
  fireEvent.change(within(dialog).getByLabelText('Instrução extra para a IA (opcional)'), { target: { value: 'foque nos exemplos' } })
  fireEvent.click(within(dialog).getByRole('button', { name: 'Gerar aula' }))
  return dialog
}

function expectFilled(dialog: HTMLElement) {
  expect(within(dialog).getByLabelText('Link')).toHaveValue(LINK)
  expect(within(dialog).getByLabelText('Nome (opcional)')).toHaveValue('Limites laterais')
  expect(modelIn(dialog)).toHaveValue(FORTE)
  expect(instructionIn(dialog)).toHaveValue('foque nos exemplos')
  expect(instructionIn(dialog)).toBeVisible()
}

describe('Novo conteúdo: a falha não apaga o que foi escolhido', () => {
  it('"Voltar e tentar de novo" traz a mesma janela, preenchida', async () => {
    flowLibrary(linkFails())
    renderAt('/')
    fillNewContent()
    const back = await screen.findByRole('button', { name: 'Voltar e tentar de novo' })
    expect(screen.getByRole('alert')).toBeInTheDocument()
    fireEvent.click(back)
    expectFilled(screen.getByRole('dialog', { name: 'Novo conteúdo' }))
  })

  it('posta em segundo plano e falhou depois: "Tentar de novo" no canto reabre a janela preenchida', async () => {
    let release = () => {}
    const gate = new Promise<void>(resolve => (release = resolve))
    flowLibrary(linkFails(gate))
    renderAt('/')
    fillNewContent()
    fireEvent.click(await screen.findByRole('button', { name: 'Continuar em segundo plano' }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    await act(async () => release())
    const retry = await within(corner()).findByRole('button', { name: 'Tentar de novo' })
    fireEvent.click(retry)
    expectFilled(screen.getByRole('dialog', { name: 'Novo conteúdo' }))
    expect(useJobsStore.getState().jobs).toHaveLength(0)
  })
})

/** An entrada of a link whose page is read again when a note is made of it. */
async function linkEntry(): Promise<string> {
  return (await useLibraryStore.getState().createFile({ name: 'Limites', role: 'entrada', kept: 'registro', type: 'reading', status: 'ready', folderId: null, origin: { input: 'url', name: 'Limites', url: LINK, storage: 'none' } }, '')).id
}

describe('Gerar de uma nota ou entrada: a falha guarda o pedido', () => {
  it('"Gerar desta nota" que falhou: "Tentar de novo" na entrada reabre a janela com a mesma escolha', async () => {
    flowLibrary(linkFails())
    const id = await linkEntry()
    renderAt(`/entrada/${id}`, <EntryPage fileId={id} />)
    act(() => useUiStore.getState().open({ kind: 'generate-entry', fileId: id }))
    let dialog = screen.getByRole('dialog', { name: 'Gerar desta nota' })
    fireEvent.click(await within(dialog).findByRole('radio', { name: /Aula/ }))
    fireEvent.change(modelIn(dialog), { target: { value: FORTE } })
    fireEvent.click(within(dialog).getByText('Mais opções'))
    fireEvent.change(instructionIn(dialog), { target: { value: 'foque nos exemplos' } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Gerar' }))
    const family = await screen.findByRole('region', { name: 'O que nasceu daqui' })
    fireEvent.click(await within(family).findByRole('button', { name: 'Tentar de novo' }))
    dialog = screen.getByRole('dialog', { name: 'Gerar desta nota' })
    expect(within(dialog).getByRole('radio', { name: /Aula/ })).toHaveAttribute('aria-checked', 'true')
    expect(modelIn(dialog)).toHaveValue(FORTE)
    expect(instructionIn(dialog)).toHaveValue('foque nos exemplos')
    expect(instructionIn(dialog)).toBeVisible()
  })

  it('"Gerar a Aula" de uma nota que falhou: "Tentar de novo" no canto reabre a janela com o modelo e a instrução', async () => {
    flowLibrary(linkFails())
    const id = await linkEntry()
    renderAt(`/entrada/${id}`)
    act(() => useUiStore.getState().open({ kind: 'generate', fileId: id, agent: 'lesson' }))
    let dialog = screen.getByRole('dialog', { name: 'Gerar a Aula' })
    fireEvent.change(modelIn(dialog), { target: { value: FORTE } })
    fireEvent.click(within(dialog).getByText('Mais opções'))
    fireEvent.change(instructionIn(dialog), { target: { value: 'foque nos exemplos' } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Gerar' }))
    fireEvent.click(await within(corner()).findByRole('button', { name: 'Tentar de novo' }))
    dialog = screen.getByRole('dialog', { name: 'Gerar a Aula' })
    expect(modelIn(dialog)).toHaveValue(FORTE)
    expect(instructionIn(dialog)).toHaveValue('foque nos exemplos')
    expect(useJobsStore.getState().jobs).toHaveLength(0)
  })

  it('a nota que falhou ao escrever: "Tentar de novo" no canto abre a escolha de modelo dela', async () => {
    flowLibrary()
    const note = await useLibraryStore.getState().createFile({ name: 'Aula: Limites', type: 'class', status: 'pending', folderId: null, pendingExcerpt: 'material' }, '')
    useJobsStore.setState({ jobs: [{ id: 'j', kind: 'generation', title: 'Aula: Limites', fileId: note.id, status: 'error', message: 'A geração falhou.', fraction: null, error: 'A IA recusou o pedido.', startedAt: 1 }] })
    renderAt('/')
    fireEvent.click(within(corner()).getByRole('button', { name: 'Tentar de novo' }))
    expect(useUiStore.getState().overlay).toMatchObject({ kind: 'pending', fileId: note.id })
    expect(screen.getByRole('dialog', { name: 'Tentar de novo' })).toBeInTheDocument()
  })
})
