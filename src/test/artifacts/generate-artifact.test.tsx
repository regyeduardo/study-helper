import { StrictMode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

import type { AiConfig, CardsArtifact, MapArtifact } from '@/types/domain'
import { ArtifactGenerateDialog } from '@/components/dialogs/ArtifactGenerateDialog'
import { Overlays } from '@/components/dialogs/Overlays'
import { InspectorBody } from '@/components/reader/Inspector'
import { newCardsArtifact, newMapArtifact } from '@/lib/artifacts'
import { NAME_PROMPT } from '@/lib/generation/artifact-name'
import { INSTRUCTION_HEAD } from '@/lib/generation/instruction'
import { PROMPTS } from '@/lib/generation/prompts.data'
import { useLibraryStore } from '@/stores/library'
import { useUiStore } from '@/stores/ui'
import { type CapturedRequest, installFetch, openAiStream, systemPromptOf, userContentOf } from '@/test/ai/fake-provider'
import { studyLibrary, studyNote } from '@/test/generation/study-fixture'

const mine = { id: 'mine', type: 'custom' as const, name: 'Minha IA', key: 'k', base: 'https://api.exemplo.dev/v1' }
const A = { uid: 'mine::modelo-a', pid: 'mine', mid: 'modelo-a', name: 'Modelo A' }
const B = { uid: 'mine::modelo-b', pid: 'mine', mid: 'modelo-b', name: 'Modelo B' }
const CONFIG: AiConfig = { providers: [mine], models: [A, B], defaults: { estudo: A.uid }, steps: {} }
const DAY = '2026-11-05T12:00:00.000Z'

const diagram = (text: string): MapArtifact['diagram'] => ({ form: 'arvore', root: { id: 'r', text, children: [] } })
const chat = (count: number): MapArtifact['chat'] => Array.from({ length: count }, (_, index) => ({ who: index % 2 ? 'ia' : 'você', text: `Fala ${index}`, at: DAY }))

let calls: CapturedRequest[] = []
let made = 0

beforeEach(() => {
  made = 0
  calls = installFetch(request => {
    const system = systemPromptOf(request)
    if (system === PROMPTS.MINDMAP_PROMPT) {
      made++
      return openAiStream(JSON.stringify({ nome: `Mapa ${made}`, forma: 'arvore', raiz: { texto: `Centro ${made}`, filhos: [{ texto: `Ramo ${made}`, filhos: [] }] } }))
    }
    if (system === PROMPTS.CARDS_PROMPT) return openAiStream(JSON.stringify({ cartoes: [{ frente: 'Quando o limite não existe?', verso: 'Quando os laterais diferem.' }] }))
    if (system === NAME_PROMPT) return openAiStream('{"nome": "Limites laterais"}')
    return openAiStream('{}')
  }).calls
})

afterEach(() => {
  vi.unstubAllGlobals()
})

async function note() {
  const memory = studyLibrary()
  useLibraryStore.setState(state => ({ index: { ...state.index, settings: { ...state.index.settings, aiConfig: CONFIG } } }))
  const id = await studyNote()
  return { id, memory }
}

const stored = (memory: ReturnType<typeof studyLibrary>, id: string) => memory.sidecars.get(id)!.artifacts ?? []
const askedWith = (prompt: string) => calls.filter(call => systemPromptOf(call) === prompt)
const radio = (name: RegExp) => screen.getByRole('radio', { name })

describe('the window to generate a map or a deck', () => {
  it('under React StrictMode (dev) the new map still opens when it is ready', async () => {
    const { id, memory } = await note()
    render(
      <StrictMode>
        <ArtifactGenerateDialog fileId={id} artifact="mapa" />
      </StrictMode>,
    )
    fireEvent.click(await screen.findByRole('button', { name: 'Gerar' }))
    await waitFor(() => expect(useUiStore.getState().overlay).toMatchObject({ kind: 'mindmap' }))
    expect(useUiStore.getState().overlay).toEqual({ kind: 'mindmap', fileId: id, artifactId: stored(memory, id)[0].id })
  })

  it('"+ Novo" of a map: the model and the instruction picked there reach the AI, stay in the map, and the new map opens', async () => {
    const { id, memory } = await note()
    render(<ArtifactGenerateDialog fileId={id} artifact="mapa" />)
    expect(await screen.findByRole('dialog', { name: 'Novo mapa mental' })).toBeInTheDocument()
    expect(screen.getByText('De “Limites”')).toBeInTheDocument()
    expect(screen.getByLabelText('Modelo da IA')).toHaveValue(A.uid)
    expect(screen.queryByRole('radiogroup')).toBeNull()
    fireEvent.change(screen.getByLabelText('Modelo da IA'), { target: { value: B.uid } })
    fireEvent.change(screen.getByLabelText('Instrução extra para a IA (opcional)'), { target: { value: 'só as decisões' } })
    fireEvent.click(screen.getByRole('button', { name: 'Gerar' }))

    await waitFor(() => expect(useUiStore.getState().overlay).toMatchObject({ kind: 'mindmap' }))
    const maps = stored(memory, id) as MapArtifact[]
    expect(maps).toHaveLength(1)
    expect(maps[0]).toMatchObject({ kind: 'mapa', name: 'Mapa 1', made: { model: B.uid, instruction: 'só as decisões', at: expect.any(String) } })
    expect(useUiStore.getState().overlay).toEqual({ kind: 'mindmap', fileId: id, artifactId: maps[0].id })
    expect(askedWith(PROMPTS.MINDMAP_PROMPT).length).toBeGreaterThan(0)
    for (const call of askedWith(PROMPTS.MINDMAP_PROMPT)) {
      expect(call.body?.model).toBe('modelo-b')
      expect(userContentOf(call).endsWith(`${INSTRUCTION_HEAD}\n\nsó as decisões`)).toBe(true)
    }
  })

  it('"+ Novo" of a deck: the same, and the new deck opens for review', async () => {
    const { id, memory } = await note()
    render(<ArtifactGenerateDialog fileId={id} artifact="cartoes" />)
    expect(await screen.findByRole('dialog', { name: 'Novo baralho de cartões' })).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('Modelo da IA'), { target: { value: B.uid } })
    fireEvent.change(screen.getByLabelText('Instrução extra para a IA (opcional)'), { target: { value: 'foque nas datas' } })
    fireEvent.click(screen.getByRole('button', { name: 'Gerar' }))

    await waitFor(() => expect(useUiStore.getState().overlay).toMatchObject({ kind: 'cards' }))
    const decks = stored(memory, id) as CardsArtifact[]
    expect(decks).toHaveLength(1)
    expect(decks[0]).toMatchObject({ kind: 'cartoes', name: 'Limites laterais', made: { model: B.uid, instruction: 'foque nas datas' } })
    expect(decks[0].cards.map(card => card.front)).toEqual(['Quando o limite não existe?'])
    expect(useUiStore.getState().overlay).toEqual({ kind: 'cards', fileId: id, deckId: decks[0].id })
    for (const call of askedWith(PROMPTS.CARDS_PROMPT)) {
      expect(call.body?.model).toBe('modelo-b')
      expect(userContentOf(call).endsWith(`${INSTRUCTION_HEAD}\n\nfoque nas datas`)).toBe(true)
    }
  })

  it('"Gerar de novo" opens with the model and the instruction of the last time and "Criar outro" checked; it keeps this one and adds another', async () => {
    const { id, memory } = await note()
    const before = await useLibraryStore.getState().saveArtifact(id, newMapArtifact({ name: 'Decisões do reajuste', diagram: diagram('Antes'), made: { model: B.uid, instruction: 'só prazos', at: DAY } }))
    render(<ArtifactGenerateDialog fileId={id} artifact="mapa" again={before.id} />)
    expect(await screen.findByRole('dialog', { name: 'Gerar de novo o mapa' })).toBeInTheDocument()
    expect(screen.getByText('“Decisões do reajuste”, de “Limites”')).toBeInTheDocument()
    expect(screen.getByText('Da última vez: Modelo B · em 05/11 · com instrução')).toBeInTheDocument()
    expect(screen.getByLabelText('Modelo da IA')).toHaveValue(B.uid)
    expect(screen.getByLabelText('Instrução extra para a IA (opcional)')).toHaveValue('só prazos')
    expect(screen.getByText('Mais opções').closest('details')).toHaveAttribute('open')
    expect(within(screen.getByRole('radiogroup', { name: 'O que fazer com o resultado' })).getAllByRole('radio')).toHaveLength(2)
    expect(radio(/Criar outro mapa/)).toHaveAttribute('aria-checked', 'true')
    expect(radio(/Substituir este/)).toHaveAttribute('aria-checked', 'false')
    fireEvent.click(screen.getByRole('button', { name: 'Gerar' }))

    await waitFor(() => expect(stored(memory, id)).toHaveLength(2))
    const [kept, added] = stored(memory, id) as MapArtifact[]
    expect(kept).toMatchObject({ id: before.id, name: 'Decisões do reajuste', diagram: diagram('Antes') })
    expect(added).toMatchObject({ name: 'Mapa 1', made: { model: B.uid, instruction: 'só prazos' } })
    expect(askedWith(PROMPTS.MINDMAP_PROMPT).every(call => call.body?.model === 'modelo-b')).toBe(true)
  })

  it('"Substituir este" on a map with a conversation warns before confirming that the conversation will be erased', async () => {
    const { id, memory } = await note()
    const before = (await useLibraryStore.getState().saveArtifact(id, newMapArtifact({ name: 'Decisões do reajuste', diagram: diagram('Antes'), made: { model: A.uid, at: DAY } }))) as MapArtifact
    await useLibraryStore.getState().saveArtifact(id, { ...before, chat: chat(4), versions: [diagram('Antes de antes')] })
    render(<ArtifactGenerateDialog fileId={id} artifact="mapa" again={before.id} />)
    await screen.findByRole('dialog', { name: 'Gerar de novo o mapa' })
    expect(screen.queryByRole('alert')).toBeNull()
    fireEvent.click(radio(/Substituir este/))
    expect(radio(/Substituir este/)).toHaveAttribute('aria-checked', 'true')
    expect(screen.getByRole('alert')).toHaveTextContent('A conversa deste mapa (4 mensagens) será apagada')
    expect((stored(memory, id)[0] as MapArtifact).chat).toHaveLength(4)
    fireEvent.click(radio(/Criar outro mapa/))
    expect(screen.queryByRole('alert')).toBeNull()
    fireEvent.click(radio(/Substituir este/))
    fireEvent.click(screen.getByRole('button', { name: 'Gerar' }))

    await waitFor(() => expect((stored(memory, id)[0] as MapArtifact).diagram.root.text).toBe('Centro 1'))
    const maps = stored(memory, id) as MapArtifact[]
    expect(maps).toHaveLength(1)
    expect(maps[0]).toMatchObject({ id: before.id, name: 'Decisões do reajuste', chat: [], versions: [] })
    expect(useUiStore.getState().overlay).toEqual({ kind: 'mindmap', fileId: id, artifactId: before.id })
  })

  it('"Substituir este" without a conversation, or on a deck, replaces with no warning, keeping the name', async () => {
    const { id, memory } = await note()
    const deck = await useLibraryStore.getState().saveArtifact(id, newCardsArtifact({ name: 'Conceitos', cards: [{ id: 'c1', front: 'Velho', back: 'v', box: 3, due: '2999-01-01' }] }))
    render(<ArtifactGenerateDialog fileId={id} artifact="cartoes" again={deck.id} />)
    expect(await screen.findByRole('dialog', { name: 'Gerar de novo o baralho' })).toBeInTheDocument()
    expect(radio(/Criar outro baralho/)).toHaveAttribute('aria-checked', 'true')
    fireEvent.click(radio(/Substituir este/))
    expect(screen.queryByRole('alert')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Gerar' }))
    await waitFor(() => expect((stored(memory, id)[0] as CardsArtifact).cards[0].front).toBe('Quando o limite não existe?'))
    expect(stored(memory, id)).toHaveLength(1)
    expect(stored(memory, id)[0]).toMatchObject({ id: deck.id, name: 'Conceitos' })
    expect(useUiStore.getState().overlay).toEqual({ kind: 'cards', fileId: id, deckId: deck.id })
  })

  it('a failure keeps the window open with the reason and saves nothing', async () => {
    installFetch(() => openAiStream('não sei'))
    const { id, memory } = await note()
    render(<ArtifactGenerateDialog fileId={id} artifact="mapa" />)
    fireEvent.click(await screen.findByRole('button', { name: 'Gerar' }))
    expect(await screen.findByText('A IA não devolveu um mapa. Tente de novo.')).toBeInTheDocument()
    expect(screen.getByRole('dialog', { name: 'Novo mapa mental' })).toBeInTheDocument()
    expect(stored(memory, id)).toHaveLength(0)
    expect(useUiStore.getState().overlay).toBeNull()
  })

  it('the "+ Novo" and "Gerar de novo…" of the list open this window', async () => {
    const { id } = await note()
    const map = await useLibraryStore.getState().saveArtifact(id, newMapArtifact({ name: 'Limites', diagram: diagram('Limites') }))
    render(
      <MemoryRouter>
        <InspectorBody fileId={id} tab="mine" />
        <Overlays />
      </MemoryRouter>,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Novo baralho de cartões' }))
    expect(await screen.findByRole('dialog', { name: 'Novo baralho de cartões' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Cancelar' }))
    expect(screen.queryByRole('dialog')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: `Opções de ${map.name}` }))
    fireEvent.click(within(screen.getByRole('menu')).getByRole('menuitem', { name: 'Gerar de novo…' }))
    expect(await screen.findByRole('dialog', { name: 'Gerar de novo o mapa' })).toBeInTheDocument()
  })
})
