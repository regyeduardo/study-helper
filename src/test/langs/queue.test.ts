// T029/T030/T034 (spec 004, US3, FR-011, FR-012, FR-024, FR-032): a fila do estudo como no protótipo validado (prototipo/web/app.js):
// primeiro as frases; depois o teste de cada item do texto (o provado sem revisão vencida é pulado; o vencido vem como revisão);
// errou → testa o que o item exige e ainda não foi provado, ensina (card de aprender) e testa de novo de outro jeito, até 3 vezes;
// depois a prática inteira (o errado volta uma vez no fim) e o contexto.
import { describe, expect, it } from 'vitest'

import type { Card, LanguageText } from '@/controllers/langs.controller'
import { answer, begin, currentOf, fitsStudy, langOf, prune, startStudy, summaryOf, taught } from '@/lib/langs/study'

const mc = (id: string, extra: Partial<Card> = {}): Card => ({ id, type: 'mc', skill: 'read', q: `Pergunta ${id}`, opts: ['a', 'b', 'c', 'd', 'e'], a: 0, ...extra })

function text(): LanguageText {
  return {
    id: 't1',
    language: 'en',
    locale: 'en-US',
    title: 'Chuva',
    status: 'ready',
    lines: ["I'm gonna walk", 'in the rain'],
    equivalences: [],
    items: {
      gonna: { area: 'lexico', kind: 'spoken_form', label: 'gonna', meaning: 'vou', needs: ['going_to'], test: [mc('gonna_1'), mc('gonna_2'), mc('gonna_3')] },
      going_to: { area: 'gramatica', kind: 'structure', label: 'going to', meaning: 'futuro com intenção', needs: ['be'], test: [mc('going_to_1'), mc('going_to_2')] },
      be: { area: 'gramatica', kind: 'word', label: 'am/is/are', meaning: 'ser, estar', test: [mc('be_1')] },
      rain: { area: 'lexico', kind: 'word', label: 'rain', meaning: 'chuva', test: [mc('rain_1', { qEn: 'What is rain?', optsEn: ['A', 'B', 'C', 'D', 'E'], needs: ['be'] })] },
    },
    practice: [mc('p1'), { id: 'p2', type: 'dictation', skill: 'listen', q: 'Ouça e escreva:', say: 'in the rain' }, { id: 'p3', type: 'speak', skill: 'speak', q: 'Fale', mode: 'repeat', target: 'rain' }],
    context: [mc('c1', { dp: 'literal' })],
    facets: [],
  }
}

