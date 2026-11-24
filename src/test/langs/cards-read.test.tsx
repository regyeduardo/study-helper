// T032/T033 (spec 004, FR-017, FR-018, FR-035; protótipo prototipo/web/cards.js): os cards de ler — escolher, verdadeiro ou falso,
// completar, montar a frase, ligar pares e achar o intruso — e o card de aprender. Tudo corrigido pelo app, sem IA.
import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, within } from '@testing-library/react'
import { useState } from 'react'

vi.mock('@/lib/langs/voice', () => ({ say: vi.fn(async () => {}), sayAll: vi.fn(async () => {}), stop: vi.fn() }))

import type { Card, Item } from '@/controllers/langs.controller'
import { LearnCard } from '@/components/langs/cards/LearnCard'
import { ReadCard } from '@/components/langs/cards/ReadCard'
import { type Answer, choices, grade, newSlot, ready } from '@/lib/langs/listen'

const groups = [["won't", 'will not']]

describe('correção dos cards de ler', () => {
  it('escolher: 5 opções embaralhadas e guardadas; em inglês usa as opções em inglês', () => {
    const card: Card = { id: 'm', type: 'mc', skill: 'read', q: 'give up =', qEn: 'give up means', opts: ['desistir', 'entregar', 'levantar', 'devolver', 'abrir mão'], optsEn: ['quit', 'deliver', 'raise', 'return', 'yield'], a: 0 }
    const slot = newSlot(card)
    expect([...(slot.order ?? [])].sort()).toEqual([0, 1, 2, 3, 4])
    expect(choices(card, slot).map(option => option.label).sort()).toEqual([...card.opts!].sort())
    expect(choices(card, slot, 'target').map(option => option.label).sort()).toEqual([...card.optsEn!].sort())
    expect(grade(card, 0, slot, groups)).toMatchObject({ ok: true, right: 'desistir' })
    expect(grade(card, 2, slot, groups, 'target')).toMatchObject({ ok: false, given: 'raise', right: 'quit' })
  })

  it('verdadeiro ou falso, completar e intruso', () => {
    const tf: Card = { id: 'tf', type: 'tf', skill: 'read', q: "'get up' = levantar", a: true }
    expect(choices(tf, newSlot(tf)).map(option => option.label)).toEqual(['Verdadeiro', 'Falso'])
    expect(choices(tf, newSlot(tf), 'target').map(option => option.label)).toEqual(['True', 'False'])
    expect(grade(tf, 0, newSlot(tf), groups).ok).toBe(true)
    const gap: Card = { id: 'g', type: 'gap', skill: 'read', q: 'Complete:', text: 'It ___ cold.', opts: ['gets', 'takes', 'makes', 'goes', 'turns'], a: 0 }
    expect(grade(gap, 0, newSlot(gap), groups).ok).toBe(true)
    const odd: Card = { id: 'o', type: 'odd', skill: 'read', q: 'O intruso:', opts: ['cold', 'warm', 'hot', 'angry', 'chilly'], a: 3 }
    expect(grade(odd, 3, newSlot(odd), groups)).toMatchObject({ ok: true, right: 'angry' })
  })

  it('montar a frase aceita as formas equivalentes; ligar pares só passa com todos certos', () => {
    const order: Card = { id: 'r', type: 'order', skill: 'read', q: 'Monte:', tokens: ['mind', 'I', "won't"], answer: "I won't mind" }
    const slot = newSlot(order)
    expect(ready(order, [1, 2])).toBe(false)
    expect(grade(order, [1, 2, 0], slot, groups)).toMatchObject({ ok: true, given: "I won't mind" })
    expect(grade({ ...order, answer: 'I will not mind' }, [1, 2, 0], slot, groups).ok).toBe(true)
    expect(grade(order, [0, 1, 2], slot, groups).ok).toBe(false)
    const match: Card = { id: 'p', type: 'match', skill: 'read', q: 'Ligue:', pairs: [['get up', 'levantar'], ['get it', 'entender']] }
    expect(ready(match, [1, -1])).toBe(false)
    expect(grade(match, [0, 1], newSlot(match), groups).ok).toBe(true)
    expect(grade(match, [1, 0], newSlot(match), groups)).toMatchObject({ ok: false, right: 'get up → levantar; get it → entender' })
  })
})

