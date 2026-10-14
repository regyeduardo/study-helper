import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'

import { CardsDialog } from '@/components/dialogs/CardsDialog'
import { dueCount, reviewed } from '@/lib/generation/cards'
import { PROMPTS } from '@/lib/generation/prompts.data'
import { useLibraryStore } from '@/stores/library'
import { type CapturedRequest, installFetch, openAiStream, systemPromptOf } from '@/test/ai/fake-provider'
import { studyLibrary, studyNote } from '@/test/generation/study-fixture'

const asked: string[] = []

beforeEach(() => {
  asked.length = 0
  installFetch((request: CapturedRequest) => {
    asked.push(systemPromptOf(request))
    return openAiStream(JSON.stringify({ cartoes: [{ frente: 'Quando o limite não existe?', verso: 'Quando os laterais diferem.' }, { frente: 'O que exige a continuidade?', verso: 'Limite igual ao valor.' }] }))
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('Cartões', () => {
  it('right moves the card to a later day, wrong keeps it for today', () => {
    const card = { id: 'c', front: 'f', back: 'b', box: 0, due: '2026-10-14' }
    expect(reviewed(card, true, '2026-10-14')).toMatchObject({ box: 1, due: '2026-10-15' })
    expect(reviewed({ ...card, box: 2 }, true, '2026-10-14')).toMatchObject({ box: 3, due: '2026-10-18' })
    expect(reviewed({ ...card, box: 3 }, false, '2026-10-14')).toMatchObject({ box: 0, due: '2026-10-14' })
    expect(dueCount(['2026-10-13', '2026-10-14', '2026-10-20'], '2026-10-14')).toBe(2)
  })

  it('makes the cards of the note, reviews them and keeps the count for today on the note', async () => {
    const memory = studyLibrary()
    const id = await studyNote()
    render(<CardsDialog fileId={id} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Fazer os cartões' }))
    expect(await screen.findByText('Quando o limite não existe?')).toBeInTheDocument()
    expect(asked[0]).toBe(PROMPTS.CARDS_PROMPT)
    expect(screen.getByRole('status')).toHaveTextContent('2 para hoje · 2 cartões')
    fireEvent.click(screen.getByRole('button', { name: 'Mostrar a resposta' }))
    expect(screen.getByText('Quando os laterais diferem.')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Acertei' }))
    expect(await screen.findByText('O que exige a continuidade?')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Mostrar a resposta' }))
    fireEvent.click(screen.getByRole('button', { name: 'Errei' }))
    expect(await screen.findByText('O que exige a continuidade?')).toBeInTheDocument()
    await waitFor(() => expect(memory.sidecars.get(id)?.cards?.map(card => card.box)).toEqual([1, 0]))
    expect(dueCount(useLibraryStore.getState().files.find(file => file.id === id)?.cardDue)).toBe(1)
  })
})
