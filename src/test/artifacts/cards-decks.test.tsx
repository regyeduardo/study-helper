import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'

import type { CardsArtifact, StudyCard } from '@/types/domain'
import { ArtifactGenerateDialog } from '@/components/dialogs/ArtifactGenerateDialog'
import { CardsDialog } from '@/components/dialogs/CardsDialog'
import { newCardsArtifact } from '@/lib/artifacts'
import { NAME_PROMPT } from '@/lib/generation/artifact-name'
import { generateCards } from '@/lib/generation/cards'
import { INSTRUCTION_HEAD } from '@/lib/generation/instruction'
import { CHUNK_CHARS } from '@/lib/generation/minutes'
import { PROMPTS } from '@/lib/generation/prompts.data'
import type { GenerationSession } from '@/lib/generation/session'
import { useLibraryStore } from '@/stores/library'
import { useUiStore } from '@/stores/ui'
import { type CapturedRequest, installFetch, openAiStream, systemPromptOf, userContentOf } from '@/test/ai/fake-provider'
import { studyLibrary, studyNote } from '@/test/generation/study-fixture'

const PAST = '2026-01-01'
const LATER = '2999-01-01'

function card(id: string, due: string, box = 0): StudyCard {
  return { id, front: `Frente ${id}`, back: `Verso ${id}`, box, due }
}

function fakeAi(answer: (input: string, system: string) => string) {
  const chat = vi.fn(async (input: string, system: string) => answer(input, system))
  return { session: { chat } as unknown as GenerationSession, chat }
}

/** The two windows of this flow, switched by the overlay as Overlays does. */
function Screen({ fileId }: { fileId: string }) {
  const overlay = useUiStore(state => state.overlay)
  if (overlay?.kind === 'generate-artifact') return <ArtifactGenerateDialog fileId={overlay.fileId} artifact={overlay.artifact} again={overlay.again} />
  if (overlay?.kind === 'cards') return <CardsDialog fileId={overlay.fileId} deckId={overlay.deckId} />
  return <CardsDialog fileId={fileId} />
}

const twelve = (part: number) => JSON.stringify({ cartoes: Array.from({ length: 12 }, (_, index) => ({ frente: `Parte ${part} pergunta ${index}`, verso: 'resposta' })) })

describe('generateCards', () => {
  it('reads the whole note in parts, with the instruction in each, and names the deck', async () => {
    let part = 0
    const { session, chat } = fakeAi((_input, system) => (system === NAME_PROMPT ? '{"nome": "Datas da Revolução"}' : twelve(++part)))
    const note = Array.from({ length: 8 }, (_, index) => `Bloco ${index} ${'texto '.repeat(CHUNK_CHARS / 6)}`).join('\n\n')
    const made = await generateCards(note, session, 'foque em datas')
    const parts = chat.mock.calls.filter(([, system]) => system === PROMPTS.CARDS_PROMPT)
    expect(parts.length).toBeGreaterThan(5)
    expect(parts.every(([input]) => String(input).endsWith(`${INSTRUCTION_HEAD}\n\nfoque em datas`))).toBe(true)
    expect(made.cards.length).toBeLessThanOrEqual(60)
    expect(made.cards.at(-1)?.front).toMatch(new RegExp(`^Parte ${parts.length} `))
    expect(made.name).toBe('Datas da Revolução')
    expect(chat.mock.calls.at(-1)?.[1]).toBe(NAME_PROMPT)
    expect(chat.mock.calls.at(-1)?.[0]).toContain('Parte 1 pergunta 0')
  })

  it('without a name from the AI the deck keeps none, and no cards means no naming call', async () => {
    const { session, chat } = fakeAi(() => '{"cartoes": [{"frente": "f", "verso": "v"}]}')
    expect(await generateCards('Limites', session)).toMatchObject({ name: null, cards: [{ front: 'f', back: 'v', box: 0 }] })
    const empty = fakeAi(() => '{"cartoes": []}')
    expect(await generateCards('Limites', empty.session)).toEqual({ cards: [], name: null })
    expect(empty.chat).toHaveBeenCalledTimes(1)
    expect(chat).toHaveBeenCalledTimes(2)
  })
})

async function noteWithDecks(...decks: CardsArtifact[]) {
  const memory = studyLibrary()
  const id = await studyNote()
  for (const deck of decks) await useLibraryStore.getState().saveArtifact(id, deck)
  return { id, memory }
}

const storedDeck = (memory: ReturnType<typeof studyLibrary>, id: string, deckId: string) => memory.sidecars.get(id)!.artifacts!.find(item => item.id === deckId) as CardsArtifact

