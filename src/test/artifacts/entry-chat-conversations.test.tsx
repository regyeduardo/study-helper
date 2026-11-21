import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'

const kept = vi.hoisted(() => new Map<string, File>())

vi.mock('@/lib/recording/media-library', async importOriginal => ({
  ...(await importOriginal<typeof import('@/lib/recording/media-library')>()),
  readLocalMedia: vi.fn(async (item: { fileIds: string[] }) => kept.get(item.fileIds[0])!),
}))

// the reply as plain text: the real viewer draws it in a shadow root
vi.mock('@/components/reader/GithubMarkdownView', async importOriginal => ({
  ...(await importOriginal<typeof import('@/components/reader/GithubMarkdownView')>()),
  default: ({ markdown }: { markdown: string }) => <div data-testid="reply">{markdown}</div>,
}))

import type { Artifact } from '@/types/domain'
import { TutorDialog } from '@/components/dialogs/TutorDialog'
import { InspectorBody } from '@/components/reader/Inspector'
import { newTutorArtifact } from '@/lib/artifacts'
import { conversationsOf, lastConversation, scopeOf, withTurns } from '@/lib/generation/tutor'
import { useLibraryStore } from '@/stores/library'
import { type CapturedRequest, installFetch, openAiStream, userContentOf } from '@/test/ai/fake-provider'
import { chatEntry, savedConversations, seedConversations } from '@/test/artifacts/entry-chat-helpers'
import { studyLibrary, studyNote } from '@/test/generation/study-fixture'

const turns = (question: string, answer = 'Resposta.') => [
  { who: 'você' as const, text: question },
  { who: 'tutor' as const, text: answer },
]

describe('de quem é cada conversa: do Chat ou do Tutor', () => {
  const chatOne = { ...newTutorArtifact({ turns: turns('Pergunta do chat') }), scope: 'chat' as const, updatedAt: '2026-11-05T12:00:00.000Z' }
  const tutorOne = { ...newTutorArtifact({ turns: turns('Pergunta do tutor') }), scope: 'tutor' as const, updatedAt: '2026-11-06T12:00:00.000Z' }
  const old = { ...newTutorArtifact({ turns: turns('Pergunta antiga') }), updatedAt: '2026-11-04T12:00:00.000Z' }
  const list: Artifact[] = [chatOne, tutorOne, old]

  it('a conversa leva a marca de onde nasceu', () => {
    expect(withTurns(null, [{ who: 'você', text: 'Oi?' }], 'chat')).toMatchObject({ kind: 'tutor', scope: 'chat' })
    expect(withTurns(null, [{ who: 'você', text: 'Oi?' }], 'tutor')).toMatchObject({ scope: 'tutor' })
    expect(withTurns(null, [{ who: 'você', text: 'Oi?' }])).not.toHaveProperty('scope')
    const started = withTurns(null, [{ who: 'você', text: 'Oi?' }], 'chat')
    expect(withTurns(started, [...started.turns, { who: 'tutor', text: 'Olá' }])).toMatchObject({ scope: 'chat' })
  })

  it('a antiga, sem marca: é do Chat numa entrada e do Tutor numa nota', () => {
    expect(scopeOf(old, true)).toBe('chat')
    expect(scopeOf(old, false)).toBe('tutor')
    expect(scopeOf(chatOne, false)).toBe('chat')
    expect(scopeOf(tutorOne, true)).toBe('tutor')
  })

  it('conversationsOf: só as do lado pedido, da mais nova para a mais velha', () => {
    expect(conversationsOf(list, 'chat', true).map(item => item.name)).toEqual(['Pergunta do chat', 'Pergunta antiga'])
    expect(conversationsOf(list, 'tutor', true).map(item => item.name)).toEqual(['Pergunta do tutor'])
    expect(conversationsOf(list, 'tutor', false).map(item => item.name)).toEqual(['Pergunta do tutor', 'Pergunta antiga'])
    expect(conversationsOf(list, 'chat', false).map(item => item.name)).toEqual(['Pergunta do chat'])
  })

  it('lastConversation com o lado: o Tutor não retoma a conversa do Chat e vice-versa', () => {
    expect(lastConversation(list, 'chat', true)?.name).toBe('Pergunta do chat')
    expect(lastConversation(list, 'tutor', true)?.name).toBe('Pergunta do tutor')
    expect(lastConversation([chatOne], 'tutor', false)).toBeNull()
    expect(lastConversation(list)?.name).toBe('Pergunta do tutor')
  })
})

const inputs: string[] = []

