// T029/T030/T034 (spec 004, US3, FR-011, FR-012, FR-024, FR-032) e T130/T132 (25/11, FR-041 a FR-043): a fila do estudo como no
// protótipo validado (prototipo/web/app.js), sem a aba "Frases": o Vocabulário testa cada item do texto (o provado sem revisão
// vencida é pulado; o vencido vem como revisão); errou → testa o que o item exige e ainda não foi provado, ensina (card de aprender)
// e testa de novo de outro jeito, até 3 vezes; depois a Prática (o errado volta uma vez no fim) e o Contexto. A ordem é a do Anki:
// revisões vencidas, depois o que está aprendendo, depois o novo, sorteado dentro de cada grupo (dono, 25/11: "o tipo de card não
// importa na sequência. Importa o que preciso aprender/revisar primeiro"). As partes são clicáveis e cada uma guarda onde parou.
import { describe, expect, it } from 'vitest'

import type { Card, LanguageText } from '@/controllers/langs.controller'
import type { Schedule } from '@/lib/langs/fsrs'
import { answer, currentOf, fitsStudy, goTo, type Knowledge, langOf, partLeft, prune, startStudy, type StudyState, summaryOf, taught } from '@/lib/langs/study'

const mc = (id: string, extra: Partial<Card> = {}): Card => ({ id, type: 'mc', skill: 'read', q: `Pergunta ${id}`, opts: ['a', 'b', 'c', 'd', 'e'], a: 0, ...extra })
const of = (type: Card['type'], id: string): Card => (type === 'dictation' ? { id, type, skill: 'listen', q: 'Ouça e escreva:', say: 'in the rain' } : type === 'listen_mc' ? { ...mc(id), type, skill: 'listen', say: 'rain' } : { ...mc(id), type })

const NOW = new Date('2026-11-25T12:00:00Z')
/** No draw: the order the text brings and each item's first card. */
const none = () => 0
/** A repeatable draw (mulberry32). */
function seeded(seed: number) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
const SEEDS = Array.from({ length: 40 }, (_, n) => n + 1)

const schedule = (state: Schedule['state'], dueAt: string): Schedule => ({ state, step: 0, stability: 3, difficulty: 5, dueAt, lastReviewAt: '2026-11-20T12:00:00.000Z', scheduledDays: state === 'review' ? 3 : 0, reps: 2, lapses: state === 'relearning' ? 1 : 0 })
const due = schedule('review', '2026-11-25T08:00:00.000Z')
const notDue = schedule('review', '2026-11-28T08:00:00.000Z')
const learning = schedule('learning', '2026-11-25T12:10:00.000Z')
const relearning = schedule('relearning', '2026-11-25T12:10:00.000Z')

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
    context: [mc('c1', { dp: 'literal' }), mc('c2', { dp: 'inferencia' })],
    facets: [],
  }
}