describe('CardsDialog with several decks', () => {
  const asked: string[] = []

  beforeEach(() => {
    asked.length = 0
    installFetch((request: CapturedRequest) => {
      const system = systemPromptOf(request)
      asked.push(system)
      if (system === NAME_PROMPT) return openAiStream('{"nome": "Limites laterais"}')
      return openAiStream(JSON.stringify({ cartoes: [{ frente: 'Quando o limite não existe?', verso: 'Quando os laterais diferem.' }, { frente: 'O que exige a continuidade?', verso: 'Limite igual ao valor.' }] }))
    })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('"Revisar" joins the due cards of every deck and saves each answer in its own deck', async () => {
    const first = newCardsArtifact({ name: 'Conceitos', cards: [card('a1', PAST), card('a2', LATER)] })
    const second = newCardsArtifact({ name: 'Datas', cards: [card('b1', PAST), card('b2', PAST)] })
    const { id, memory } = await noteWithDecks(first, second)
    render(<CardsDialog fileId={id} />)
    expect(await screen.findByText('3 para hoje · 4 cartões')).toBeInTheDocument()
    expect(screen.getByText('Frente a1')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Mostrar a resposta' }))
    fireEvent.click(screen.getByRole('button', { name: 'Acertei' }))
    expect(await screen.findByText('Frente b1')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Mostrar a resposta' }))
    fireEvent.click(screen.getByRole('button', { name: 'Acertei' }))
    await waitFor(() => expect(storedDeck(memory, id, second.id).cards.map(item => item.box)).toEqual([1, 0]))
    expect(storedDeck(memory, id, first.id).cards.map(item => item.box)).toEqual([1, 0])
    expect(useLibraryStore.getState().files.find(file => file.id === id)?.cardDue).toHaveLength(4)
  })

  it('opening one deck by its id reviews only that deck', async () => {
    const first = newCardsArtifact({ name: 'Conceitos', cards: [card('a1', PAST)] })
    const second = newCardsArtifact({ name: 'Datas', cards: [card('b1', PAST), card('b2', PAST)] })
    const { id } = await noteWithDecks(first, second)
    render(<CardsDialog fileId={id} deckId={second.id} />)
    expect(await screen.findByText('2 para hoje · 2 cartões')).toBeInTheDocument()
    expect(screen.getByText('Frente b1')).toBeInTheDocument()
  })

  it('making the cards again creates another deck, named by the AI, and reviews it', async () => {
    const first = newCardsArtifact({ name: 'Conceitos', cards: [card('a1', LATER)] })
    const { id, memory } = await noteWithDecks(first)
    render(<Screen fileId={id} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Fazer outro baralho' }))
    // "Fazer outro baralho" goes to the generate window shared with the maps, which opens the new deck for review
    fireEvent.click(await screen.findByRole('button', { name: 'Gerar' }))
    expect(await screen.findByText('Quando o limite não existe?')).toBeInTheDocument()
    expect(screen.getByText('2 para hoje · 2 cartões')).toBeInTheDocument()
    expect(asked).toEqual([PROMPTS.CARDS_PROMPT, NAME_PROMPT])
    const decks = memory.sidecars.get(id)!.artifacts!
    expect(decks.map(item => item.name)).toEqual(['Conceitos', 'Limites laterais'])
    expect(decks[1]).toMatchObject({ kind: 'cartoes', made: { model: expect.any(String), at: expect.any(String) } })
    expect(decks[1].provisionalName).toBeUndefined()
  })

  it('reviews the cards of a note saved before decks existed, keeping their progress', async () => {
    const memory = studyLibrary()
    const id = await studyNote()
    const sidecar = memory.sidecars.get(id)!
    memory.sidecars.set(id, { ...sidecar, cards: [card('c1', PAST, 2), card('c2', LATER, 4)], meta: { ...sidecar.meta, cardDue: [PAST, LATER] } })
    useLibraryStore.setState({ opened: {} })
    render(<CardsDialog fileId={id} />)
    expect(await screen.findByText('1 para hoje · 2 cartões')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Mostrar a resposta' }))
    fireEvent.click(screen.getByRole('button', { name: 'Acertei' }))
    await waitFor(() => expect((memory.sidecars.get(id)!.artifacts?.[0] as CardsArtifact | undefined)?.cards.map(item => item.box)).toEqual([3, 4]))
    expect(memory.sidecars.get(id)!.artifacts).toHaveLength(1)
    await waitFor(() => expect(memory.sidecars.get(id)!.cards).toBeUndefined())
  })
})

describe('o primeiro baralho e "Fazer outro baralho" (FR-003)', () => {
  const answer = () => {
    const asked: string[] = []
    installFetch(request => {
      if (systemPromptOf(request) === PROMPTS.CARDS_PROMPT) asked.push(userContentOf(request))
      return openAiStream(systemPromptOf(request) === PROMPTS.CARDS_PROMPT ? JSON.stringify({ cartoes: [{ frente: 'Qual a data?', verso: 'Maio.' }] }) : '{"nome": "Datas"}')
    })
    return asked
  }

  afterEach(() => vi.unstubAllGlobals())

  it('o primeiro baralho aceita a instrução, que chega à IA e fica no baralho', async () => {
    const asked = answer()
    const memory = studyLibrary()
    const id = await studyNote()
    render(<CardsDialog fileId={id} />)
    fireEvent.change(await screen.findByLabelText('Instrução extra para a IA (opcional)'), { target: { value: 'foque nas datas' } })
    fireEvent.click(screen.getByRole('button', { name: 'Fazer os cartões' }))
    await waitFor(() => expect(memory.sidecars.get(id)?.artifacts).toHaveLength(1))
    expect(asked.every(text => text.endsWith(`${INSTRUCTION_HEAD}\n\nfoque nas datas`))).toBe(true)
    expect((memory.sidecars.get(id)!.artifacts![0] as CardsArtifact).made?.instruction).toBe('foque nas datas')
  })

  it('"Fazer outro baralho" abre a janela de gerar, com o modelo e a instrução', async () => {
    answer()
    const memory = studyLibrary()
    const id = await studyNote()
    await useLibraryStore.getState().saveArtifact(id, newCardsArtifact({ name: 'Primeiro', cards: [card('a', LATER)] }))
    render(<CardsDialog fileId={id} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Fazer outro baralho' }))
    await waitFor(() => expect(useUiStore.getState().overlay).toEqual({ kind: 'generate-artifact', fileId: id, artifact: 'cartoes' }))
    expect(memory.sidecars.get(id)!.artifacts).toHaveLength(1)
  })
})
