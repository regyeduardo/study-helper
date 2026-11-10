import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

import type { AiConfig, Artifact, MapArtifact, StudyCard, TutorArtifact } from '@/types/domain'
import { Overlays } from '@/components/dialogs/Overlays'
import { hasGenerated, InspectorBody, InspectorTabs } from '@/components/reader/Inspector'
import { newCardsArtifact, newMapArtifact, newTutorArtifact } from '@/lib/artifacts'
import { useLibraryStore } from '@/stores/library'
import { useUiStore } from '@/stores/ui'
import { installFetch, openAiStream } from '@/test/ai/fake-provider'
import { studyLibrary, studyNote } from '@/test/generation/study-fixture'

const mine = { id: 'mine', type: 'custom' as const, name: 'Minha IA', key: 'k', base: 'https://api.exemplo.dev/v1' }
const A = { uid: 'mine::modelo-a', pid: 'mine', mid: 'modelo-a', name: 'Modelo A' }
const B = { uid: 'mine::modelo-b', pid: 'mine', mid: 'modelo-b', name: 'Modelo B' }
const CONFIG: AiConfig = { providers: [mine], models: [A, B], defaults: { estudo: A.uid }, steps: {} }

const PAST = '2026-01-01'
const LATER = '2999-01-01'
const day = (date: string) => `2026-11-${date}T12:00:00.000Z`

const diagram = (text: string): MapArtifact['diagram'] => ({ form: 'arvore', root: { id: 'r', text, children: [] } })
const card = (id: string, due: string): StudyCard => ({ id, front: `Frente ${id}`, back: `Verso ${id}`, box: 0, due })
const chat = (count: number): MapArtifact['chat'] => Array.from({ length: count }, (_, index) => ({ who: index % 2 ? 'ia' : 'você', text: `Fala ${index}`, at: day('05') }))

/** A note with these artifacts, each saved on its day (the list shows the newest first). */
async function noteWith(...dated: [string, Artifact][]) {
  const memory = studyLibrary()
  useLibraryStore.setState(state => ({ index: { ...state.index, settings: { ...state.index.settings, aiConfig: CONFIG } } }))
  const id = await studyNote()
  vi.useFakeTimers({ toFake: ['Date'] })
  for (const [date, artifact] of dated) {
    vi.setSystemTime(new Date(day(date)))
    await useLibraryStore.getState().saveArtifact(id, artifact)
  }
  vi.useRealTimers()
  return { id, memory }
}

const region = (name: string) => screen.getByRole('region', { name })
const namesIn = (name: string) =>
  within(region(name))
    .queryAllByRole('listitem')
    .map(item => item.querySelector('b')?.textContent)
