// T125 (spec 004, FR-040): o formato gerado no navegador, com os mesmos casos do servidor (api/internal/langs/validate_test.go) e o
// mesmo conteúdo de teste. Um texto só fica pronto sem problema; o que falha volta para a IA; o conserto tira só o card ruim.
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

import type { Card, Item } from '@/controllers/langs.controller'
import type { Content } from '@/lib/langs/content'
import { checkCard, readContent, repair, validate } from '@/lib/langs/generate/validate'

const raw = () => JSON.parse(readFileSync(resolve(process.cwd(), 'api/internal/langs/testdata/ok.json'), 'utf8'))
const ok = (): Content => readContent(raw())!
const card = (c: Content, id: string): Card | undefined =>
  [...c.practice, ...c.context, ...Object.values(c.items).flatMap(item => item.test)].find(found => found.id === id)
const item = (c: Content, id: string, change: (item: Item) => void) => change(c.items[id])

describe('validador do formato', () => {
  it('aceita um texto bom e mantém a ordem dos itens', () => {
    const content = ok()
    expect(validate(content)).toEqual([])
    expect(Object.keys(content.items)).toEqual(['walk', 'used_to', 'walk_way', 'neg_will'])
  })

  const cases: [string, (c: Content) => void, string][] = [
    ['card id repetido', c => (card(c, 'p_match')!.id = 'p_order'), 'card id p_order repeated'],
    ['id de item ruim', c => (c.items['Walk Up'] = { area: 'lexico', kind: 'word', label: 'x', meaning: 'y', test: [{ id: 't_x', type: 'tf', skill: 'read', q: 'q', a: true }] }), 'item id "Walk Up"'],
    ['exige item desconhecido', c => item(c, 'used_to', i => (i.needs = ['nowhere'])), 'needs nowhere'],
    ['exigências em ciclo', c => item(c, 'walk', i => (i.needs = ['used_to'])), 'cycle'],
    ['resposta fora das opções', c => (card(c, 't_walk_mc')!.a = 5), 't_walk_mc: a'],
    ['quatro opções', c => (card(c, 't_used_gap')!.opts = ['a', 'b', 'c', 'used to']), 't_used_gap: 5 options'],
    ['duas opções equivalentes', c => (card(c, 'c_lit')!.opts = ["won't", 'will not', 'de carro', 'de bicicleta', 'de trem']), 'c_lit: equivalent options'],
    ['find_diff aponta palavra que não mudou', c => (card(c, 'p_fd')!.a = 2), 'p_fd'],
    ['find_diff com duas mudanças', c => (card(c, 'p_fd')!.say = 'We used to run to school'), 'p_fd'],
    ['montar com peças que não fazem a frase', c => (card(c, 'p_order')!.tokens = ['I', 'used', 'to', 'run']), 'p_order'],
    ['completar sem lacuna', c => (card(c, 't_used_gap')!.text = 'I used to walk.'), 't_used_gap: text must have exactly one ___'],
    ['lacunas ouvidas: contagem', c => (card(c, 'p_dgap')!.answers = [['used to']]), 'p_dgap: 2 blanks'],
    ['lacunas ouvidas não refazem a frase', c => (card(c, 'p_dgap')!.answers = [['used to'], ['work']]), 'p_dgap: the blanks'],
    ['sentido sem padrão', c => item(c, 'walk_way', i => (i.pattern = '')), 'walk_way: a sense needs word, pattern and core'],
    ['sentido sem centro', c => item(c, 'walk_way', i => delete i.core), 'walk_way: a sense'],
    ['item sem card de teste', c => item(c, 'neg_will', i => (i.test = [])), 'neg_will: no test card'],
    ['card cobre item desconhecido', c => (card(c, 'p_odd')!.covers = ['ghost']), 'p_odd: covers ghost'],
    ['card de ouvir com habilidade de ler', c => (card(c, 'p_mp')!.skill = 'read'), 'p_mp: skill'],
    ['tipo desconhecido', c => (card(c, 'p_odd')!.type = 'essay' as never), 'p_odd: type essay'],
    ['área desconhecida', c => item(c, 'walk', i => (i.area = 'literatura' as never)), 'walk: area'],
    ['same_diff que mente', c => (card(c, 'p_sd')!.a = 'same'), 'p_sd'],
    ['sílaba forte fora', c => (card(c, 'p_stress')!.a = 2), 'p_stress'],
    ['sílabas que não fazem a palavra', c => (card(c, 'p_stress')!.syllables = ['to', 'night']), 'p_stress'],
    ['verdadeiro ou falso sem booleano', c => (card(c, 't_way_tf')!.a = 1), 't_way_tf'],
    ['par mínimo da mesma palavra', c => (card(c, 'p_mp')!.pair = ['walk', 'walk']), 'p_mp'],
    ['ligar com um par só', c => (card(c, 'p_match')!.pairs = [['walk', 'andar']]), 'p_match'],
    ['contexto sem dp', c => (card(c, 'c_lit')!.dp = ''), 'c_lit: dp'],
    ['falar sem alvo', c => (card(c, 'p_speak')!.target = ''), 'p_speak: target'],
    ['listen_mc sem a frase', c => delete card(c, 't_walk_listen')!.say, 't_walk_listen: say'],
    ['grupo de uma forma', c => c.equivalences.push(['gonna']), 'a group needs 2 forms'],
    ['pergunta vazia', c => (card(c, 'p_odd')!.q = ' '), 'p_odd: q'],
  ]
  it.each(cases)('acha o problema: %s', (_, change, want) => {
    const content = ok()
    change(content)
    expect(validate(content).join('\n')).toContain(want)
  })

  it('conhece a base: o que ela já tem não falta; ciclo pela base é ciclo', () => {
    const content = ok()
    item(content, 'used_to', i => (i.needs = ['walk', 'be']))
    expect(validate(content).length).toBeGreaterThan(0)
    expect(validate(content, { be: [] })).toEqual([])
    expect(validate(content, { be: ['used_to'] }).join(' ')).toContain('cycle')
  })

  it('formIsTopic aceita as formas equivalentes', () => {
    const content = ok()
    Object.assign(card(content, 'c_lit')!, { opts: ["won't", 'will not', 'de carro', 'de bicicleta', 'de trem'], formIsTopic: true })
    expect(validate(content)).toEqual([])
  })

  it('o protótipo estudado pelo dono passa', () => {
    const path = resolve(process.cwd(), 'specs/004-aprender-idiomas/prototipo/trechos/002-love-keyshia-cole.json')
    if (!existsSync(path)) return
    expect(validate(readContent(JSON.parse(readFileSync(path, 'utf8')))!)).toEqual([])
  })
})