const start = (t: LanguageText = text(), knowledge: Knowledge = {}) => startStudy(t, knowledge, NOW, none)
const ids = (state: StudyState) => state.pq.map(entry => `${entry.t}:${entry.id}${entry.n ? `#${entry.n}` : ''}`)
const shownCard = (state: StudyState, t: LanguageText) => {
  const now = currentOf(state, t)
  return now.kind === 'card' ? now.card.id : now.kind
}

describe('a fila do estudo', () => {
  it('começa pelo Vocabulário: testa cada item do texto, pula o provado e põe o vencido como revisão, na frente', () => {
    const state = start(text(), { be: { recognize: 'learning', due: false }, rain: { recognize: 'fixed', due: true } })
    expect(state.step).toBe('test')
    expect(ids(state)).toEqual(['test:rain', 'test:gonna', 'test:going_to'])
    expect(state.pq[0].review).toBe(true)
    expect(currentOf(state, text())).toMatchObject({ kind: 'card', stage: 'test', position: 1, total: 3, review: true, card: { id: 'rain_1' } })
  })

  it('o progresso guardado na parte "Frases" (antes de 25/11) segue no Vocabulário', () => {
    const kept = { ...start(), step: 'lines' } as unknown as StudyState
    expect(fitsStudy(kept)).toBe(true)
    expect(prune(kept, text()).step).toBe('test')
  })

  it('errou: testa o que o item exige e não foi provado, ensina e testa de novo de outro jeito', () => {
    let state = start()
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
    let state = start(t)
    state = answer(state, t, {}, false, 'native') // 1ª
    state = taught(state)
    state = answer(state, t, {}, false, 'native') // 2ª
    state = taught(state)
    state = answer(state, t, {}, false, 'native') // 3ª: não volta mais
    expect(state.step).toBe('practice')
    expect(state.pq.filter(entry => entry.t === 'test' && entry.id === 'gonna')).toHaveLength(3)
  })

  it('a prática traz os cards que este estudo mostra (falar fica para a entrega do falar); o errado volta uma vez no fim', () => {
    let state = start({ ...text(), items: {} })
    expect(state.step).toBe('practice')
    expect(state.queue.map(entry => entry.id)).toEqual(['p1', 'p2'])
    state = answer(state, text(), {}, false, 'native')
    state = answer(state, text(), {}, true, 'native')
    expect(state.queue.map(entry => `${entry.id}${entry.retry ? ' (de novo)' : ''}`)).toEqual(['p1', 'p2', 'p1 (de novo)'])
    state = answer(state, text(), {}, false, 'native')
    expect(state.step).toBe('context')
    expect(currentOf(state, text())).toMatchObject({ kind: 'card', stage: 'context', card: { id: 'c1' } })
    state = answer(state, text(), {}, true, 'native')
    state = answer(state, text(), {}, false, 'native')
    expect(state.step).toBe('done')
    expect(summaryOf(state, text())).toMatchObject({ practice: { right: 1, total: 2 }, context: { right: 1, total: 2 } })
  })

  it('o enunciado vem em inglês quando tudo o que ele usa foi provado; volta ao português depois de 2 erros, até 2 acertos', () => {
    const t = text()
    const card = t.items.rain.test[0]
    let state = start(t)
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
    let state = start()
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
    let state = start(own)
    expect(ids(state)).toEqual(['test:gonna'])
    state = answer(state, own, {}, false, 'native')
    expect(ids(state)).toEqual(['test:gonna', 'test:be', 'teach:gonna', 'test:gonna#1'])
    expect(currentOf(state, own)).toMatchObject({ kind: 'card', stage: 'test', card: { id: 'be_1' } })
  })

  it('o progresso guardado de antes (só ouvir) não serve: começa de novo', () => {
    expect(fitsStudy({ step: 'cards', at: 3, order: [], slots: {} })).toBe(false)
    expect(fitsStudy(start())).toBe(true)
  })
})

// T130/T131 (25/11, FR-042): primeiro o que precisa ser revisado, depois o que está aprendendo, depois o novo; dentro de cada grupo,
// sorteado (nunca todos de ouvir, depois todas as lacunas, depois todos os ditados).
describe('a ordem: o que precisa primeiro, sorteado dentro do grupo', () => {
  function many(): LanguageText {
    const item = (id: string, cards: Card[]) => ({ area: 'lexico' as const, kind: 'word', label: id, meaning: id, test: cards })
    return {
      ...text(),
      items: {
        n1: item('n1', [mc('n1_1')]),
        r1: item('r1', [mc('r1_1')]),
        n2: item('n2', [of('gap', 'n2_1')]),
        l1: item('l1', [mc('l1_1')]),
        n3: item('n3', [of('listen_mc', 'n3_1')]),
        k1: item('k1', [mc('k1_1')]),
        r2: item('r2', [mc('r2_1'), mc('r2_2')]),
        n4: item('n4', [of('odd', 'n4_1')]),
        l2: item('l2', [mc('l2_1')]),
      },
      // generated in runs of one type, as the AI writes them
      practice: [of('match', 'm1'), of('match', 'm2'), of('gap', 'g1'), of('gap', 'g2'), of('listen_mc', 'h1'), of('listen_mc', 'h2'), of('dictation', 'd1'), of('dictation', 'd2'), mc('pr'), mc('pl'), mc('pw')],
      schedules: { r1_1: due, r2_2: due, l1_1: learning, l2_1: relearning, pr: due, pl: learning, pw: notDue },
    }
  }
  // k1: seen in the base with a review due, by a card of another text (no schedule here): a review too
  const base: Knowledge = { k1: { recognize: 'learning', due: true }, r1: { recognize: 'fixed', due: true }, r2: { recognize: 'fixed', due: true }, l1: { recognize: 'learning', due: true }, l2: { recognize: 'learning', due: true } }

  it('Vocabulário: revisões vencidas → aprendendo → novos, cada grupo sorteado', () => {
    const orders = new Set<string>()
    for (const seed of SEEDS) {
      const state = startStudy(many(), base, NOW, seeded(seed))
      const order = state.pq.map(entry => entry.id)
      expect(new Set(order.slice(0, 3))).toEqual(new Set(['r1', 'r2', 'k1']))
      expect(new Set(order.slice(3, 5))).toEqual(new Set(['l1', 'l2']))
      expect(new Set(order.slice(5))).toEqual(new Set(['n1', 'n2', 'n3', 'n4']))
      orders.add(order.join(' '))
    }
    expect(orders.size).toBeGreaterThan(10)
  })

  it('Prática: o mesmo, por card; o que está em revisão e não venceu espera; o tipo do card não decide a sequência', () => {
    const news = ['m1', 'm2', 'g1', 'g2', 'h1', 'h2', 'd1', 'd2']
    const firsts = new Set<string>()
    let inRuns = 0
    for (const seed of SEEDS) {
      const order = startStudy(many(), base, NOW, seeded(seed)).queue.map(entry => entry.id)
      expect(order.slice(0, 2)).toEqual(['pr', 'pl'])
      expect(order).not.toContain('pw')
      expect([...order.slice(2)].sort()).toEqual([...news].sort())
      firsts.add(order[2][0])
      if (order.slice(2).join(' ') === news.join(' ')) inRuns++
    }
    // the first new card is of any type, and the generated runs (all "ligar", then all "lacuna"…) do not come back
    expect(firsts.size).toBeGreaterThanOrEqual(3)
    expect(inRuns).toBe(0)
  })

  it('o Contexto mantém a ordem das perguntas', () => {
    for (const seed of SEEDS.slice(0, 5)) expect(startStudy(text(), {}, NOW, seeded(seed)).ctx.map(entry => entry.id)).toEqual(['c1', 'c2'])
  })

  it('item novo começa por um card sorteado entre os dele; o que tem card vencido ou aprendendo começa por esse card', () => {
    const t = {
      ...text(),
      items: {
        v: { area: 'lexico' as const, kind: 'word', label: 'v', meaning: 'v', test: [mc('v_1'), of('gap', 'v_2'), of('listen_mc', 'v_3')] },
        d: { area: 'lexico' as const, kind: 'word', label: 'd', meaning: 'd', test: [mc('d_1'), of('gap', 'd_2'), of('listen_mc', 'd_3')] },
        a: { area: 'lexico' as const, kind: 'word', label: 'a', meaning: 'a', test: [mc('a_1'), of('gap', 'a_2'), of('listen_mc', 'a_3')] },
      },
      schedules: { d_2: due, a_3: learning },
    }
    const knowledge: Knowledge = { d: { recognize: 'fixed', due: true }, a: { recognize: 'learning', due: true } }
    const firstOf = (state: StudyState, id: string) => {
      const at = state.pq.findIndex(entry => entry.id === id)
      return shownCard({ ...state, pp: at }, t)
    }
    const news = new Set<string>()
    for (const seed of SEEDS) {
      const state = startStudy(t, knowledge, NOW, seeded(seed))
      expect(firstOf(state, 'd')).toBe('d_2')
      expect(firstOf(state, 'a')).toBe('a_3')
      news.add(String(firstOf(state, 'v')))
    }
    expect(news).toEqual(new Set(['v_1', 'v_2', 'v_3']))
  })

  it('sorteado ou não, depois de um erro o que o item exige vem antes dele e "aprender → testar de novo" fica junto, com outro card', () => {
    for (const seed of SEEDS) {
      const before = startStudy(text(), {}, NOW, seeded(seed))
      const first = before.pq[0].id
      const card = shownCard(before, text())
      let state = answer(before, text(), {}, false, 'native')
      const needs = (text().items[first].needs ?? []).map(id => `test:${id}`)
      expect(ids(state).slice(1, needs.length + 3)).toEqual([...needs, `teach:${first}`, `test:${first}#1`])
      // the needs right, the learn card, and the test again comes another way
      for (let n = 0; n < needs.length; n++) state = answer(state, text(), {}, true, 'native')
      state = taught(state)
      if (text().items[first].test.length > 1) expect(shownCard(state, text())).not.toBe(card)
    }
  })
})

// T132 (25/11, FR-043): as partes são clicáveis; cada uma guarda onde parou; terminada uma, segue para a próxima que falta.
describe('as partes', () => {
  it('troca de parte quando quiser, e cada uma continua de onde parou', () => {
    let state = start()
    state = answer(state, text(), {}, true, 'native') // gonna certo: o Vocabulário está no 2º
    state = goTo(state, 'practice')
    expect(state.step).toBe('practice')
    expect(shownCard(state, text())).toBe('p1')
    state = answer(state, text(), {}, true, 'native')
    state = goTo(state, 'context')
    expect(shownCard(state, text())).toBe('c1')
    state = goTo(state, 'test')
    expect(currentOf(state, text())).toMatchObject({ kind: 'card', stage: 'test', position: 2, card: { id: 'going_to_1' } })
    state = goTo(state, 'practice')
    expect(shownCard(state, text())).toBe('p2')
  })

  it('terminada uma parte, segue para a próxima que falta (dando a volta); o texto só termina quando todas terminam', () => {
    let state = goTo(start(), 'practice')
    state = answer(state, text(), {}, true, 'native')
    state = answer(state, text(), {}, true, 'native')
    expect(partLeft(state, 'practice')).toBe(0)
    expect(state.step).toBe('context')
    state = answer(state, text(), {}, true, 'native')
    state = answer(state, text(), {}, true, 'native')
    // the Vocabulário still has its 4 items
    expect(state.step).toBe('test')
    expect(state.done).toBeFalsy()
    for (let n = 0; n < 4; n++) state = answer(state, text(), {}, true, 'native')
    expect(state.step).toBe('done')
    expect(state.done).toBe(true)
  })

  it('uma parte terminada (ou vazia) não abre de novo', () => {
    let state = goTo(start(), 'practice')
    state = answer(state, text(), {}, true, 'native')
    state = answer(state, text(), {}, true, 'native')
    expect(goTo(state, 'practice').step).toBe('context')
    const empty = start({ ...text(), context: [] })
    expect(partLeft(empty, 'context')).toBe(0)
    expect(goTo(empty, 'context').step).toBe('test')
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
