import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'

import type { TutorArtifact } from '@/types/domain'
import { TutorDialog } from '@/components/dialogs/TutorDialog'
import { newTutorArtifact } from '@/lib/artifacts'
import { CHUNK_CHARS } from '@/lib/generation/minutes'
import { lastConversation, modeOf, tutorInput, withTurns } from '@/lib/generation/tutor'
import { useLibraryStore } from '@/stores/library'
import { type CapturedRequest, installFetch, openAiStream, userContentOf } from '@/test/ai/fake-provider'
import { studyLibrary, studyNote } from '@/test/generation/study-fixture'

describe('tutor helpers', () => {
  it('lastConversation is the one used last', () => {
    const old = { ...newTutorArtifact({ turns: [{ who: 'você', text: 'Primeira' }] }), updatedAt: '2026-11-01T00:00:00.000Z' }
    const recent = { ...newTutorArtifact({ turns: [{ who: 'você', text: 'Segunda' }] }), updatedAt: '2026-11-05T00:00:00.000Z' }
    expect(lastConversation([recent, old])?.name).toBe('Segunda')
    expect(lastConversation([])).toBeNull()
  })

  it('withTurns starts a conversation named by the first question, then only appends', () => {
    const started = withTurns(null, [{ who: 'você', text: 'O que é limite?' }])
    expect(started).toMatchObject({ kind: 'tutor', name: 'O que é limite?', turns: [{ who: 'você', text: 'O que é limite?' }] })
    const next = withTurns(started, [...started.turns, { who: 'tutor', text: 'É o valor de que…' }])
    expect(next).toMatchObject({ id: started.id, name: 'O que é limite?' })
    expect(next.turns).toHaveLength(2)
  })

  it('a conversation the tutor started is a test', () => {
    expect(modeOf(withTurns(null, [{ who: 'tutor', text: 'Quando o limite não existe?' }]))).toBe('testar')
    expect(modeOf(withTurns(null, [{ who: 'você', text: 'Oi?' }]))).toBe('perguntar')
  })

  it('a long note gives the tutor the parts about the question, not only its beginning', () => {
    const filler = Array.from({ length: 12 }, (_, index) => `Parágrafo ${index} ${'sobre outra coisa '.repeat(CHUNK_CHARS / 90)}`)
    const note = [...filler, 'A derivada de seno é cosseno.'].join('\n\n')
    expect(tutorInput(note, 'perguntar', [{ who: 'você', text: 'Qual a derivada de seno?' }])).toContain('A derivada de seno é cosseno.')
  })
})

const inputs: string[] = []

beforeEach(() => {
  inputs.length = 0
  installFetch((request: CapturedRequest) => {
    const text = userContentOf(request)
    inputs.push(text)
    if (text.includes('Modo: testar') && !text.includes('Pessoa:')) return openAiStream('Quando o limite não existe?')
    return openAiStream(`Resposta ${inputs.length}.`)
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

const talk = () =>
  within(screen.getByRole('list', { name: 'Conversa com o tutor' }))
    .queryAllByRole('listitem')
    .map(item => item.querySelector('b')?.textContent)

const conversations = (memory: ReturnType<typeof studyLibrary>, id: string) => (memory.sidecars.get(id)?.artifacts ?? []).filter((item): item is TutorArtifact => item.kind === 'tutor')

async function ask(question: string) {
  fireEvent.change(screen.getByRole('textbox', { name: 'Sua pergunta ou resposta' }), { target: { value: question } })
  fireEvent.click(screen.getByRole('button', { name: 'Enviar' }))
}

describe('Tutor conversations are kept in the note', () => {
  it('saves each turn as it happens, named by the first question', async () => {
    const memory = studyLibrary()
    const id = await studyNote()
    render(<TutorDialog fileId={id} />)
    await ask('Quando o limite não existe?')
    await waitFor(() => expect(conversations(memory, id)[0]?.turns).toHaveLength(2))
    expect(conversations(memory, id)[0]).toMatchObject({ name: 'Quando o limite não existe?', turns: [{ who: 'você', text: 'Quando o limite não existe?' }, { who: 'tutor', text: 'Resposta 1.' }] })
    expect(useLibraryStore.getState().files.find(file => file.id === id)?.artifacts?.map(item => [item.kind, item.name])).toEqual([['tutor', 'Quando o limite não existe?']])
  })

  it('opening the Tutor again continues the last conversation', async () => {
    const memory = studyLibrary()
    const id = await studyNote()
    const { unmount } = render(<TutorDialog fileId={id} />)
    await ask('Quando o limite não existe?')
    await waitFor(() => expect(conversations(memory, id)[0]?.turns).toHaveLength(2))
    unmount()
    render(<TutorDialog fileId={id} />)
    await waitFor(() => expect(talk()).toEqual(['Você', 'Tutor']))
    await ask('E a continuidade?')
    await waitFor(() => expect(conversations(memory, id)[0]?.turns).toHaveLength(4))
    expect(conversations(memory, id)).toHaveLength(1)
    expect(inputs.at(-1)).toContain('Pessoa: Quando o limite não existe?\nTutor: Resposta 1.\nPessoa: E a continuidade?')
  })

  it('"Nova conversa" starts another and keeps the old one in the note', async () => {
    const memory = studyLibrary()
    const id = await studyNote()
    render(<TutorDialog fileId={id} />)
    await ask('Quando o limite não existe?')
    await waitFor(() => expect(conversations(memory, id)[0]?.turns).toHaveLength(2))
    fireEvent.click(screen.getByRole('button', { name: 'Nova conversa' }))
    expect(talk()).toEqual([])
    await ask('O que é continuidade?')
    await waitFor(() => expect(conversations(memory, id)).toHaveLength(2))
    await waitFor(() => expect(conversations(memory, id)[1].turns).toHaveLength(2))
    expect(conversations(memory, id).map(item => item.name)).toEqual(['Quando o limite não existe?', 'O que é continuidade?'])
    expect(conversations(memory, id)[0].turns).toHaveLength(2)
    expect(inputs.at(-1)).not.toContain('Quando o limite não existe?')
  })

  it('"Nova conversa" waits until there is a conversation to leave', async () => {
    studyLibrary()
    const id = await studyNote()
    render(<TutorDialog fileId={id} />)
    expect(screen.getByRole('button', { name: 'Nova conversa' })).toBeDisabled()
    await ask('Quando o limite não existe?')
    await waitFor(() => expect(screen.getByRole('button', { name: 'Nova conversa' })).toBeEnabled())
  })

  it('a test conversation opens again in test mode', async () => {
    const memory = studyLibrary()
    const id = await studyNote()
    const { unmount } = render(<TutorDialog fileId={id} />)
    fireEvent.click(screen.getByRole('button', { name: 'Testar o que sei' }))
    await waitFor(() => expect(conversations(memory, id)[0]?.turns).toHaveLength(1))
    expect(conversations(memory, id)[0].name).toBe('Quando o limite não existe?')
    unmount()
    render(<TutorDialog fileId={id} />)
    await waitFor(() => expect(screen.getByRole('button', { name: 'Testar o que sei' })).toHaveAttribute('aria-pressed', 'true'))
    expect(talk()).toEqual(['Tutor'])
  })
})
