// T126 (spec 004, FR-040; constituição IV): a geração no navegador, para quem guarda os idiomas no Drive ou no Local, com os casos do
// servidor (api/internal/langs/generate_test.go) e uma IA falsa. O texto vai inteiro; por dentro a IA é chamada em pedaços.
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

import { BrowserLangs } from '@/lib/langs/browser/base'
import { AiNotConfigured, BrowserGenerator, type GenModel, prompt as buildPrompt } from '@/lib/langs/browser/generate'
import { MemoryLangFiles } from '@/lib/langs/files'

const DAY = new Date('2026-11-21T12:00:00Z')
const okJson = () => readFileSync(resolve(process.cwd(), 'api/internal/langs/testdata/ok.json'), 'utf8')

function setup(answer: (n: number, model: string, prompt: string) => string | Promise<string>, ids = ['primeiro', 'segundo']) {
  let clock = DAY
  let generator: BrowserGenerator
  const prompts: string[] = []
  const used: string[] = []
  const langs = new BrowserLangs(new MemoryLangFiles(), { now: () => clock, generationOf: id => generator.progressOf(id) })
  const models: GenModel[] = ids.map(id => ({
    id,
    chat: async (text: string) => {
      const n = prompts.length
      prompts.push(text)
      used.push(id)
      return answer(n, id, text)
    },
  }))
  generator = new BrowserGenerator(langs, () => models, { now: () => clock, chunkLines: 10 })
  return { langs, generator, prompts, used, tick: (ms: number) => (clock = new Date(clock.getTime() + ms)) }
}

const failure = (langs: BrowserLangs, id: string) => langs.getText('en', id).then(() => null, (error: { data: Record<string, unknown> }) => error.data)