const ids = (state: ReturnType<typeof startStudy>) => state.pq.map(entry => `${entry.t}:${entry.id}${entry.n ? `#${entry.n}` : ''}`)

describe('a fila do estudo', () => {
  it('começa pelas frases; depois testa cada item do texto, pula o provado e põe o vencido como revisão', () => {
    const state = startStudy(text(), { be: { recognize: 'learning', due: false }, rain: { recognize: 'fixed', due: true } })
    expect(currentOf(state, text()).kind).toBe('lines')
    expect(ids(state)).toEqual(['test:gonna', 'test:going_to', 'test:rain'])
    expect(state.pq.find(entry => entry.id === 'rain')?.review).toBe(true)
    const started = begin(state)
    expect(started.step).toBe('test')
    const now = currentOf(started, text())
    expect(now).toMatchObject({ kind: 'card', stage: 'test', position: 1, total: 3 })
  })

  it('errou: testa o que o item exige e não foi provado, ensina e testa de novo de outro jeito', () => {
    let state = begin(startStudy(text(), {}))
    // errou "gonna"
    state = answer(state, text(), {}, false, 'native')
    expect(ids(state)).toEqual(['test:gonna', 'test:going_to', 'teach:gonna', 'test:gonna#1', 'test:be', 'test:rain'])
    // errou "going to": desce até "am/is/are"
    state = answer(state, text(), {}, false, 'native')
    expect(ids(state).slice(2, 6)).toEqual(['test:be', 'teach:going_to', 'test:going_to#1', 'teach:gonna'])
    const teach = currentOf(answer(state, text(), {}, true, 'native'), text())
    expect(teach).toMatchObject({ kind: 'teach', id: 'going_to' })
    // o teste de novo usa outro card do item
    const again = currentOf(taught(answer(state, text(), {}, true, 'native')), text())
    expect(again).toMatchObject({ kind: 'card', stage: 'test' })
    expect(again.kind === 'card' && again.card.id).toBe('going_to_2')
  })

  it('no máximo 3 tentativas por item; depois segue', () => {
    const t = { ...text(), items: { gonna: { ...text().items.gonna, needs: [] } } }
    let state = begin(startStudy(t, {}))
    state = answer(state, t, {}, false, 'native') // 1ª
    state = taught(state)
    state = answer(state, t, {}, false, 'native') // 2ª
    state = taught(state)
    state = answer(state, t, {}, false, 'native') // 3ª: não volta mais
    expect(state.step).toBe('practice')
    expect(state.pq.filter(entry => entry.t === 'test' && entry.id === 'gonna')).toHaveLength(3)
  })

  it('a prática traz os cards que este estudo mostra (falar fica para a entrega do falar); o errado volta uma vez no fim', () => {
    let state = begin(startStudy({ ...text(), items: {} }, {}))
    expect(state.step).toBe('practice')
    expect(state.queue.map(entry => entry.id)).toEqual(['p1', 'p2'])
    state = answer(state, text(), {}, false, 'native')
    state = answer(state, text(), {}, true, 'native')
    expect(state.queue.map(entry => `${entry.id}${entry.retry ? ' (de novo)' : ''}`)).toEqual(['p1', 'p2', 'p1 (de novo)'])
    state = answer(state, text(), {}, false, 'native')
    expect(state.step).toBe('context')
    expect(currentOf(state, text())).toMatchObject({ kind: 'card', stage: 'context', card: { id: 'c1' } })
    state = answer(state, text(), {}, true, 'native')
    expect(state.step).toBe('done')
    expect(summaryOf(state, text())).toMatchObject({ practice: { right: 1, total: 2 }, context: { right: 1, total: 1 } })
  })

  it('o enunciado vem em inglês quando tudo o que ele usa foi provado; volta ao português depois de 2 erros, até 2 acertos', () => {
    const t = text()
    const card = t.items.rain.test[0]
    let state = begin(startStudy(t, {}))
    expect(langOf(card, state, {})).toBe('native')
    expect(langOf(card, state, { be: { recognize: 'fixed', due: false } })).toBe('target')
    state = { ...state, proven: { be: true } }
    expect(langOf(card, state, {})).toBe('target')
    // answers the card shown now (a learn card on the way is passed with "Testar")
    const reply = (s: typeof state, ok: boolean, lang: 'native' | 'target') => answer(currentOf(s, t).kind === 'teach' ? taught(s) : s, t, {}, ok, lang)
    state = reply(state, false, 'target')
    state = reply(state, false, 'target')
    expect(langOf(card, state, {})).toBe('native')
    state = reply(state, true, 'native')
    state = reply(state, true, 'native')
    expect(langOf(card, state, {})).toBe('target')
  })

  it('o conteúdo do texto mudou: tira o que não existe mais sem perder a posição', () => {
    let state = begin(startStudy(text(), {}))
    state = answer(state, text(), {}, true, 'native') // gonna certo
    const changed = { ...text(), items: { ...text().items } }
    delete (changed.items as Record<string, unknown>).gonna
    const kept = prune(state, changed)
    expect(ids(kept)).toEqual(['test:going_to', 'test:be', 'test:rain'].filter(id => ids(state).includes(id)))
    expect(currentOf(kept, changed)).toMatchObject({ kind: 'card', stage: 'test', card: { id: 'going_to_1' } })
  })

  it('o que o item exige e veio de outro texto também é testado e ensinado, sem virar item deste texto', () => {
    const t = text()
    const be = t.items.be
    const own = { ...t, items: { gonna: { ...t.items.gonna, needs: ['be'] } }, needed: { be } }
    let state = begin(startStudy(own, {}))
    expect(ids(state)).toEqual(['test:gonna'])
    state = answer(state, own, {}, false, 'native')
    expect(ids(state)).toEqual(['test:gonna', 'test:be', 'teach:gonna', 'test:gonna#1'])
    expect(currentOf(state, own)).toMatchObject({ kind: 'card', stage: 'test', card: { id: 'be_1' } })
  })

  it('o progresso guardado de antes (só ouvir) não serve: começa de novo', () => {
    expect(fitsStudy({ step: 'cards', at: 3, order: [], slots: {} })).toBe(false)
    expect(fitsStudy(startStudy(text(), {}))).toBe(true)
  })
})

// T118 (spec 004, FR-039; dono, 24/11: "é por card… cards podem ser aproveitados"): o card aproveitado de outro texto que já está
// em revisão e não venceu não volta na prática (volta quando vencer); o vencido, o novo e o que está nos passos curtos voltam.
describe('cards aproveitados na prática', () => {
  const now = new Date('2026-11-24T12:00:00Z')
  const review = (dueAt: string) => ({ state: 'review' as const, step: 0, stability: 3, difficulty: 5, dueAt, lastReviewAt: '2026-11-21T12:00:00.000Z', scheduledDays: 3, reps: 2, lapses: 0 })

  it('pula o que está em revisão e não venceu; mantém o vencido e o que ainda aprende', () => {
    const t = { ...text(), practice: [mc('p1'), mc('p2'), mc('p3'), mc('p4')] }
    t.schedules = {
      p1: review('2026-11-27T12:00:00.000Z'),
      p2: review('2026-11-24T11:00:00.000Z'),
      p3: { ...review('2026-11-24T12:05:00.000Z'), state: 'relearning', lapses: 1 },
    }
    expect(startStudy(t, {}, now).queue.map(entry => entry.id)).toEqual(['p2', 'p3', 'p4'])
  })
})