beforeEach(() => {
  kept.clear()
  inputs.length = 0
  installFetch((request: CapturedRequest) => {
    inputs.push(userContentOf(request))
    return openAiStream(`Resposta ${inputs.length}.`)
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

async function ask(question: string) {
  fireEvent.change(screen.getByRole('textbox', { name: 'Sua pergunta ou resposta' }), { target: { value: question } })
  fireEvent.click(screen.getByRole('button', { name: 'Enviar' }))
}

const talk = () =>
  within(screen.getByRole('list', { name: 'Conversa do chat' }))
    .queryAllByRole('listitem')
    .map(item => item.querySelector('b')?.textContent)

const showList = () => fireEvent.click(screen.getByRole('button', { name: /^Conversas/ }))
const rows = () =>
  within(screen.getByRole('list', { name: 'Conversas do chat' }))
    .getAllByRole('listitem')
    .map(item => item.querySelector('b')?.textContent)

/** Three conversations on the entrada: two of the Chat (one old, with no mark) and one of the Tutor. */
async function withHistory() {
  const base = await chatEntry({ kept })
  await seedConversations(base.entry, [
    { id: 'c-prazo', turns: turns('Qual o prazo do portal?', 'Março.'), updatedAt: '2026-11-05T12:00:00.000Z', scope: 'chat' },
    { id: 'c-antiga', turns: turns('Quem fala na reunião?', 'Marina e Rafael.'), updatedAt: '2026-11-03T12:00:00.000Z' },
    { id: 't-duvida', turns: turns('O que é caminho crítico?'), updatedAt: '2026-11-06T12:00:00.000Z', scope: 'tutor' },
  ])
  return base
}

describe('Chat: lista das conversas da entrada', () => {
  it('guarda a conversa nova marcada como do Chat, com o nome da primeira pergunta', async () => {
    const { entry, memory } = await chatEntry({ kept })
    render(<TutorDialog fileId={entry} chat />)
    await ask('Quem pediu mais prazo?')
    await waitFor(() => expect(savedConversations(memory, entry)[0]?.turns).toHaveLength(2))
    expect(savedConversations(memory, entry)[0]).toMatchObject({ name: 'Quem pediu mais prazo?', scope: 'chat' })
  })

  it('abre na última do Chat, e a lista mostra só as do Chat: nome, data e mensagens, a mais nova primeiro', async () => {
    const { entry } = await withHistory()
    render(<TutorDialog fileId={entry} chat />)
    await waitFor(() => expect(talk()).toEqual(['Você', 'Chat']))
    showList()
    expect(rows()).toEqual(['Qual o prazo do portal?', 'Quem fala na reunião?'])
    const first = within(screen.getByRole('list', { name: 'Conversas do chat' })).getAllByRole('listitem')[0]
    expect(first).toHaveTextContent('05/11')
    expect(first).toHaveTextContent('2 mensagens')
    expect(screen.getByRole('button', { name: 'Qual o prazo do portal?' })).toHaveAttribute('aria-current', 'true')
  })

  it('o botão "Conversas" diz quantas há', async () => {
    const { entry } = await withHistory()
    render(<TutorDialog fileId={entry} chat />)
    expect(await screen.findByRole('button', { name: /^Conversas.*2/ })).toBeInTheDocument()
  })

  it('escolher outra da lista abre ela, e a pergunta seguinte continua nela', async () => {
    const { entry, memory } = await withHistory()
    render(<TutorDialog fileId={entry} chat />)
    await waitFor(() => expect(talk()).toEqual(['Você', 'Chat']))
    showList()
    fireEvent.click(screen.getByRole('button', { name: 'Quem fala na reunião?' }))
    expect(screen.queryByRole('list', { name: 'Conversas do chat' })).not.toBeInTheDocument()
    expect(within(screen.getByRole('list', { name: 'Conversa do chat' })).getByTestId('reply')).toHaveTextContent('Marina e Rafael.')
    await ask('E o Rafael?')
    await waitFor(() => expect(savedConversations(memory, entry).find(item => item.id === 'c-antiga')?.turns).toHaveLength(4))
    expect(inputs.at(-1)).toContain('Pessoa: Quem fala na reunião?\nChat: Marina e Rafael.\nPessoa: E o Rafael?')
    expect(savedConversations(memory, entry).find(item => item.id === 'c-prazo')?.turns).toHaveLength(2)
    expect(savedConversations(memory, entry).find(item => item.id === 't-duvida')?.turns).toHaveLength(2)
  })

  it('"Nova conversa" começa outra e a velha continua na lista', async () => {
    const { entry, memory } = await withHistory()
    render(<TutorDialog fileId={entry} chat />)
    await waitFor(() => expect(talk()).toEqual(['Você', 'Chat']))
    fireEvent.click(screen.getByRole('button', { name: 'Nova conversa' }))
    expect(talk()).toEqual([])
    await ask('Qual a próxima reunião?')
    await waitFor(() => expect(savedConversations(memory, entry)).toHaveLength(4))
    await waitFor(() => expect(savedConversations(memory, entry).find(item => item.name === 'Qual a próxima reunião?')?.turns).toHaveLength(2))
    expect(inputs.at(-1)).not.toContain('Qual o prazo do portal?')
    showList()
    expect(rows()).toEqual(['Qual a próxima reunião?', 'Qual o prazo do portal?', 'Quem fala na reunião?'])
  })

  it('renomear: o nome novo fica na entrada e não volta ao antigo quando a conversa continua', async () => {
    const { entry, memory } = await withHistory()
    render(<TutorDialog fileId={entry} chat />)
    await waitFor(() => expect(talk()).toEqual(['Você', 'Chat']))
    showList()
    fireEvent.click(screen.getByRole('button', { name: 'Renomear “Qual o prazo do portal?”' }))
    const field = screen.getByRole('textbox', { name: 'Novo nome' })
    expect(field).toHaveValue('Qual o prazo do portal?')
    fireEvent.change(field, { target: { value: 'Prazo do portal' } })
    fireEvent.keyDown(field, { key: 'Enter' })
    await waitFor(() => expect(savedConversations(memory, entry).find(item => item.id === 'c-prazo')?.name).toBe('Prazo do portal'))
    await waitFor(() => expect(rows()).toEqual(['Prazo do portal', 'Quem fala na reunião?']))
    // it is the open one: asking again must not bring the old name back
    showList()
    await ask('E depois de março?')
    await waitFor(() => expect(savedConversations(memory, entry).find(item => item.id === 'c-prazo')?.turns).toHaveLength(4))
    expect(savedConversations(memory, entry).find(item => item.id === 'c-prazo')?.name).toBe('Prazo do portal')
  })

  it('renomear e apertar Esc deixa o nome como estava; nome vazio também', async () => {
    const { entry, memory } = await withHistory()
    render(<TutorDialog fileId={entry} chat />)
    await waitFor(() => expect(talk()).toEqual(['Você', 'Chat']))
    showList()
    fireEvent.click(screen.getByRole('button', { name: 'Renomear “Quem fala na reunião?”' }))
    fireEvent.change(screen.getByRole('textbox', { name: 'Novo nome' }), { target: { value: 'Outro nome' } })
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Novo nome' }), { key: 'Escape' })
    expect(screen.queryByRole('textbox', { name: 'Novo nome' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Renomear “Quem fala na reunião?”' }))
    fireEvent.change(screen.getByRole('textbox', { name: 'Novo nome' }), { target: { value: '   ' } })
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Novo nome' }), { key: 'Enter' })
    expect(rows()).toEqual(['Qual o prazo do portal?', 'Quem fala na reunião?'])
    expect(savedConversations(memory, entry).map(item => item.name)).toContain('Quem fala na reunião?')
  })

  it('apagar pede confirmação: "Cancelar" mantém a conversa', async () => {
    const { entry, memory } = await withHistory()
    render(<TutorDialog fileId={entry} chat />)
    await waitFor(() => expect(talk()).toEqual(['Você', 'Chat']))
    showList()
    fireEvent.click(screen.getByRole('button', { name: 'Apagar “Quem fala na reunião?”' }))
    expect(screen.getByText(/A conversa sai desta entrada e não volta/)).toBeInTheDocument()
    expect(savedConversations(memory, entry)).toHaveLength(3)
    fireEvent.click(screen.getByRole('button', { name: 'Cancelar' }))
    expect(screen.queryByText(/A conversa sai desta entrada/)).not.toBeInTheDocument()
    expect(rows()).toEqual(['Qual o prazo do portal?', 'Quem fala na reunião?'])
    expect(savedConversations(memory, entry)).toHaveLength(3)
  })

  it('apagar confirmado tira só aquela da entrada; as do Tutor e as outras ficam', async () => {
    const { entry, memory } = await withHistory()
    render(<TutorDialog fileId={entry} chat />)
    await waitFor(() => expect(talk()).toEqual(['Você', 'Chat']))
    showList()
    fireEvent.click(screen.getByRole('button', { name: 'Apagar “Quem fala na reunião?”' }))
    fireEvent.click(screen.getByRole('button', { name: 'Apagar' }))
    await waitFor(() => expect(savedConversations(memory, entry).map(item => item.id)).toEqual(['c-prazo', 't-duvida']))
    await waitFor(() => expect(rows()).toEqual(['Qual o prazo do portal?']))
    // the conversation open is still the one that was open
    expect(screen.getByRole('button', { name: 'Qual o prazo do portal?' })).toHaveAttribute('aria-current', 'true')
  })

  it('apagar a que está aberta limpa a conversa; a próxima pergunta começa outra', async () => {
    const { entry, memory } = await withHistory()
    render(<TutorDialog fileId={entry} chat />)
    await waitFor(() => expect(talk()).toEqual(['Você', 'Chat']))
    showList()
    fireEvent.click(screen.getByRole('button', { name: 'Apagar “Qual o prazo do portal?”' }))
    fireEvent.click(screen.getByRole('button', { name: 'Apagar' }))
    await waitFor(() => expect(savedConversations(memory, entry).map(item => item.id)).toEqual(['c-antiga', 't-duvida']))
    showList()
    await waitFor(() => expect(talk()).toEqual([]))
    await ask('Pergunta nova')
    await waitFor(() => expect(savedConversations(memory, entry)).toHaveLength(3))
    expect(inputs.at(-1)).not.toContain('Qual o prazo do portal?')
    expect(savedConversations(memory, entry).map(item => item.id)).not.toContain('c-prazo')
  })

  it('sem nenhuma conversa a lista explica como começar', async () => {
    const { entry } = await chatEntry({ kept })
    render(<TutorDialog fileId={entry} chat />)
    showList()
    expect(screen.getByText(/Nenhuma conversa ainda/)).toBeInTheDocument()
  })

  it('o botão "Conversas" volta para a conversa aberta', async () => {
    const { entry } = await withHistory()
    render(<TutorDialog fileId={entry} chat />)
    await waitFor(() => expect(talk()).toEqual(['Você', 'Chat']))
    showList()
    expect(screen.getByRole('button', { name: /^Conversas/ })).toHaveAttribute('aria-expanded', 'true')
    showList()
    expect(screen.getByRole('list', { name: 'Conversa do chat' })).toBeInTheDocument()
    expect(screen.queryByRole('list', { name: 'Conversas do chat' })).not.toBeInTheDocument()
  })
})

describe('Chat e Tutor não misturam as conversas', () => {
  it('o Tutor da mesma entrada não retoma a conversa do Chat', async () => {
    const { entry } = await withHistory()
    render(<TutorDialog fileId={entry} />)
    // the Tutor's own one on this entrada is the one with its mark
    await waitFor(() => expect(within(screen.getByRole('list', { name: 'Conversa com o tutor' })).queryAllByRole('listitem')).toHaveLength(2))
    expect(screen.getByText('O que é caminho crítico?')).toBeInTheDocument()
    expect(screen.queryByText('Qual o prazo do portal?')).not.toBeInTheDocument()
  })

  it('o Tutor não mostra a lista de conversas do Chat', async () => {
    const { entry } = await withHistory()
    render(<TutorDialog fileId={entry} />)
    await waitFor(() => expect(screen.getByText('O que é caminho crítico?')).toBeInTheDocument())
    expect(screen.queryByRole('button', { name: /^Conversas/ })).not.toBeInTheDocument()
  })

  it('uma conversa do Tutor guarda a marca do Tutor', async () => {
    const { entry, memory } = await chatEntry({ kept, media: 'none' })
    render(<TutorDialog fileId={entry} />)
    await ask('Qual o prazo?')
    await waitFor(() => expect(savedConversations(memory, entry)[0]?.turns).toHaveLength(2))
    expect(savedConversations(memory, entry)[0]).toMatchObject({ scope: 'tutor' })
  })
})

describe('"Desta nota" lista só as conversas do Tutor', () => {
  it('a conversa do Chat não aparece em "Conversas do Tutor"', async () => {
    const memory = studyLibrary()
    const id = await studyNote()
    const library = useLibraryStore.getState()
    await library.saveArtifact(id, { ...newTutorArtifact({ turns: turns('Pergunta do tutor') }), scope: 'tutor' })
    await library.saveArtifact(id, { ...newTutorArtifact({ turns: turns('Pergunta do chat') }), scope: 'chat' })
    await library.saveArtifact(id, newTutorArtifact({ turns: turns('Pergunta antiga') }))
    render(<InspectorBody fileId={id} tab="mine" />)
    const section = screen.getByRole('region', { name: 'Conversas do Tutor' })
    expect(
      within(section)
        .getAllByRole('listitem')
        .map(item => item.querySelector('b')?.textContent)
        .sort(),
    ).toEqual(['Pergunta antiga', 'Pergunta do tutor'])
    expect(savedConversations(memory, id)).toHaveLength(3)
  })
})
