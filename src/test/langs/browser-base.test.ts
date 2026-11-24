// T124 (spec 004, FR-040; dono, 24/11: "para Drive fica no Drive, para somente local fica no local"): a base do idioma no navegador,
// com os mesmos casos do servidor (api/internal/langs/languages_test.go, reuse_test.go) e o mesmo conteúdo de teste (testdata/ok.json).
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

import type { Content } from '@/lib/langs/content'
import { BrowserLangs } from '@/lib/langs/browser/base'
import { MemoryLangFiles } from '@/lib/langs/files'
import type { Schedule } from '@/lib/langs/fsrs'

const DAY = new Date('2026-11-21T12:00:00Z')
const ok = () => JSON.parse(readFileSync(resolve(process.cwd(), 'api/internal/langs/testdata/ok.json'), 'utf8')) as Content
const hours = (n: number) => new Date(DAY.getTime() + n * 3_600_000)
const days = (n: number) => hours(24 * n)

function make(start = DAY) {
  let now = start
  let next = 0
  const files = new MemoryLangFiles()
  const langs = new BrowserLangs(files, { now: () => now, newId: () => `t${++next}` })
  return { langs, files, at: (when: Date) => (now = when) }
}

async function readyText(langs: BrowserLangs, title: string) {
  const { id } = await langs.addText('en', { title, text: "I used to walk to school every day\n\nBut now I won't walk in the rain\n" })
  await langs.saveContent('en', id, ok(), 'modelo-teste')
  return id
}

const schedule = (state: Schedule['state'], scheduledDays: number, due: Date): Schedule => ({
  state,
  step: 0,
  stability: 2.3,
  difficulty: 5,
  dueAt: due.toISOString(),
  lastReviewAt: DAY.toISOString(),
  scheduledDays,
  reps: 1,
  lapses: 0,
})

const code = async (work: Promise<unknown>) => work.then(() => 'ok', (error: { code?: string }) => error.code)

