// T128 (spec 004, FR-040; "Reportar", dono 23/11, wireframe C): no Drive e no Local o card reportado é refeito no navegador, de outro
// jeito e com o motivo. Card de teste: os cards de teste do item são refeitos (só para a pessoa: aqui não há cache de todas as contas)
// e trocam em todo texto com o item; o que mantém o id mantém a repetição. Card das frases do texto: refeito só naquele texto.
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

import { BrowserLangs } from '@/lib/langs/browser/base'
import { BrowserGenerator } from '@/lib/langs/browser/generate'
import { MemoryLangFiles } from '@/lib/langs/files'

const DAY = new Date('2026-11-21T12:00:00Z')
const okJson = () => readFileSync(resolve(process.cwd(), 'api/internal/langs/testdata/ok.json'), 'utf8')

function setup(answer: (prompt: string) => string) {
  const prompts: string[] = []
  const langs = new BrowserLangs(new MemoryLangFiles(), { now: () => DAY })
  const generator = new BrowserGenerator(langs, () => [{ id: 'deepseek', chat: async (prompt: string) => (prompts.push(prompt), answer(prompt)) }], { now: () => DAY })
  return { langs, generator, prompts }
}

async function ready(langs: BrowserLangs, title: string) {
  const { id } = await langs.addText('en', { title, text: "I used to walk to school every day\nBut now I won't walk in the rain" })
  await langs.saveContent('en', id, JSON.parse(okJson()), 'deepseek')
  return id
}

const newTests = JSON.stringify({
  test: [
    { type: 'listen_mc', skill: 'listen', q: 'Ouça e escolha o sentido:', say: 'We walk to the park', opts: ['andar', 'correr', 'nadar', 'pular', 'parar'], a: 0 },
    { type: 'tf', skill: 'read', q: "'walk' = andar", a: true },
  ],
})

describe('Reportar no navegador', () => {
  it('card de teste: refaz os cards de teste do item, com o motivo, e troca em todo texto com o item', async () => {
    const { langs, generator, prompts } = setup(() => newTests)
    await langs.addLanguage({ code: 'en' })
    const first = await ready(langs, 'Música A')
    const second = await ready(langs, 'Texto B')
    await langs.recordAnswer('en', { textId: first, cardId: 't_walk_mc', stage: 'test', promptLang: 'native', answer: '', ok: true, retry: false })
    expect(await generator.report('en', first, 't_walk_mc', 'two_right', 'andar e caminhar')).toEqual({ status: 'remaking' })
    await generator.idle()
    expect(prompts[0]).toContain('Duas opções estão certas ("andar e caminhar")')
    expect(prompts[0]).toContain('"t_walk_mc"')
    for (const id of [first, second]) {
      const tests = (await langs.getText('en', id)).items.walk.test
      expect(tests.map(card => [card.id, card.q])).toEqual([
        ['walk__1', 'Ouça e escolha o sentido:'],
        ['walk__2', "'walk' = andar"],
      ])
      expect(tests[0].covers).toEqual(['walk'])
    }
  })

  it('card das frases do texto: refeito só naquele texto, no mesmo lugar e com o mesmo id', async () => {
    const card = JSON.stringify({ card: { type: 'dictation', skill: 'listen', q: 'Ouça e escreva a frase:', say: 'I walk to school', covers: ['walk'] } })
    const { langs, generator } = setup(() => card)
    await langs.addLanguage({ code: 'en' })
    const id = await ready(langs, 'Caminhar')
    await generator.report('en', id, `${id}.p_order`, 'confusing', '')
    await generator.idle()
    const text = await langs.getText('en', id)
    expect(text.practice[0]).toMatchObject({ id: `${id}.p_order`, type: 'dictation', say: 'I walk to school' })
    expect(text.practice).toHaveLength(9)
  })

  it('motivo fora da lista e card que não existe são recusados; resposta ruim da IA deixa o card como estava', async () => {
    const { langs, generator, prompts } = setup(() => 'isto não é json')
    await langs.addLanguage({ code: 'en' })
    const id = await ready(langs, 'Caminhar')
    await expect(generator.report('en', id, 't_walk_mc', 'feio', '')).rejects.toMatchObject({ code: 'invalid_reason' })
    await expect(generator.report('en', id, 'nope', 'other', '')).rejects.toMatchObject({ code: 'not_found' })
    await generator.report('en', id, `${id}.p_order`, 'other', '')
    await generator.idle()
    expect(prompts).toHaveLength(2)
    expect((await langs.getText('en', id)).practice[0]).toMatchObject({ id: `${id}.p_order`, type: 'order' })
  })
})
