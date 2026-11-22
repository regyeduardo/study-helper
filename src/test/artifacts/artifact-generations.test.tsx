// FR-065 (003): a map or a deck made from a note is a generation too: it shows in "Gerações" while it is made,
// a failure stays in Falharam with "Tentar de novo" (the window as it was filled in), and what came out is in Prontas with "Abrir" on it.
import '@/test/account/storage-shim'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

import type { AiConfig, Artifact } from '@/types/domain'
import { ArtifactGenerateDialog } from '@/components/dialogs/ArtifactGenerateDialog'
import { CardsDialog } from '@/components/dialogs/CardsDialog'
import { MindMapDialog } from '@/components/dialogs/MindMapDialog'
import { Overlays } from '@/components/dialogs/Overlays'
import { newMapArtifact } from '@/lib/artifacts'
import { NAME_PROMPT } from '@/lib/generation/artifact-name'
import { PROMPTS } from '@/lib/generation/prompts.data'
import { type Generation, useGenerationsStore } from '@/stores/generations'
import { useJobsStore } from '@/stores/jobs'
import { useLibraryStore } from '@/stores/library'
import { useUiStore } from '@/stores/ui'
import { installFetch, openAiStream, systemPromptOf } from '@/test/ai/fake-provider'
import { studyLibrary, studyNote } from '@/test/generation/study-fixture'

const mine = { id: 'mine', type: 'custom' as const, name: 'Minha IA', key: 'k', base: 'https://api.exemplo.dev/v1' }
const A = { uid: 'mine::modelo-a', pid: 'mine', mid: 'modelo-a', name: 'Modelo A' }
const B = { uid: 'mine::modelo-b', pid: 'mine', mid: 'modelo-b', name: 'Modelo B' }
const CONFIG: AiConfig = { providers: [mine], models: [A, B], defaults: { estudo: A.uid }, steps: {} }
const DAY = '2026-11-05T12:00:00.000Z'

/** The AI answers only after `release()`: what is generating can be looked at. */
let release: () => void = () => {}
let gate: Promise<void> = Promise.resolve()
const hold = () => {
  gate = new Promise(resolve => (release = resolve))
}

const answers = () =>
  installFetch(async request => {
    await gate
    const system = systemPromptOf(request)
    if (system === PROMPTS.MINDMAP_PROMPT) return openAiStream(JSON.stringify({ nome: 'Mapa dos limites', forma: 'arvore', raiz: { texto: 'Limites', filhos: [{ texto: 'Laterais', filhos: [] }] } }))
    if (system === PROMPTS.CARDS_PROMPT) return openAiStream(JSON.stringify({ cartoes: [{ frente: 'Quando o limite não existe?', verso: 'Quando os laterais diferem.' }] }))
    if (system === NAME_PROMPT) return openAiStream('{"nome": "Limites laterais"}')
    return openAiStream('{}')
  })