describe('geração no navegador', () => {
  it('o texto fica pronto; o prompt leva a base do idioma (nunca a de outro idioma) e o texto; guarda o modelo', async () => {
    const { langs, generator, prompts } = setup(() => okJson())
    await langs.addLanguage({ code: 'en' })
    await langs.addLanguage({ code: 'es' })
    const spanish = await langs.addText('es', { title: 'Hola', text: 'Hola amigo' })
    await langs.saveContent('es', spanish.id, JSON.parse(okJson().replaceAll('"walk_way"', '"hola_saludo"')), 'm')
    const before = await langs.addText('en', { title: 'Antes', text: 'I walk' })
    await langs.saveContent('en', before.id, JSON.parse(okJson()), 'm')
    const { id } = await langs.addText('en', { title: 'Chuva', text: "I used to walk to school every day\nBut now I won't walk in the rain" })
    await generator.run('en', id)
    const text = await langs.getText('en', id)
    expect(Object.keys(text.items)).toHaveLength(4)
    expect(text.lines).toHaveLength(2)
    for (const want of ['neg_will', 'used_to', 'I used to walk to school every day', "But now I won't walk in the rain", 'Inglês']) expect(prompts[0]).toContain(want)
    expect(prompts[0]).not.toContain('hola_saludo')
  })

  it('o prompt traz as regras: 5 opções, distratores, nada de análise da obra, português, JSON', () => {
    const text = buildPrompt('Inglês', 'en', ['Hello'], [], 1, 1)
    for (const want of ['exactly 5 options', 'distractors', 'never', 'rhyme', 'verse', 'chorus', 'Portuguese', 'formIsTopic', 'JSON']) expect(text).toContain(want)
  })

  it('texto grande em pedaços vira um texto só, sem item repetido', async () => {
    const { langs, generator, prompts } = setup(n => {
      const own = `"piece_${n}": {"area": "lexico", "kind": "word", "label": "p${n}", "meaning": "pedaço", "test": [{"id": "t_piece_${n}", "type": "tf", "skill": "read", "q": "Verdade?", "a": true}]},`
      return okJson().replace('"items": {', `"items": {${own}`)
    })
    await langs.addLanguage({ code: 'en' })
    const lines = Array.from({ length: 25 }, (_, n) => `Line number ${n} of the song`)
    const { id } = await langs.addText('en', { title: 'Longa', text: lines.join('\n') })
    await generator.run('en', id)
    expect(prompts).toHaveLength(3)
    expect(prompts[1]).toContain('piece_0')
    expect(prompts[2]).toContain('piece_1')
    expect(prompts[1]).toContain('Line number 10 of the song')
    expect(prompts[1]).not.toContain('Line number 9 of the song\n')
    const text = await langs.getText('en', id)
    expect(text.lines).toHaveLength(25)
    expect(Object.keys(text.items)).toHaveLength(7)
    // every piece brings the same 9 practice cards: the same card is one (FR-039)
    expect(text.practice).toHaveLength(9)
  })

  it('devolve os problemas à IA com a resposta; depois de 2 tentativas, falha com o motivo', async () => {
    const bad = okJson().replaceAll('"skill": "read"', '"skill": "speak"').replaceAll('"skill": "listen"', '"skill": "speak"')
    const first = setup(n => (n === 0 ? bad : n === 1 ? 'isto não é json' : okJson()))
    await first.langs.addLanguage({ code: 'en' })
    const { id } = await first.langs.addText('en', { title: 'Erro', text: 'I walk' })
    await first.generator.run('en', id)
    expect(first.prompts).toHaveLength(3)
    expect(first.prompts[1]).toContain('no valid item')
    expect(first.prompts[1]).toContain(bad.slice(0, 40))
    expect(await failure(first.langs, id)).toBeNull()

    const always = setup(() => bad)
    await always.langs.addLanguage({ code: 'en' })
    const other = await always.langs.addText('en', { title: 'Sempre errado', text: 'I walk' })
    await expect(always.generator.run('en', other.id)).rejects.toThrow()
    expect(always.prompts).toHaveLength(3)
    expect(await failure(always.langs, other.id)).toMatchObject({ status: 'failed', error: 'invalid_content' })
  })

  it('o modelo que não responde passa para o próximo; todos fora = "provider_down"; sem IA configurada = "ai_not_configured"', async () => {
    const next = setup((_, model) => {
      if (model === 'primeiro') throw new Error('fora do ar')
      return okJson()
    })
    await next.langs.addLanguage({ code: 'en' })
    const { id } = await next.langs.addText('en', { title: 'Queda', text: 'I walk' })
    await next.generator.run('en', id)
    expect((await next.langs.getText('en', id)).items.walk).toBeDefined()
    expect(next.used).toEqual(['primeiro', 'segundo'])

    const down = setup(() => {
      throw new Error('fora do ar')
    })
    await down.langs.addLanguage({ code: 'en' })
    const off = await down.langs.addText('en', { title: 'Tudo fora', text: 'I walk' })
    await down.generator.run('en', off.id).catch(() => {})
    expect(await failure(down.langs, off.id)).toMatchObject({ status: 'failed', error: 'provider_down' })

    const none = setup(() => {
      throw new AiNotConfigured('Escolha um modelo')
    }, ['único'])
    await none.langs.addLanguage({ code: 'en' })
    const nothing = await none.langs.addText('en', { title: 'Sem IA', text: 'I walk' })
    await none.generator.run('en', nothing.id).catch(() => {})
    expect(await failure(none.langs, nothing.id)).toMatchObject({ status: 'failed', error: 'ai_not_configured' })
  })

  it('a fila gera um por vez, na ordem; retoma o que ficou gerando quando a aba fechou', async () => {
    let running = 0
    let most = 0
    const { langs, generator } = setup(async () => {
      running++
      most = Math.max(most, running)
      await new Promise(done => setTimeout(done, 10))
      running--
      return okJson()
    })
    await langs.addLanguage({ code: 'en' })
    const ids: string[] = []
    for (let n = 0; n < 3; n++) ids.push((await langs.addText('en', { title: `T${n}`, text: 'I walk' })).id)
    await generator.resume()
    generator.enqueue('en', ids[0])
    await generator.idle()
    expect(most).toBe(1)
    for (const id of ids) expect((await langs.getText('en', id)).status).toBe('ready')
  })

  it('constituição IV: diz quantas partes saíram, quando começou, a última e por volta de quando termina; some ao terminar', async () => {
    const seen: ReturnType<BrowserGenerator['progressOf']>[] = []
    const holder: { generator?: BrowserGenerator; id?: string; tick?: (ms: number) => void } = {}
    const { langs, generator, tick } = setup(() => {
      seen.push(holder.generator!.progressOf(holder.id!))
      holder.tick!(2 * 60_000)
      return okJson()
    })
    Object.assign(holder, { generator, tick })
    await langs.addLanguage({ code: 'en' })
    const lines = Array.from({ length: 25 }, (_, n) => `Line number ${n} of the song`)
    const { id } = await langs.addText('en', { title: 'Longa', text: lines.join('\n') })
    holder.id = id
    expect(generator.progressOf(id)).toBeUndefined()
    await generator.run('en', id)
    expect(seen).toHaveLength(3)
    expect(seen[0]).toEqual({ done: 0, total: 3, startedAt: DAY.toISOString() })
    expect(seen[1]).toMatchObject({ done: 1, lastAt: new Date(DAY.getTime() + 2 * 60_000).toISOString(), endsAt: new Date(DAY.getTime() + 6 * 60_000).toISOString() })
    expect(seen[2]?.done).toBe(2)
    expect(generator.progressOf(id)).toBeUndefined()
    const detail = await langs.getLanguage('en')
    expect(detail.texts[0].generation).toBeUndefined()
  })
})
