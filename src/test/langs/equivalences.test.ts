// T101 (spec 004, FR-018, SC-003): num conjunto de 50 formas equivalentes e flexionadas, 100% contam igual no ditado e no montar.
// O mesmo conjunto roda no servidor (api/internal/langs/grade_test.go).
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

import type { Card } from '@/controllers/langs.controller'
import { grade, newSlot } from '@/lib/langs/listen'

const data = JSON.parse(readFileSync(resolve(process.cwd(), 'api/internal/langs/testdata/equivalences-50.json'), 'utf8')) as {
  groups: string[][]
  same: [string, string][]
  different: [string, string][]
}

const dictation = (say: string, typed: string) => {
  const card: Card = { id: 'd', type: 'dictation', skill: 'listen', q: 'Ouça e escreva:', say }
  return grade(card, typed, newSlot(card), data.groups).ok
}

/** Montar: as peças são as palavras de uma forma, tocadas na ordem; a resposta guardada é a outra. */
const order = (pieces: string, answer: string) => {
  const tokens = pieces.split(' ')
  const card: Card = { id: 'o', type: 'order', skill: 'read', q: 'Monte:', tokens, answer }
  return grade(card, tokens.map((_, i) => i), newSlot(card), data.groups).ok
}

describe('SC-003: 50 formas equivalentes e flexionadas', () => {
  it('o conjunto tem 50 casos', () => {
    expect(data.same).toHaveLength(50)
  })

  it('100% contam igual no ditado, nos dois sentidos', () => {
    const failed = data.same.filter(([a, b]) => !dictation(a, b) || !dictation(b, a))
    expect(failed).toEqual([])
  })

  it('100% contam igual no montar, nos dois sentidos', () => {
    const failed = data.same.filter(([a, b]) => !order(a, b) || !order(b, a))
    expect(failed).toEqual([])
  })

  it('o que diz outra coisa não conta igual', () => {
    const passed = data.different.filter(([a, b]) => dictation(a, b) || order(a, b))
    expect(passed).toEqual([])
  })
})