/** Every call waits until the generation is cancelled. */
const hangs = () =>
  vi.stubGlobal(
    'fetch',
    vi.fn((_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_, reject) => init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError'))))),
  )

beforeEach(() => {
  localStorage.clear()
  gate = Promise.resolve()
  useJobsStore.setState({ jobs: [] })
  useGenerationsStore.setState({ items: [] })
  answers()
})

afterEach(() => {
  release()
  vi.unstubAllGlobals()
})

async function note() {
  const memory = studyLibrary()
  useLibraryStore.setState(state => ({ index: { ...state.index, settings: { ...state.index.settings, aiConfig: CONFIG } } }))
  const id = await studyNote()
  return { id, memory }
}

const stored = (memory: ReturnType<typeof studyLibrary>, id: string): Artifact[] => memory.sidecars.get(id)?.artifacts ?? []
const lines = () => useGenerationsStore.getState().items
const lineOf = (title: string): Generation | undefined => lines().find(item => item.title === title)

/** The windows of the app, switched by the overlay. */
function renderOverlays() {
  return render(
    <MemoryRouter>
      <Overlays />
    </MemoryRouter>,
  )
}

describe('um mapa ou um baralho é uma geração', () => {
  it('"+ Novo" de um mapa: aparece em Gerando enquanto é feito, a janela segue igual, e vai para Prontas com "Abrir" no mapa', async () => {
    const { id, memory } = await note()
    hold()
    render(<ArtifactGenerateDialog fileId={id} artifact="mapa" />)
    fireEvent.click(await screen.findByRole('button', { name: 'Gerar' }))

    await waitFor(() => expect(lineOf('Mapa: Limites')).toMatchObject({ state: 'running', fileId: id, message: 'Desenhando o mapa da nota' }))
    expect(screen.getByRole('status')).toHaveTextContent('Desenhando o mapa da nota…')
    // the note itself does not read as being written: its banner and its buttons stay as they were
    expect(useJobsStore.getState().jobs.some(job => job.fileId === id)).toBe(false)

    release()
    await waitFor(() => expect(useUiStore.getState().overlay).toMatchObject({ kind: 'mindmap' }))
    const [map] = stored(memory, id)
    expect(lineOf('Mapa: Limites')).toMatchObject({ state: 'ready', fileId: id, open: { kind: 'mindmap', fileId: id, artifactId: map.id } })
    expect(useUiStore.getState().overlay).toEqual({ kind: 'mindmap', fileId: id, artifactId: map.id })
  })

  it('"Fazer os cartões" do primeiro baralho: Gerando, depois Prontas com "Abrir" no baralho', async () => {
    const { id, memory } = await note()
    hold()
    render(<CardsDialog fileId={id} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Fazer os cartões' }))

    await waitFor(() => expect(lineOf('Cartões: Limites')).toMatchObject({ state: 'running', fileId: id, message: 'Fazendo os cartões da nota' }))
    expect(screen.getByRole('status')).toHaveTextContent('Fazendo os cartões da nota…')

    release()
    expect(await screen.findByText('Quando o limite não existe?')).toBeInTheDocument()
    const [deck] = stored(memory, id)
    expect(lineOf('Cartões: Limites')).toMatchObject({ state: 'ready', open: { kind: 'cards', fileId: id, deckId: deck.id } })
  })

  it('"Fazer o mapa mental" do primeiro mapa: Gerando, depois Prontas com "Abrir" no mapa', async () => {
    const { id, memory } = await note()
    hold()
    render(<MindMapDialog fileId={id} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Fazer o mapa mental' }))

    await waitFor(() => expect(lineOf('Mapa: Limites')).toMatchObject({ state: 'running', fileId: id }))
    expect(screen.getByRole('status')).toHaveTextContent('Desenhando o mapa da nota…')

    release()
    expect(await screen.findByRole('dialog', { name: 'Mapa mental: Mapa dos limites' })).toBeInTheDocument()
    const [map] = stored(memory, id)
    expect(lineOf('Mapa: Limites')).toMatchObject({ state: 'ready', open: { kind: 'mindmap', fileId: id, artifactId: map.id } })
  })

  it('a falha vai para Falharam com o motivo; "Tentar de novo" abre a janela com o modelo e a instrução pedidos', async () => {
    installFetch(() => openAiStream('não sei'))
    const { id, memory } = await note()
    renderOverlays()
    act(() => useUiStore.getState().open({ kind: 'generate-artifact', fileId: id, artifact: 'mapa' }))
    fireEvent.change(await screen.findByLabelText('Modelo da IA'), { target: { value: B.uid } })
    fireEvent.change(screen.getByLabelText('Instrução extra para a IA (opcional)'), { target: { value: 'só as decisões' } })
    fireEvent.click(screen.getByRole('button', { name: 'Gerar' }))

    // the window still says why, as before
    expect(await screen.findByText('A IA não devolveu um mapa. Tente de novo.')).toBeInTheDocument()
    const failed = lineOf('Mapa: Limites')!
    expect(failed).toMatchObject({ state: 'failed', fileId: id, error: 'A IA não devolveu um mapa. Tente de novo.' })
    expect(failed.retry).toEqual({ kind: 'generate-artifact', fileId: id, artifact: 'mapa', prefill: { model: B.uid, instruction: 'só as decisões' } })
    expect(stored(memory, id)).toHaveLength(0)

    act(() => useUiStore.getState().close())
    act(() => useGenerationsStore.getState().retry(failed.id))
    expect(await screen.findByRole('dialog', { name: 'Novo mapa mental' })).toBeInTheDocument()
    expect(screen.getByLabelText('Modelo da IA')).toHaveValue(B.uid)
    expect(screen.getByLabelText('Instrução extra para a IA (opcional)')).toHaveValue('só as decisões')
    expect(lineOf('Mapa: Limites')).toBeUndefined()
  })

  it('"Gerar de novo" com "Substituir este" que falhou: "Tentar de novo" volta com "Substituir este" marcado', async () => {
    installFetch(() => openAiStream('não sei'))
    const { id } = await note()
    const before = await useLibraryStore.getState().saveArtifact(id, newMapArtifact({ name: 'Decisões', diagram: { form: 'arvore', root: { id: 'r', text: 'Antes', children: [] } }, made: { model: B.uid, instruction: 'só prazos', at: DAY } }))
    renderOverlays()
    act(() => useUiStore.getState().open({ kind: 'generate-artifact', fileId: id, artifact: 'mapa', again: before.id }))
    fireEvent.click(await screen.findByRole('radio', { name: /Substituir este/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Gerar' }))
    await screen.findByText('A IA não devolveu um mapa. Tente de novo.')

    const failed = lineOf('Mapa: Limites')!
    expect(failed.retry).toEqual({ kind: 'generate-artifact', fileId: id, artifact: 'mapa', again: before.id, prefill: { model: B.uid, instruction: 'só prazos', replace: true } })
    act(() => useUiStore.getState().close())
    act(() => useGenerationsStore.getState().retry(failed.id))
    expect(await screen.findByRole('dialog', { name: 'Gerar de novo o mapa' })).toBeInTheDocument()
    expect(screen.getByRole('radio', { name: /Substituir este/ })).toHaveAttribute('aria-checked', 'true')
  })

  it('"Cancelar" em Gerações para o mapa: a linha sai sem virar falha, nada é salvo e a janela para de esperar', async () => {
    hangs()
    const { id, memory } = await note()
    render(<ArtifactGenerateDialog fileId={id} artifact="mapa" />)
    fireEvent.click(await screen.findByRole('button', { name: 'Gerar' }))
    await waitFor(() => expect(lineOf('Mapa: Limites')).toMatchObject({ state: 'running' }))

    act(() => useGenerationsStore.getState().cancel(lineOf('Mapa: Limites')!.id))
    await waitFor(() => expect(screen.queryByRole('status')).toBeNull())
    expect(lineOf('Mapa: Limites')).toBeUndefined()
    expect(lines().some(item => item.state === 'failed')).toBe(false)
    expect(stored(memory, id)).toHaveLength(0)
    expect(screen.getByRole('button', { name: 'Gerar' })).toBeEnabled()
  })

  it('gerar de novo o mesmo mapa da nota tira a falha anterior de Falharam', async () => {
    installFetch(() => openAiStream('não sei'))
    const { id } = await note()
    render(<ArtifactGenerateDialog fileId={id} artifact="mapa" />)
    fireEvent.click(await screen.findByRole('button', { name: 'Gerar' }))
    await screen.findByText('A IA não devolveu um mapa. Tente de novo.')
    expect(lines().filter(item => item.state === 'failed')).toHaveLength(1)

    answers()
    fireEvent.click(screen.getByRole('button', { name: 'Gerar' }))
    await waitFor(() => expect(lineOf('Mapa: Limites')).toMatchObject({ state: 'ready' }))
    expect(lines().filter(item => item.state === 'failed')).toHaveLength(0)
  })
})
