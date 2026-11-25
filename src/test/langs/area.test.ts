// T134 (spec 004, FR-044; dono, 25/11: "Eu clicaria num cara desses que seria o estudo geral de todos os textos (tudo que foi
// gerado)"): o estudo de uma área junta o que foi gerado em todos os textos do idioma: os itens da área (com os cards de teste de
// todos os textos), o que eles exigem de outras áreas, a prática cujo primeiro item é da área, a repetição e as equivalências. Sem
// Contexto, que depende de um texto à vista. Cada card lembra de que texto veio, para a resposta e o "Reportar".
import { describe, expect, it } from 'vitest'

import type { Card, LanguageText } from '@/controllers/langs.controller'
import { areaText } from '@/lib/langs/area'
import type { Schedule } from '@/lib/langs/fsrs'

const mc = (id: string, covers?: string[]): Card => ({ id, type: 'mc', skill: 'read', q: `Pergunta ${id}`, opts: ['a', 'b', 'c', 'd', 'e'], a: 0, ...(covers ? { covers } : {}) })
const learning: Schedule = { state: 'learning', step: 1, stability: 1, difficulty: 5, dueAt: '2026-11-25T12:10:00.000Z', lastReviewAt: '2026-11-25T12:00:00.000Z', scheduledDays: 0, reps: 1, lapses: 0 }

const base = { language: 'en', locale: 'en-US', status: 'ready' as const, lines: ['a line'] }

const t1: LanguageText = {
  ...base,
  id: 't1',
  title: 'Chuva',
  equivalences: [["won't", 'will not']],
  items: {
    walk: { area: 'lexico', kind: 'word', label: 'walk', meaning: 'andar', needs: ['be'], test: [mc('walk_1'), mc('walk_2')] },
    be: { area: 'gramatica', kind: 'word', label: 'am/is/are', meaning: 'ser, estar', test: [mc('be_1')] },
  },
  needed: { go: { area: 'lexico', kind: 'word', label: 'go', meaning: 'ir', test: [mc('go_1')] } },
  practice: [mc('p_walk', ['walk', 'be']), mc('p_be', ['be', 'walk']), mc('p_free')],
  context: [mc('c1')],
  facets: [{ id: 'pron', area: 'fonologia', name: 'Pronúncia' }],
  schedules: { walk_1: learning },
}

const t2: LanguageText = {
  ...base,
  id: 't2',
  title: 'Estrada',
  equivalences: [["won't", 'will not'], ["I'm", 'I am']],
  items: {
    // the same item in another text: its cards join (walk_2 was reused, with its repetition)
    walk: { area: 'lexico', kind: 'word', label: 'walk', meaning: 'andar', needs: ['be'], test: [mc('walk_2'), mc('walk_3')] },
    rain: { area: 'lexico', kind: 'word', label: 'rain', meaning: 'chuva', test: [mc('rain_1')] },
    will: { area: 'gramatica', kind: 'word', label: 'will', meaning: 'futuro', test: [mc('will_1')] },
  },
  practice: [mc('p_walk', ['walk', 'be']), mc('p_rain', ['rain'])],
  context: [mc('c2')],
  facets: [{ id: 'pron', area: 'fonologia', name: 'Pronúncia' }, { id: 'reg', area: 'registro', name: 'Registro' }],
  schedules: { rain_1: learning },
}

describe('estudo de uma área, com todos os textos', () => {
  it('os itens da área de todos os textos, cada um com os cards de teste de todos eles, sem repetir', () => {
    const { text } = areaText([t1, t2], 'lexico', 'Léxico')
    expect(Object.keys(text.items).sort()).toEqual(['go', 'rain', 'walk'])
    expect(text.items.walk.test.map(card => card.id)).toEqual(['walk_1', 'walk_2', 'walk_3'])
    expect(text).toMatchObject({ id: 'area:lexico', title: 'Léxico', language: 'en', locale: 'en-US', status: 'ready' })
  })

  it('o que os itens exigem e é de outra área vem à parte: testado e ensinado depois de um erro, sem virar item da área', () => {
    const { text } = areaText([t1, t2], 'lexico', 'Léxico')
    expect(text.needed?.be?.test.map(card => card.id)).toEqual(['be_1'])
    expect(text.items.be).toBeUndefined()
  })

  it('a prática traz os cards cujo primeiro item é da área, de todos os textos, sem repetir o card aproveitado', () => {
    expect(areaText([t1, t2], 'lexico', 'Léxico').text.practice.map(card => card.id)).toEqual(['p_walk', 'p_rain'])
    expect(areaText([t1, t2], 'gramatica', 'Gramática').text.practice.map(card => card.id)).toEqual(['p_be'])
  })

  it('sem Contexto; junta a repetição, as equivalências e os aspectos', () => {
    const { text } = areaText([t1, t2], 'lexico', 'Léxico')
    expect(text.context).toEqual([])
    expect(text.lines).toEqual([])
    expect(text.schedules).toEqual({ walk_1: learning, rain_1: learning })
    expect(text.equivalences).toEqual([["won't", 'will not'], ["I'm", 'I am']])
    expect(text.facets.map(facet => facet.id)).toEqual(['pron', 'reg'])
  })

  it('guarda de que texto veio cada card (a resposta e o "Reportar" vão para ele)', () => {
    const { origin } = areaText([t1, t2], 'lexico', 'Léxico')
    expect(origin).toMatchObject({ walk_1: 't1', walk_2: 't1', walk_3: 't2', go_1: 't1', rain_1: 't2', be_1: 't1', p_walk: 't1', p_rain: 't2' })
  })

  it('sem texto pronto, nada para estudar', () => {
    const { text } = areaText([], 'lexico', 'Léxico')
    expect(text).toMatchObject({ items: {}, practice: [], context: [] })
  })
})