describe('idiomas no navegador', () => {
  it('cria idiomas da lista e outros com nome e código; recusa o repetido e o código ruim', async () => {
    const { langs } = make()
    expect(await langs.addLanguage({ code: 'EN' })).toEqual({ code: 'en', name: 'Inglês', locale: 'en-US' })
    expect(await code(langs.addLanguage({ code: 'en' }))).toBe('language_exists')
    expect(await code(langs.addLanguage({ code: 'xx' }))).toBe('invalid_language')
    expect(await code(langs.addLanguage({ code: 'não' }))).toBe('invalid_language')
    expect(await langs.addLanguage({ code: 'tlh', name: 'Klingon' })).toEqual({ code: 'tlh', name: 'Klingon', locale: 'tlh' })
    const list = await langs.listLanguages()
    expect(list.map(l => [l.code, l.items, l.texts])).toEqual([
      ['en', 0, 0],
      ['tlh', 0, 0],
    ])
    expect(await code(langs.getLanguage('sv'))).toBe('not_found')
  })

  it('textos viram a base: inteiro, em ordem, cards do texto com o id dele na frente; o segundo não dobra a base; apagar mantém', async () => {
    const { langs } = make()
    await langs.addLanguage({ code: 'en' })
    expect(await code(langs.addText('en', { title: ' ', text: 'x' }))).toBe('title_required')
    expect(await code(langs.addText('en', { title: 'Sem texto', text: '  \n ' }))).toBe('text_required')
    expect(await code(langs.addText('en', { title: 'Grande', text: 'a'.repeat(100_001) }))).toBe('text_too_large')
    expect(await code(langs.addText('sv', { title: 'X', text: 'y' }))).toBe('not_found')
    const pending = await langs.addText('en', { title: 'Esperando', text: 'Hello' })
    expect(pending.status).toBe('generating')
    await expect(langs.getText('en', pending.id)).rejects.toMatchObject({ code: 'not_ready', data: { status: 'generating' } })

    const id = await readyText(langs, 'Caminhar')
    const text = await langs.getText('en', id)
    expect(text.lines).toEqual(['I used to walk to school every day', "But now I won't walk in the rain"])
    expect(Object.keys(text.items)).toEqual(['walk', 'used_to', 'walk_way', 'neg_will'])
    expect(text.items.walk.test).toHaveLength(2)
    expect(text.practice).toHaveLength(9)
    expect(text.context).toHaveLength(1)
    expect(text.items.used_to.needs).toEqual(['walk'])
    expect(text.practice[0]).toMatchObject({ id: `${id}.p_order`, answer: 'I used to walk' })
    expect(text.equivalences).toHaveLength(2)
    expect(text.facets).toHaveLength(9)

    const detail = await langs.getLanguage('en')
    expect(detail).toMatchObject({ items: 4, seen: 0 })
    expect(detail.areas.gramatica?.total).toBe(2)
    expect(detail.areas.lexico?.total).toBe(1)
    expect(detail.texts.map(t => [t.id, t.status, t.progress])).toEqual([
      [pending.id, 'generating', 'start'],
      [id, 'ready', 'start'],
    ])

    const second = await readyText(langs, 'De novo')
    expect((await langs.getLanguage('en')).items).toBe(4)
    await langs.deleteText('en', second)
    const after = await langs.getLanguage('en')
    expect(after.items).toBe(4)
    expect(after.texts).toHaveLength(2)
    expect(await code(langs.deleteText('en', second))).toBe('not_found')
  })

  it('falhou: diz o motivo; "Tentar de novo" só no que falhou', async () => {
    const { langs } = make()
    await langs.addLanguage({ code: 'en' })
    const { id } = await langs.addText('en', { title: 'Falha', text: 'Hello' })
    expect(await code(langs.retryText('en', id))).toBe('not_failed')
    await langs.failText('en', id, 'provider_down')
    await expect(langs.getText('en', id)).rejects.toMatchObject({ code: 'not_ready', data: { status: 'failed', error: 'provider_down' } })
    expect((await langs.getLanguage('en')).texts[0]).toMatchObject({ status: 'failed', error: 'provider_down' })
    await langs.retryText('en', id)
    await expect(langs.getText('en', id)).rejects.toMatchObject({ data: { status: 'generating' } })
    expect(await langs.pendingTexts()).toEqual([{ code: 'en', id }])
  })

  it('o texto traz o que os itens exigem e vieram de outro texto, até o fim, com os cards de teste', async () => {
    const { langs } = make()
    await langs.addLanguage({ code: 'en' })
    await readyText(langs, 'Caminhar')
    const { id } = await langs.addText('en', { title: 'Depois', text: "I'm gonna walk\n" })
    await langs.saveContent(
      'en',
      id,
      {
        equivalences: [],
        items: { gonna: { area: 'lexico', kind: 'spoken_form', label: 'gonna', meaning: 'vou', needs: ['used_to'], test: [{ id: 'gonna_t', type: 'mc', skill: 'read', q: 'gonna =', opts: ['vou', 'fui', 'ia', 'irei', 'era'], a: 0, covers: ['gonna'] }] } },
        practice: [],
        context: [],
      },
      'modelo-teste',
    )
    const text = await langs.getText('en', id)
    expect(Object.keys(text.items)).toEqual(['gonna'])
    expect(Object.keys(text.needed ?? {}).sort()).toEqual(['used_to', 'walk'])
    expect(text.needed?.used_to.test.length).toBeGreaterThan(0)
    expect(text.needed?.walk.test.length).toBeGreaterThan(0)
    expect(text.needed?.used_to.needs).toEqual(['walk'])
  })

  it('respostas: a nota do FSRS e a repetição do card; a base do item sai dos cards', async () => {
    const { langs, files } = make()
    await langs.addLanguage({ code: 'en' })
    const id = await readyText(langs, 'Caminhar')
    const card = (name: string) => `${id}.${name}`
    const answer = (cardId: string, ok: boolean | null, extra: Partial<Parameters<BrowserLangs['recordAnswer']>[1]> = {}) =>
      langs.recordAnswer('en', { textId: id, cardId, stage: 'practice', promptLang: 'native', answer: '', ok, retry: false, ...extra })
    await answer(card('p_mp'), true, { schedule: schedule('review', 2, hours(48)) })
    let knowledge = await langs.getKnowledge('en')
    expect(knowledge.walk).toEqual({ listen: 'learning', due: false })
    await answer('t_wont_dict', false, { stage: 'test', schedule: schedule('relearning', 0, hours(0.2)) })
    knowledge = await langs.getKnowledge('en')
    expect(knowledge.neg_will).toMatchObject({ listen: 'learning', due: true })
    expect(knowledge.walk.due).toBe(true)
    await answer(card('p_speak'), null, { schedule: schedule('review', 3, DAY) })
    expect((await langs.getKnowledge('en')).neg_will.speak).toBeUndefined()
    await answer(card('p_order'), true, { retry: true, schedule: schedule('review', 1, hours(24)) })
    expect((await langs.getKnowledge('en')).used_to.produce).toBe('learning')
    const month = (await files.read<{ rating: number | null }[]>('en/answers/2026-11.json')) ?? []
    expect(month.map(a => a.rating)).toEqual([3, 1, null, 2])
    expect(await code(answer('nope', true))).toBe('not_found')
    expect(await code(answer(card('p_mp'), true, { stage: 'nowhere' as never }))).toBe('invalid_answer')
    expect(await code(answer(card('p_mp'), true, { schedule: { ...schedule('review', 0, DAY), state: 'done' as never } }))).toBe('invalid_answer')
    const detail = await langs.getLanguage('en')
    expect(detail).toMatchObject({ seen: 3, due: 2 })
    expect(detail.areas.lexico?.seen).toBe(1)
    expect(detail.texts[0].known).toBe(25)
  })

  it('fixado com todos os cards em 21+ dias; revisão vencida; "ouve e fala" com 2 cards de ouvir e 2 de falar em dias diferentes; apagar o texto mantém', async () => {
    const { langs, files, at } = make()
    await langs.addLanguage({ code: 'en' })
    const id = await readyText(langs, 'Caminhar')
    const answer = (cardId: string, s: Schedule) => langs.recordAnswer('en', { textId: id, cardId, stage: 'practice', promptLang: 'native', answer: '', ok: true, retry: false, schedule: s })
    await answer(`${id}.p_mp`, schedule('review', 25, days(25)))
    await answer(`${id}.p_sd`, schedule('review', 7, days(7)))
    expect((await langs.getKnowledge('en')).walk.listen).toBe('learning')
    at(days(7))
    await answer(`${id}.p_sd`, schedule('review', 30, days(37)))
    at(days(8))
    expect((await langs.getKnowledge('en')).walk).toMatchObject({ listen: 'fixed', due: false })
    at(days(40))
    expect((await langs.getKnowledge('en')).walk).toMatchObject({ listen: 'fixed', due: true })
    const [summary] = await langs.listLanguages()
    expect(summary).toMatchObject({ fixed: 1 })
    expect(summary.due).toBeGreaterThanOrEqual(1)
    expect((await langs.getKnowledge('en')).walk.hearsAndSpeaks).toBeUndefined()

    const cards = (await files.read<Record<string, unknown>>('en/cards.json'))!
    for (const s of ['s1', 's2']) cards[s] = { id: s, type: 'speak', skill: 'speak', data: { id: s, type: 'speak', skill: 'speak', q: 'Fale' }, covers: ['walk'], needs: [], createdAt: DAY.toISOString() }
    await files.write('en/cards.json', cards)
    at(DAY)
    await answer('s1', schedule('review', 3, days(3)))
    at(days(3))
    await answer('s1', schedule('review', 9, days(12)))
    at(days(40))
    expect((await langs.getKnowledge('en')).walk.hearsAndSpeaks).toBeUndefined()
    at(days(3))
    await answer('s2', schedule('review', 3, days(6)))
    at(days(40))
    expect((await langs.getKnowledge('en')).walk.hearsAndSpeaks).toBe(true)
    await langs.deleteText('en', id)
    expect((await langs.getKnowledge('en')).walk).toMatchObject({ listen: 'fixed', hearsAndSpeaks: true })
  })

  it('cards aproveitados entre textos: a mesma frase e o mesmo item são o mesmo card, com a repetição; contexto é só do texto', async () => {
    const { langs, files } = make()
    await langs.addLanguage({ code: 'en' })
    const first = await readyText(langs, 'Música A')
    await langs.recordAnswer('en', { textId: first, cardId: `${first}.p_mp`, stage: 'practice', promptLang: 'native', answer: '', ok: true, retry: false, schedule: schedule('review', 3, hours(72)) })
    await langs.recordAnswer('en', { textId: first, cardId: 't_walk_mc', stage: 'test', promptLang: 'native', answer: '', ok: true, retry: false, schedule: schedule('review', 2, hours(48)) })
    const second = await readyText(langs, 'Texto B')
    const text = await langs.getText('en', second)
    const ids = text.practice.map(c => c.id)
    expect(ids).toContain(`${first}.p_mp`)
    expect(ids).not.toContain(`${second}.p_mp`)
    expect(text.items.walk.test[0].id).toBe('t_walk_mc')
    expect(text.schedules?.[`${first}.p_mp`]?.scheduledDays).toBe(3)
    expect(text.schedules?.t_walk_mc?.scheduledDays).toBe(2)
    expect(text.context.map(c => c.id)).toEqual([`${second}.c_lit`])
    expect(Object.keys((await files.read<Record<string, unknown>>('en/cards.json'))!)).toHaveLength(16)
    await langs.deleteText('en', first)
    const after = await langs.getText('en', second)
    expect(after.practice).toHaveLength(9)
    expect(after.schedules?.[`${first}.p_mp`]?.scheduledDays).toBe(3)
  })

  it('progresso: continua de onde parou; terminado; recusa o que não é objeto e o texto que não existe', async () => {
    const { langs } = make()
    await langs.addLanguage({ code: 'en' })
    const id = await readyText(langs, 'Caminhar')
    expect(await code(langs.getProgress('en', id))).toBe('not_found')
    await langs.saveProgress('en', id, { part: 'practice', at: 3 })
    expect((await langs.getProgress('en', id)).state).toEqual({ part: 'practice', at: 3 })
    expect((await langs.getLanguage('en')).texts[0].progress).toBe('continue')
    await langs.saveProgress('en', id, { done: true })
    expect((await langs.getLanguage('en')).texts[0].progress).toBe('done')
    expect(await code(langs.saveProgress('en', id, 'nope' as never))).toBe('invalid_answer')
    expect(await code(langs.saveProgress('en', 'outro', {}))).toBe('not_found')
  })
})