const stored = (memory: ReturnType<typeof studyLibrary>, id: string) => memory.sidecars.get(id)!.artifacts ?? []
const overlay = () => useUiStore.getState().overlay

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('the "Desta nota" tab lists the artifacts by type', () => {
  it('shows each artifact by name in its section, newest first, with date, model and what it holds', async () => {
    const older = newMapArtifact({ name: 'Visão geral do projeto', diagram: diagram('Visão'), made: { model: B.uid, at: day('03') } })
    const newer = { ...newMapArtifact({ name: 'Decisões do reajuste', diagram: diagram('Decisões'), made: { model: A.uid, instruction: 'só as decisões', at: day('05') } }), chat: chat(3) }
    const deck = newCardsArtifact({ name: 'Prazos e valores', cards: [card('a', PAST), card('b', LATER), card('c', PAST)], made: { model: A.uid, at: day('04') } })
    const talk = newTutorArtifact({ turns: [{ who: 'você', text: 'Como o INCC entra no preço?' }, { who: 'tutor', text: 'Pelo reajuste.' }] })
    const { id } = await noteWith(['03', older], ['05', newer], ['04', deck], ['06', talk])
    render(<InspectorBody fileId={id} tab="mine" />)

    expect(within(region('Mapas mentais')).getByRole('heading', { name: 'Mapas mentais · 2' })).toBeInTheDocument()
    expect(namesIn('Mapas mentais')).toEqual(['Decisões do reajuste', 'Visão geral do projeto'])
    expect(within(region('Mapas mentais')).getByText('05/11 · Modelo A')).toBeInTheDocument()
    expect(within(region('Mapas mentais')).getByText('03/11 · Modelo B')).toBeInTheDocument()

    expect(within(region('Cartões')).getByRole('heading', { name: 'Cartões · 1' })).toBeInTheDocument()
    expect(namesIn('Cartões')).toEqual(['Prazos e valores'])
    expect(within(region('Cartões')).getByText('2 para hoje de 3 · 04/11 · Modelo A')).toBeInTheDocument()

    expect(within(region('Conversas do Tutor')).getByRole('heading', { name: 'Conversas do Tutor · 1' })).toBeInTheDocument()
    expect(namesIn('Conversas do Tutor')).toEqual(['Como o INCC entra no preço?'])
    expect(within(region('Conversas do Tutor')).getByText('2 mensagens · 06/11')).toBeInTheDocument()
  })

  it('the map shows its conversation as a sub-item with the number of messages, and it opens that map', async () => {
    const quiet = newMapArtifact({ name: 'Sem conversa', diagram: diagram('Quieto') })
    const talked = { ...newMapArtifact({ name: 'Com conversa', diagram: diagram('Falado') }), chat: chat(12) }
    const { id } = await noteWith(['03', quiet], ['05', talked])
    render(<InspectorBody fileId={id} tab="mine" />)
    const subs = within(region('Mapas mentais')).getAllByRole('button', { name: /Conversa do mapa/ })
    expect(subs).toHaveLength(1)
    expect(subs[0]).toHaveAccessibleName('Conversa do mapa · 12 mensagens')
    expect(screen.getAllByRole('listitem')[0]).toContainElement(subs[0])
    fireEvent.click(subs[0])
    expect(overlay()).toEqual({ kind: 'mindmap', fileId: id, artifactId: talked.id })
  })

  it('the Prova stays out of the artifact list but keeps its own section in the tab, with questions, Domínio and Fazer de novo', async () => {
    const { id } = await noteWith(['05', newMapArtifact({ name: 'Limites', diagram: diagram('Limites') })])
    await useLibraryStore.getState().updateFile(id, { questionCount: 8, mastery: 70 })
    render(<InspectorBody fileId={id} tab="mine" />)
    expect(namesIn('Mapas mentais')).toEqual(['Limites'])
    for (const name of ['Mapas mentais', 'Cartões', 'Conversas do Tutor']) expect(within(region(name)).queryByText(/Prova|questões|Domínio/)).toBeNull()
    expect(screen.getByRole('heading', { name: 'Prova' })).toBeInTheDocument()
    expect(screen.getByText(/Domínio: 70%/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Fazer de novo · 8 questões' }))
    expect(overlay()).toEqual({ kind: 'exam', fileId: id })
  })

  it('a note with only a Prova shows the tab, with the Prova and the empty sections', async () => {
    const { id } = await noteWith()
    await useLibraryStore.getState().updateFile(id, { questionCount: 5, mastery: 40 })
    expect(hasGenerated(useLibraryStore.getState().files.find(file => file.id === id))).toBe(true)
    render(<InspectorTabs fileId={id} tab="mine" onTab={() => undefined} />)
    expect(screen.getByRole('tab', { name: 'Desta nota' })).toBeInTheDocument()
    render(<InspectorBody fileId={id} tab="mine" />)
    expect(screen.getByRole('button', { name: 'Fazer de novo · 5 questões' })).toBeInTheDocument()
    expect(screen.getByText(/Domínio: 40%/)).toBeInTheDocument()
    expect(namesIn('Mapas mentais')).toEqual([])
  })

  it('a type with nothing shows only its "+ Novo", which opens the window to generate it', async () => {
    const { id } = await noteWith(['05', newMapArtifact({ name: 'Limites', diagram: diagram('Limites') })])
    render(<InspectorBody fileId={id} tab="mine" />)
    expect(within(region('Cartões')).getByRole('heading', { name: 'Cartões' })).toBeInTheDocument()
    expect(namesIn('Cartões')).toEqual([])
    expect(within(region('Cartões')).getAllByRole('button').map(button => button.getAttribute('aria-label'))).toEqual(['Novo baralho de cartões'])
    expect(within(region('Conversas do Tutor')).getAllByRole('button').map(button => button.getAttribute('aria-label'))).toEqual(['Nova conversa do Tutor'])

    fireEvent.click(screen.getByRole('button', { name: 'Novo mapa mental' }))
    expect(overlay()).toEqual({ kind: 'generate-artifact', fileId: id, artifact: 'mapa' })
    fireEvent.click(screen.getByRole('button', { name: 'Novo baralho de cartões' }))
    expect(overlay()).toEqual({ kind: 'generate-artifact', fileId: id, artifact: 'cartoes' })
    fireEvent.click(screen.getByRole('button', { name: 'Nova conversa do Tutor' }))
    expect(overlay()).toEqual({ kind: 'tutor', fileId: id, conversationId: null })
  })

  it('a note with only a Tutor conversation shows the tab', async () => {
    const { id } = await noteWith(['05', newTutorArtifact({ turns: [{ who: 'você', text: 'O que é limite?' }] })])
    render(<InspectorTabs fileId={id} tab="toc" onTab={() => undefined} />)
    expect(screen.getByRole('tab', { name: 'Desta nota' })).toBeInTheDocument()
  })

  it('the menu of each one has Abrir, Renomear, Gerar de novo and Apagar; a Tutor conversation has no Gerar de novo', async () => {
    const map = newMapArtifact({ name: 'Limites', diagram: diagram('Limites') })
    const deck = newCardsArtifact({ name: 'Conceitos', cards: [card('a', PAST)] })
    const talk = newTutorArtifact({ turns: [{ who: 'você', text: 'O que é limite?' }] })
    const { id } = await noteWith(['03', map], ['04', deck], ['05', talk])
    render(<InspectorBody fileId={id} tab="mine" />)
    const items = () =>
      within(screen.getByRole('menu'))
        .getAllByRole('menuitem')
        .map(item => item.textContent)

    fireEvent.click(screen.getByRole('button', { name: 'Opções de Limites' }))
    expect(items()).toEqual(['Abrir', 'Renomear', 'Gerar de novo…', 'Apagar'])
    fireEvent.click(within(screen.getByRole('menu')).getByRole('menuitem', { name: 'Gerar de novo…' }))
    expect(overlay()).toEqual({ kind: 'generate-artifact', fileId: id, artifact: 'mapa', again: map.id })
    expect(screen.queryByRole('menu')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Opções de Conceitos' }))
    expect(items()).toEqual(['Abrir', 'Renomear', 'Gerar de novo…', 'Apagar'])
    fireEvent.click(within(screen.getByRole('menu')).getByRole('menuitem', { name: 'Gerar de novo…' }))
    expect(overlay()).toEqual({ kind: 'generate-artifact', fileId: id, artifact: 'cartoes', again: deck.id })

    fireEvent.click(screen.getByRole('button', { name: 'Opções de O que é limite?' }))
    expect(items()).toEqual(['Abrir', 'Renomear', 'Apagar'])
    fireEvent.click(within(screen.getByRole('menu')).getByRole('menuitem', { name: 'Abrir' }))
    expect(overlay()).toEqual({ kind: 'tutor', fileId: id, conversationId: talk.id })
  })

  it('opens a map, a deck or a conversation by its name', async () => {
    const map = newMapArtifact({ name: 'Limites', diagram: diagram('Limites') })
    const deck = newCardsArtifact({ name: 'Conceitos', cards: [card('a', PAST)] })
    const talk = newTutorArtifact({ turns: [{ who: 'você', text: 'O que é limite?' }] })
    const { id } = await noteWith(['03', map], ['04', deck], ['05', talk])
    render(<InspectorBody fileId={id} tab="mine" />)
    fireEvent.click(screen.getByRole('button', { name: 'Limites' }))
    expect(overlay()).toEqual({ kind: 'mindmap', fileId: id, artifactId: map.id })
    fireEvent.click(screen.getByRole('button', { name: 'Conceitos' }))
    expect(overlay()).toEqual({ kind: 'cards', fileId: id, deckId: deck.id })
    fireEvent.click(screen.getByRole('button', { name: 'O que é limite?' }))
    expect(overlay()).toEqual({ kind: 'tutor', fileId: id, conversationId: talk.id })
  })

  it('Renomear changes the name in place; Esc keeps the old one', async () => {
    const map = newMapArtifact({ name: 'Limites', diagram: diagram('Limites') })
    const { id, memory } = await noteWith(['05', map])
    render(<InspectorBody fileId={id} tab="mine" />)
    fireEvent.click(screen.getByRole('button', { name: 'Opções de Limites' }))
    fireEvent.click(within(screen.getByRole('menu')).getByRole('menuitem', { name: 'Renomear' }))
    const input = screen.getByRole('textbox', { name: 'Novo nome' })
    expect(input).toHaveValue('Limites')
    fireEvent.change(input, { target: { value: 'Esquecido' } })
    fireEvent.keyDown(input, { key: 'Escape' })
    expect(screen.queryByRole('textbox', { name: 'Novo nome' })).toBeNull()
    expect(namesIn('Mapas mentais')).toEqual(['Limites'])

    fireEvent.click(screen.getByRole('button', { name: 'Opções de Limites' }))
    fireEvent.click(within(screen.getByRole('menu')).getByRole('menuitem', { name: 'Renomear' }))
    fireEvent.change(screen.getByRole('textbox', { name: 'Novo nome' }), { target: { value: 'Limites laterais' } })
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Novo nome' }), { key: 'Enter' })
    await waitFor(() => expect(stored(memory, id).map(item => item.name)).toEqual(['Limites laterais']))
    expect(namesIn('Mapas mentais')).toEqual(['Limites laterais'])
  })

  it('Apagar asks first, saying the map conversation goes too, then takes it out of the note', async () => {
    const talked = { ...newMapArtifact({ name: 'Com conversa', diagram: diagram('Falado') }), chat: chat(4) }
    const other = newMapArtifact({ name: 'Outro', diagram: diagram('Outro') })
    const { id, memory } = await noteWith(['03', other], ['05', talked])
    render(
      <MemoryRouter>
        <InspectorBody fileId={id} tab="mine" />
        <Overlays />
      </MemoryRouter>,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Opções de Com conversa' }))
    fireEvent.click(within(screen.getByRole('menu')).getByRole('menuitem', { name: 'Apagar' }))
    const ask = screen.getByRole('alertdialog', { name: 'Apagar “Com conversa”?' })
    expect(ask).toHaveTextContent('a conversa dele (4 mensagens)')
    expect(stored(memory, id)).toHaveLength(2)
    fireEvent.click(within(ask).getByRole('button', { name: 'Apagar' }))
    await waitFor(() => expect(stored(memory, id).map(item => item.name)).toEqual(['Outro']))
    expect(namesIn('Mapas mentais')).toEqual(['Outro'])
  })

  it('a deck and a conversation open by name in their windows: only that deck, that conversation', async () => {
    installFetch(() => openAiStream('Resposta.'))
    const first = newCardsArtifact({ name: 'Conceitos', cards: [card('a1', PAST), card('a2', PAST)] })
    const second = newCardsArtifact({ name: 'Datas', cards: [card('b1', PAST)] })
    const old = newTutorArtifact({ turns: [{ who: 'você', text: 'O que é limite?' }, { who: 'tutor', text: 'Resposta antiga.' }] })
    const recent = newTutorArtifact({ turns: [{ who: 'você', text: 'E a continuidade?' }, { who: 'tutor', text: 'Resposta nova.' }] })
    const { id } = await noteWith(['03', first], ['04', second], ['05', old], ['06', recent])
    render(
      <MemoryRouter>
        <InspectorBody fileId={id} tab="mine" />
        <Overlays />
      </MemoryRouter>,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Datas' }))
    expect(await screen.findByText('1 para hoje · 1 cartões')).toBeInTheDocument()
    expect(screen.getByText('Frente b1')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Fechar' }))

    fireEvent.click(screen.getByRole('button', { name: 'O que é limite?' }))
    const talk = await screen.findByRole('list', { name: 'Conversa com o tutor' })
    await waitFor(() => expect(talk).toHaveTextContent('O que é limite?'))
    expect(talk).not.toHaveTextContent('E a continuidade?')
    fireEvent.click(screen.getByRole('button', { name: 'Fechar' }))

    fireEvent.click(screen.getByRole('button', { name: 'Nova conversa do Tutor' }))
    const fresh = await screen.findByRole('list', { name: 'Conversa com o tutor' })
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(within(fresh).queryAllByRole('listitem')).toHaveLength(0)
  })

  it('with many, each section shows the 3 newest and "Ver todos" opens the rest in place', async () => {
    const maps = Array.from({ length: 6 }, (_, index) => newMapArtifact({ name: `Mapa ${index + 1}`, diagram: diagram(`M${index}`) }))
    const decks = Array.from({ length: 3 }, (_, index) => newCardsArtifact({ name: `Baralho ${index + 1}`, cards: [card(`c${index}`, LATER)] }))
    const talks = Array.from({ length: 4 }, (_, index) => newTutorArtifact({ turns: [{ who: 'você', text: `Pergunta ${index + 1}` }] }))
    const dated = [...maps, ...decks, ...talks].map((item, index): [string, Artifact] => [String(index + 1).padStart(2, '0'), item])
    const { id } = await noteWith(...dated)
    render(<InspectorBody fileId={id} tab="mine" />)

    expect(within(region('Mapas mentais')).getByRole('heading', { name: 'Mapas mentais · 6' })).toBeInTheDocument()
    expect(namesIn('Mapas mentais')).toEqual(['Mapa 6', 'Mapa 5', 'Mapa 4'])
    fireEvent.click(within(region('Mapas mentais')).getByRole('button', { name: 'Ver todos os 6' }))
    expect(namesIn('Mapas mentais')).toEqual(['Mapa 6', 'Mapa 5', 'Mapa 4', 'Mapa 3', 'Mapa 2', 'Mapa 1'])
    fireEvent.click(within(region('Mapas mentais')).getByRole('button', { name: 'Ver menos' }))
    expect(namesIn('Mapas mentais')).toHaveLength(3)

    expect(namesIn('Cartões')).toEqual(['Baralho 3', 'Baralho 2', 'Baralho 1'])
    expect(within(region('Cartões')).queryByRole('button', { name: /Ver todos/ })).toBeNull()
    expect(within(region('Cartões')).getByText('nada para hoje · 1 cartão · 09/11')).toBeInTheDocument()

    expect(namesIn('Conversas do Tutor')).toEqual(['Pergunta 4', 'Pergunta 3', 'Pergunta 2'])
    fireEvent.click(within(region('Conversas do Tutor')).getByRole('button', { name: 'Ver todas as 4' }))
    expect(namesIn('Conversas do Tutor')).toHaveLength(4)
  })

  it('the highlights and notes show as Marcações, which lead to the Notas tab', async () => {
    const { id } = await noteWith(['05', newMapArtifact({ name: 'Limites', diagram: diagram('Limites') })])
    const mark = (kind: 'highlight' | 'note', key: string) => useLibraryStore.getState().saveHighlight(id, { id: key, kind, quote: 'limite', text: '', color: 'yellow', startOffset: null, endOffset: null, createdAt: day('05'), updatedAt: day('05') })
    await mark('highlight', 'h1')
    await mark('highlight', 'h2')
    await mark('note', 'n1')
    useUiStore.setState({ inspectorTab: 'mine' })
    render(<InspectorBody fileId={id} tab="mine" />)
    expect(screen.getByText('2 destaques · 1 nota · na aba Notas')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Marcações' }))
    expect(useUiStore.getState().inspectorTab).toBe('notes')
  })
})

beforeEach(() => {
  useUiStore.setState({ overlay: null })
})
