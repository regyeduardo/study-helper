import { describe, expect, it, vi } from 'vitest'

import { Cancelled } from '@/controllers/ai.controller'
import { newCardsArtifact, newMapArtifact, newTutorArtifact } from '@/lib/artifacts'
import { NAME_PROMPT, nameArtifact, nameSource } from '@/lib/generation/artifact-name'
import { INSTRUCTION_HEAD } from '@/lib/generation/instruction'
import type { GenerationSession } from '@/lib/generation/session'

function session(answer: () => Promise<string>) {
  const chat = vi.fn(answer)
  return { session: { chat } as unknown as GenerationSession, chat }
}

describe('nameArtifact', () => {
  it('asks a short, specific name for the kind of artifact, with the instruction below', async () => {
    const { session: ai, chat } = session(async () => '{"nome": "Datas da Revolução Francesa."}')
    expect(await nameArtifact('Quando caiu a Bastilha?\nQuando foi o Terror?', 'cartoes', 'foque em datas', ai)).toBe('Datas da Revolução Francesa')
    const [input, system, tokens] = chat.mock.calls[0] as unknown as [string, string, number]
    expect(system).toBe(NAME_PROMPT)
    expect(input).toContain('Tipo: cartões de memorização')
    expect(input).toContain('Quando caiu a Bastilha?')
    expect(input).toContain(`${INSTRUCTION_HEAD}\n\nfoque em datas`)
    expect(tokens).toBeLessThanOrEqual(200)
  })

  it('gives nothing back when the AI fails, answers empty or there is nothing to name', async () => {
    expect(await nameArtifact('Limites', 'mapa', '', session(async () => { throw new Error('fora do ar') }).session)).toBeNull()
    expect(await nameArtifact('Limites', 'mapa', '', session(async () => '{"nome": ""}').session)).toBeNull()
    expect(await nameArtifact('  ', 'mapa', '', session(async () => '{"nome": "x"}').session)).toBeNull()
  })

  it('lets a cancel through', async () => {
    await expect(nameArtifact('Limites', 'mapa', '', session(async () => { throw new Cancelled() }).session)).rejects.toBeInstanceOf(Cancelled)
  })
})

describe('nameSource: what the AI reads to name an artifact', () => {
  it('a map gives its nodes as an outline', () => {
    const map = newMapArtifact({ diagram: { form: 'arvore', root: { id: 'r', text: 'Limites', children: [{ id: 'a', text: 'Laterais', mark: '📌', children: [{ id: 'b', text: 'Esquerda', children: [] }] }] } } })
    expect(nameSource(map)).toBe('Limites\n  📌 Laterais\n    Esquerda')
  })

  it('a deck gives its fronts and a conversation its turns', () => {
    const deck = newCardsArtifact({ cards: [{ id: 'c', front: 'O que é limite?', back: 'O valor de que se aproxima.', box: 0, due: '2026-11-06' }] })
    expect(nameSource(deck)).toBe('O que é limite?')
    expect(nameSource(newTutorArtifact({ turns: [{ who: 'você', text: 'Oi?' }, { who: 'tutor', text: 'Olá.' }] }))).toBe('Pessoa: Oi?\nTutor: Olá.')
  })
})