describe('leitura tolerante e conserto', () => {
  it('lê campos em outro formato; o card ilegível vira um só card ruim', () => {
    const c = readContent({
      lines: [],
      equivalences: [],
      items: {},
      practice: [
        { id: 's', type: 'stress', skill: 'listen', q: 'Sílaba forte:', word: 'believe', syllables: 'be-lieve', a: 1 },
        { id: 'o', type: 'order', skill: 'read', q: 'Monte:', tokens: 'I walk home', answer: 'I walk home' },
        { id: 'm', type: 'minimal_pair', skill: 'listen', q: 'Qual?', pair: 'walk/work' },
        { id: 'x', type: 'mc', skill: 'read', q: '?', opts: { broken: true }, a: 0 },
      ],
      context: [],
    })!
    expect(c.practice[0].syllables).toEqual(['be', 'lieve'])
    expect(c.practice[1].tokens).toHaveLength(3)
    expect(c.practice[2].pair).toEqual(['walk', 'work'])
    expect(checkCard(c.practice[3], []).length).toBeGreaterThan(0)
    expect(readContent('não é json')).toBeNull()
    expect(readContent({ items: [] })).toBeNull()
  })

  it('conserta o id do item ("don\'t_mind" da IA real) e quem aponta para ele acompanha', () => {
    const content = ok()
    const walk = content.items.walk
    content.items = { "Don't-Walk": walk, ...Object.fromEntries(Object.entries(content.items).filter(([id]) => id !== 'walk')) }
    for (const c of [...content.practice, ...content.context]) c.covers = c.covers?.map(id => (id === 'walk' ? "Don't-Walk" : id))
    item(content, 'used_to', i => (i.needs = ["Don't-Walk"]))
    repair(content)
    expect(validate(content)).toEqual([])
    expect(Object.keys(content.items)[0]).toBe('dont_walk')
    expect(content.items.used_to.needs).toEqual(['dont_walk'])
    expect(card(content, 'p_match')!.covers![0]).toBe('dont_walk')
  })

  it('conserta a forma e tira só os cards ruins (o que a IA real fez em 23/11)', () => {
    const content = ok()
    Object.assign(card(content, 't_used_gap')!, { text: '', q: "Complete com a forma certa: 'I ______ walk to school.'" })
    card(content, 'c_lit')!.opts = ["won't", 'will not', 'de carro', 'de bicicleta', 'de trem']
    delete content.items.neg_will.test[0].say
    content.practice.push(
      { id: 'p_only_wont', type: 'tf', skill: 'read', q: "won't = não vai", a: true, covers: ['neg_will'] },
      { id: 'p_both', type: 'tf', skill: 'read', q: 'walk = andar', a: true, covers: ['neg_will', 'walk'] },
    )
    const dropped = repair(content)
    expect(validate(content)).toEqual([])
    expect(content.items.used_to.test[0]).toMatchObject({ text: 'I ___ walk to school.', q: 'Complete com a forma certa:', id: 'used_to__1' })
    expect(card(content, 'c_lit')).toBeUndefined()
    expect(card(content, 'p_only_wont')).toBeUndefined()
    expect(content.items.neg_will).toBeUndefined()
    expect(card(content, 'p_both')!.covers).toEqual(['walk'])
    expect(dropped.length).toBeGreaterThanOrEqual(3)
    expect(Object.keys(content.items)).toEqual(['walk', 'used_to', 'walk_way'])
    expect(content.items.walk.test.map(c => c.id)).toEqual(['walk__1', 'walk__2'])

    const silent = ok()
    for (const c of silent.practice) c.q = ''
    repair(silent)
    expect(silent.practice).toHaveLength(9)
    expect(card(silent, 'p_dgap')!.q).toBe('Ouça e complete:')
    expect(card(silent, 'p_mp')!.q).toBe('Ouça: "walk" ou "work"?')
    expect(card(silent, 'p_stress')!.q).toBe('Ouça e toque a sílaba forte de "today":')
    expect(card(silent, 'p_match')!.q).not.toBe('')
    expect(card(silent, 'p_odd')!.q).not.toBe('')
  })
})