function Harness({ card, lang = 'native' as const }: { card: Card; lang?: 'native' | 'target' }) {
  const [answer, setAnswer] = useState<Answer>(null)
  const [slot] = useState(() => newSlot(card))
  return (
    <>
      <ReadCard card={card} slot={slot} lang={lang} answer={answer} onAnswer={setAnswer} checked={false} />
      <output aria-label="resposta">{JSON.stringify(answer)}</output>
    </>
  )
}

describe('os cards de ler na tela', () => {
  it('completar mostra a frase com a lacuna; escolher marca uma opção', () => {
    render(<Harness card={{ id: 'g', type: 'gap', skill: 'read', q: 'Complete:', text: 'It ___ cold.', opts: ['gets', 'takes', 'makes', 'goes', 'turns'], a: 0 }} />)
    expect(screen.getByText(/It/)).toHaveTextContent('It ___ cold.')
    fireEvent.click(screen.getByRole('radio', { name: 'takes' }))
    expect(screen.getByRole('radio', { name: 'takes' })).toHaveAttribute('aria-checked', 'true')
  })

  it('montar: toca as peças na ordem, "Limpar" recomeça', () => {
    render(<Harness card={{ id: 'r', type: 'order', skill: 'read', q: 'Monte:', tokens: ['mind', 'I', "won't"], answer: "I won't mind" }} />)
    const pool = screen.getByRole('group', { name: 'Peças' })
    fireEvent.click(within(pool).getByRole('button', { name: 'I' }))
    fireEvent.click(within(pool).getByRole('button', { name: "won't" }))
    expect(screen.getByRole('group', { name: 'Sua frase' })).toHaveTextContent(/I\s*won't/)
    expect(within(pool).queryByRole('button', { name: 'I' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Limpar' }))
    expect(within(pool).getAllByRole('button')).toHaveLength(3)
  })

  it('ligar pares: toca um da esquerda e depois o par da direita', () => {
    render(<Harness card={{ id: 'p', type: 'match', skill: 'read', q: 'Ligue:', pairs: [['get up', 'levantar'], ['get it', 'entender']] }} />)
    fireEvent.click(screen.getByRole('button', { name: 'get up' }))
    fireEvent.click(screen.getByRole('button', { name: 'levantar' }))
    expect(screen.getByRole('button', { name: 'get up → levantar' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'levantar' })).toBeDisabled()
  })
})

describe('o card de aprender', () => {
  it('mostra o sentido, o padrão, o sentido central, o que usa, a explicação, os exemplos, a voz e "Tudo sobre"', () => {
    const item: Item = {
      area: 'semantica',
      kind: 'sense',
      label: 'get + adjetivo',
      say: 'it gets cold',
      meaning: 'ficar (mudar de estado)',
      word: 'get',
      pattern: 'get + adjetivo',
      core: 'passar a ter ou chegar a',
      expl: 'Com adjetivo, get diz que algo muda de estado.',
      ex: ['It gets cold at night = Fica frio à noite'],
      needs: ['be'],
      facets: { spoken: '/ɡet/', grammar: 'get + adjetivo' },
      test: [],
    }
    render(<LearnCard item={item} labels={{ be: 'am/is/are' }} facets={[{ id: 'spoken', area: 'fonologia', name: 'Pronúncia' }, { id: 'grammar', area: 'gramatica', name: 'Gramática' }]} locale="en-US" language="en" />)
    expect(screen.getByRole('heading', { name: 'get + adjetivo' })).toBeInTheDocument()
    expect(screen.getByText('ficar (mudar de estado)')).toBeInTheDocument()
    expect(screen.getByText(/Sentido de “get” · padrão: get \+ adjetivo/)).toBeInTheDocument()
    expect(screen.getByText(/Sentido central de “get”: passar a ter ou chegar a/)).toBeInTheDocument()
    expect(screen.getByText('Usa: am/is/are')).toBeInTheDocument()
    expect(screen.getByText('It gets cold at night = Fica frio à noite')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Ouvir/ })).toBeInTheDocument()
    fireEvent.click(screen.getByText('Tudo sobre “get + adjetivo” (2)'))
    expect(screen.getByText('/ɡet/')).toBeInTheDocument()
  })
})
