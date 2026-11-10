import { afterEach, describe, expect, it, vi } from 'vitest'

import type { CatalogModel } from '@/controllers/models.controller'
import type { MediaInfo } from '@/lib/ai/config'
import { USES } from '@/lib/ai/config'
import {
  type DiagnosisCall,
  type DiagnosisDeps,
  type DiagnosisProgress,
  type DiagnosisReply,
  type DiagnosisResult,
  drawScreen,
  gradeAnswer,
  indicatedOf,
  liveDiagnosisDeps,
  NoCapability,
  planDiagnosis,
  RESEARCH_COST,
  type ResearchAsk,
  type ResearchVerdict,
  runDiagnosis,
  testCost,
  USE_BUDGET,
} from '@/lib/ai/diagnosis'
import { INVENTION_CAP, materialText, MIN_SCORE as MIN, type MiniTest, PT_PT_MARKS, requirementOf, RETEST_MARGIN, USE_REQUIREMENTS, werScore } from '@/lib/ai/use-requirements'
import type { AiProvider, AiUse, DiagnosisRecord } from '@/types/domain'
import { installFetch, jsonResponse, openAiStream } from '@/test/ai/fake-provider'

const NOW = '2026-11-08T12:00:00.000Z'

const TEXT: MediaInfo = { texto: true, imagem: false, audio: false, video: false, pdf: false }
const SEES: MediaInfo = { ...TEXT, imagem: true }
const EVERYTHING: MediaInfo = { texto: true, imagem: true, audio: true, video: true, pdf: true }
const SPEECH: MediaInfo = { texto: false, imagem: false, audio: true, video: false, pdf: null }

const DI: AiProvider = { id: 'di', type: 'deepinfra', name: 'DeepInfra', key: 'k', base: '' }
const OR: AiProvider = { id: 'or', type: 'openrouter', name: 'OpenRouter', key: 'k', base: '' }

const model = (id: string, input: number, output: number, media: MediaInfo | null = TEXT): CatalogModel => ({ id, name: id, media, price: { input, output } })
const unpriced = (id: string, media: MediaInfo | null = TEXT): CatalogModel => ({ id, name: id, media, price: null })
const hourly = (id: string, hour: number): CatalogModel => ({ id, name: id, media: SPEECH, price: { value: hour, unit: '/h', about: 'por hora de áudio' } })

const CITED = 'https://provas.exemplo/enem-fotossintese'

/** A reply that gets every point of the use's test. */
function gold(test: MiniTest): string {
  const { material, format } = test
  if (test.measure === 'wer') return test.wer!.reference
  if (material.kind === 'tela') return JSON.stringify({ texto: materialText(material), falando: material.call?.speaking ?? '' })
  if (material.kind === 'video') return JSON.stringify({ fala: material.speech, slide: material.slide })
  const hits = test.expected.map(item => item.accept[0])
  if (format.kind === 'markdown') return `## Visão geral\n\n${hits.join('. ')}.\n\n## Detalhes\n\nResumo fiel do material.`
  if (format.kind === 'text') return `${hits.join('. ')}.`
  if (format.kind === 'tree') {
    const branch = (at: number) => ({ texto: `Ramo ${'abc'[at / 2]}`, filhos: [{ texto: hits[at] }, { texto: hits[at + 1] }] })
    return JSON.stringify({ nome: 'Mapa', forma: 'arvore', raiz: { texto: 'Feira', filhos: [branch(0), branch(2), branch(4)] } })
  }
  if (format.kind !== 'json') throw new Error('unknown format')
  if ('questoes' in (format.lists ?? {})) return JSON.stringify({ questoes: hits.slice(0, 5).map(hit => ({ enunciado: hit, alternativas: { A: 'um', B: 'dois', C: 'três', D: 'quatro' }, correta: 'A' })) })
  if ('cartoes' in (format.lists ?? {})) return JSON.stringify({ cartoes: hits.slice(0, 8).map(hit => ({ frente: hit, verso: hit })) })
  if ('modules' in (format.lists ?? {})) return JSON.stringify({ is_course: true, name: 'Planilhas', description: `Curso de ${hits[4]}`, modules: hits.slice(0, 4).map(hit => ({ title: hit, start: 'início', end: 'fim' })) })
  if ('etiquetas' in (format.lists ?? {})) return JSON.stringify({ titulo: hits[0], etiquetas: hits.slice(1, 4) })
  if ('tarefas' in (format.lists ?? {})) {
    const tasks = test.expected.filter(item => item.together).map(item => ({ o_que: item.accept[0], dono: item.together![0][0], prazo: item.together![1][0] }))
    const loose = test.expected.filter(item => !item.together).map(item => item.accept[0])
    return JSON.stringify({ decisoes: loose.slice(0, 2), tarefas: tasks, sem_dono: loose.slice(2) })
  }
  return JSON.stringify({ url: CITED, enunciado: `Questão sobre ${hits[0]}` })
}

interface FakeOptions {
  catalogs?: Record<string, CatalogModel[]>
  reply?: (call: DiagnosisCall, nth: number) => string | Partial<DiagnosisReply> | Error | undefined
  verdicts?: (ask: ResearchAsk) => ResearchVerdict[]
  research?: (ask: ResearchAsk) => void
  researchSpent?: number | null
  missing?: string[]
  judge?: (call: DiagnosisCall) => string
  judgeUsage?: (call: DiagnosisCall) => { inputTokens: number; outputTokens: number }
}

function fake(options: FakeOptions = {}) {
  const log: string[] = []
  const calls: DiagnosisCall[] = []
  const counts = new Map<string, number>()
  const asks: ResearchAsk[] = []
  const screens: string[] = []
  const deps: DiagnosisDeps = {
    now: () => new Date(NOW),
    catalog: async provider => {
      log.push(`catalogo:${provider.id}`)
      return options.catalogs?.[provider.id] ?? []
    },
    research: async ask => {
      log.push(`pesquisa:${ask.family}`)
      asks.push(ask)
      options.research?.(ask)
      return { verdicts: options.verdicts?.(ask) ?? [], spent: options.researchSpent === undefined ? 0.0085 : options.researchSpent }
    },
    call: async request => {
      log.push(`${request.purpose}:${request.use}:${request.model.model}`)
      calls.push(request)
      if (request.purpose === 'juiz') return { text: options.judge?.(request) ?? JSON.stringify({ respostas: requirementOf(request.use).test.judge!.map(() => 'sim') }), usage: options.judgeUsage?.(request) ?? { inputTokens: 300, outputTokens: 20 } }
      const key = `${request.use}:${request.model.model}`
      const nth = (counts.get(key) ?? 0) + 1
      counts.set(key, nth)
      const custom = options.reply?.(request, nth)
      if (custom instanceof Error) throw custom
      const test = requirementOf(request.use).test
      const reply: Partial<DiagnosisReply> = typeof custom === 'string' ? { text: custom } : (custom ?? { text: gold(test) })
      return { text: reply.text ?? gold(test), usage: reply.usage ?? { inputTokens: 1000, outputTokens: 500 }, cited: reply.cited ?? (test.citedUrl ? [{ url: CITED }] : []) }
    },
    sample: async file => (options.missing?.includes(file) ? null : { data: 'QUJD', mime: file.endsWith('.mp3') ? 'audio/mpeg' : 'video/webm' }),
    screen: async material => {
      screens.push(material.title)
      return { data: 'QUJD', mime: 'image/png' }
    },
  }
  return { deps, log, calls, asks, screens }
}

const of = (result: DiagnosisResult, id: string, use?: AiUse) => result.records.find(record => record.model === id && (!use || record.use === use))

const tests = (log: string[]) => log.filter(line => line.startsWith('teste:'))

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('the order of the diagnosis', () => {
  it('reads the catalog for free, researches, and tests only the candidates left', async () => {
    const { deps, log } = fake({
      catalogs: { or: [model('cheap', 0.05, 0.1), model('bad', 0.06, 0.1), model('good', 0.07, 0.1)] },
      verdicts: () => [{ provider: 'openrouter', model: 'bad', keep: false, reason: 'nota baixa nos placares públicos' }],
    })
    const plan = await planDiagnosis({ providers: [OR], uses: ['titulo'] }, deps)
    expect(log).toEqual(['catalogo:or'])
    const result = await runDiagnosis(plan, deps)
    expect(log).toEqual(['catalogo:or', 'pesquisa:json', 'teste:titulo:cheap', 'teste:titulo:good'])
    expect(of(result, 'bad')).toMatchObject({ use: 'titulo', provider: 'openrouter', score: null, reason: 'nota baixa nos placares públicos', at: NOW })
  })

  it('asks the research once per family, about each candidate of the family', async () => {
    const { deps, asks } = fake({ catalogs: { or: [model('um', 0.05, 0.1), model('dois', 0.06, 0.1)] } })
    await runDiagnosis(await planDiagnosis({ providers: [OR], uses: ['prova', 'cartoes', 'estudo'] }, deps), deps)
    expect(asks.map(ask => ask.family).sort()).toEqual(['json', 'texto'])
    const json = asks.find(ask => ask.family === 'json')!
    expect(json.uses).toEqual(['prova', 'cartoes'])
    expect(json.candidates.map(item => item.model)).toEqual(['um', 'dois'])
    expect(json.searcher?.model).toBe('um')
  })

  it('a model the research says nothing about stays in', async () => {
    const { deps, log } = fake({ catalogs: { or: [model('um', 0.05, 0.1)] }, verdicts: () => [] })
    await runDiagnosis(await planDiagnosis({ providers: [OR], uses: ['titulo'] }, deps), deps)
    expect(tests(log)).toEqual(['teste:titulo:um'])
  })

  it('without a model that searches the web, it skips the research and still tests', async () => {
    const { deps, log } = fake({ catalogs: { di: [model('um', 0.05, 0.1)] } })
    const plan = await planDiagnosis({ providers: [DI], uses: ['titulo'] }, deps)
    expect(plan.estimate.research).toBe(0)
    const result = await runDiagnosis(plan, deps)
    expect(log.some(line => line.startsWith('pesquisa'))).toBe(false)
    expect(of(result, 'um')?.score).toBe(10)
  })

  it('a research that breaks does not stop the run', async () => {
    const { deps, log } = fake({
      catalogs: { or: [model('um', 0.05, 0.1)] },
      research: () => {
        throw new Error('caiu')
      },
    })
    const result = await runDiagnosis(await planDiagnosis({ providers: [OR], uses: ['titulo'] }, deps), deps)
    expect(tests(log)).toEqual(['teste:titulo:um'])
    expect(result.stopped).toBe(false)
  })

  it('tests the cheapest few: 5 for text, after researching at most 3 times as many', async () => {
    const list = Array.from({ length: 30 }, (_, at) => model(`m${String(at).padStart(2, '0')}`, 0.01 + at * 0.001, 0.02))
    const { deps, log, asks } = fake({ catalogs: { or: list } })
    await runDiagnosis(await planDiagnosis({ providers: [OR], uses: ['titulo'] }, deps), deps)
    expect(asks[0].candidates).toHaveLength(15)
    expect(tests(log)).toEqual(['m00', 'm01', 'm02', 'm03', 'm04'].map(id => `teste:titulo:${id}`))
  })

  it('a dropped candidate gives its place to the next one of the research pool', async () => {
    const list = Array.from({ length: 8 }, (_, at) => model(`m${at}`, 0.01 + at * 0.001, 0.02))
    const { deps, log } = fake({ catalogs: { or: list }, verdicts: () => [{ provider: 'openrouter', model: 'm0', keep: false, reason: 'fraco' }] })
    await runDiagnosis(await planDiagnosis({ providers: [OR], uses: ['titulo'] }, deps), deps)
    expect(tests(log)).toEqual(['m1', 'm2', 'm3', 'm4', 'm5'].map(id => `teste:titulo:${id}`))
  })

  it('the same model in two providers is two results, each with its own price', async () => {
    const { deps } = fake({ catalogs: { di: [model('igual', 0.06, 0.18)], or: [model('igual', 0.1, 0.3)] } })
    const result = await runDiagnosis(await planDiagnosis({ providers: [DI, OR], uses: ['titulo'] }, deps), deps)
    const both = result.records.filter(record => record.model === 'igual')
    expect(both.map(record => record.provider).sort()).toEqual(['deepinfra', 'openrouter'])
    expect(new Set(both.map(record => record.costPerNote)).size).toBe(2)
  })

  it('a catalog that cannot be read is reported and the others go on', async () => {
    const { deps, log } = fake({ catalogs: { or: [model('um', 0.05, 0.1)] } })
    const catalog = deps.catalog
    deps.catalog = async provider => {
      if (provider.id === 'di') throw new Error('sem chave')
      return catalog(provider)
    }
    const plan = await planDiagnosis({ providers: [DI, OR], uses: ['titulo'] }, deps)
    expect(plan.unread).toEqual([{ providerId: 'di', name: 'DeepInfra', reason: 'sem chave' }])
    await runDiagnosis(plan, deps)
    expect(tests(log)).toEqual(['teste:titulo:um'])
  })
})

describe('the estimated cost, before anything is spent', () => {
  it('estimates all the uses or just one', async () => {
    const { deps, calls } = fake({ catalogs: { or: [model('um', 0.05, 0.1, EVERYTHING), model('dois', 0.06, 0.2, EVERYTHING)] } })
    const all = await planDiagnosis({ providers: [OR] }, deps)
    const one = await planDiagnosis({ providers: [OR], uses: ['estudo'] }, deps)
    expect(calls).toEqual([])
    expect(one.estimate.total).toBeGreaterThan(0)
    expect(all.estimate.total).toBeGreaterThan(one.estimate.total)
    expect(one.estimate.total).toBeCloseTo(one.estimate.research + one.estimate.tests, 10)
    expect(one.estimate.research).toBe(RESEARCH_COST)
    expect(one.estimate.byUse).toHaveLength(1)
    expect(one.estimate.byUse[0]).toMatchObject({ use: 'estudo', tests: 2, unpriced: 0 })
  })

  it('a model without a price counts as unknown, never as free', async () => {
    const { deps } = fake({ catalogs: { di: [unpriced('sem-preco'), model('com-preco', 0.05, 0.1)] } })
    const plan = await planDiagnosis({ providers: [DI], uses: ['titulo'] }, deps)
    expect(plan.estimate.unpriced).toBe(1)
    const result = await runDiagnosis(plan, deps)
    expect(of(result, 'sem-preco')).toMatchObject({ score: 10, costPerNote: null })
    expect(result.unpriced).toBe(1)
  })

  it('never goes over the US$ 0.05 of one use: a test too dear is not run, and it says why', async () => {
    const { deps, log } = fake({ catalogs: { di: [model('caro', 20, 80), model('carissimo', 40, 160)] } })
    const plan = await planDiagnosis({ providers: [DI], uses: ['estudo'] }, deps)
    expect(plan.estimate.tests).toBe(0)
    const result = await runDiagnosis(plan, deps)
    expect(tests(log)).toEqual([])
    expect(result.skipped).toEqual([{ use: 'estudo', reason: expect.stringContaining('0,05') }])
    expect(result.records).toEqual([])
  })
})

describe('the automatic score', () => {
  const text = (use: AiUse, replace?: (gold: string) => string) => {
    const test = requirementOf(use).test
    return gradeAnswer(test, replace ? replace(gold(test)) : gold(test), test.citedUrl ? [{ url: CITED }] : [])
  }

  it.each(USES.map(use => use.id))('%s: a perfect answer gets a 10', use => {
    expect(text(use).score).toBe(10)
  })

  it('weighs the expected items', () => {
    const graded = text('estudo', answer => answer.replace('jacumã', 'outro lugar'))
    expect(graded).toMatchObject({ found: 11, expected: 12, format: true, ptBr: true, inventions: [] })
    expect(graded.score).toBeCloseTo((11 / 12) * 5 + 5, 2)
    expect(graded.missing).toEqual(['as salinas ficam ao sul do rio Jacumã'])
  })

  it('stops counting at the number of items a use needs', () => {
    const graded = text('cartoes')
    expect(graded).toMatchObject({ found: 8, expected: 8 })
  })

  it('compares without accents or case', () => {
    expect(text('estudo', answer => answer.toUpperCase().replace('## VISÃO GERAL', '## Geral').replace('## DETALHES', '## Mais')).found).toBe(12)
  })

  it('anything invented limits the score to 6', () => {
    const graded = text('estudo', answer => `${answer}\nFica em Mossoró.`)
    expect(graded.inventions).toEqual(['mossoró'])
    expect(graded.score).toBe(INVENTION_CAP)
  })

  it('a number out of nowhere is invented, where the use says so', () => {
    const graded = text('estudo', answer => `${answer}\nFundada em 1987.`)
    expect(graded.inventions).toEqual(['o número 1987'])
    expect(graded.score).toBe(INVENTION_CAP)
  })

  it('list numbers, step labels and cents are not invented numbers', () => {
    const graded = text('explicacao', answer => `${answer}\n\n1. Comece.\n2. Siga.\n3. Termine.\n\n### Passo 4: o total\n\n**5.** Fim: R$ 1.000,00 e R$ 1.210,00.`)
    expect(graded.inventions).toEqual([])
  })

  it('accepts a number the answer key lists, like a date written with a slash', () => {
    const graded = text('ata', answer => answer.replace('1º', '01/12'))
    expect(graded.inventions).toEqual([])
    expect(graded.found).toBe(6)
  })

  it('an owner who is not in the meeting is invented', () => {
    const graded = text('ata', answer => answer.replace('"dono":"Joel"', '"dono":"Carla"').replace('"dono":"joel"', '"dono":"Carla"'))
    expect(graded.inventions).toEqual(['o dono carla'])
    expect(graded.score).toBe(INVENTION_CAP)
  })

  it('"sem dono" is not an invented owner', () => {
    const graded = text('ata', answer => answer.replace('"dono":"joel"', '"dono":"sem dono"'))
    expect(graded.inventions).toEqual([])
  })

  it('ata: the task dropped in the meeting among the tasks loses points; left out or in "Descartado na reunião" it does not (FR-064)', () => {
    const test = requirementOf('ata').test
    const perfect = JSON.parse(gold(test))
    const asTask = gradeAnswer(test, JSON.stringify({ ...perfect, tarefas: [...perfect.tarefas, { o_que: 'Organizar o sorteio de panetone no Instagram', dono: 'Joel', prazo: 'sem prazo' }] }))
    expect(asTask.inventions).toEqual([expect.stringContaining('sorteio')])
    expect(asTask.score).toBeLessThan(MIN)
    expect(gradeAnswer(test, JSON.stringify({ ...perfect, descartado: ['Sorteio de panetone no Instagram → este ano não tem sorteio'] })).score).toBe(10)
    expect(gradeAnswer(test, gold(test)).score).toBe(10)
  })

  it('escrever: the same check in the Markdown, by the task section', () => {
    const test = requirementOf('escrever').test
    const body = '## Decisões\n\n- O panetone de cupuaçu entra no cardápio. Encomenda só pelo WhatsApp.\n\n## A fazer\n\n- Joel fecha a receita até sexta, dia 28.\n- Bruna publica o cardápio no Instagram até segunda, dia 1º.\n- Marta fecha as embalagens até quarta, dia 26.\n'
    const end = '\n## Em aberto\n\n- As entregas dos fins de semana ficaram sem dono.\n'
    const asTask = gradeAnswer(test, `${body}- Joel organiza o sorteio de panetone no Instagram, sem prazo.\n${end}`)
    expect(asTask.inventions).toEqual([expect.stringContaining('sorteio')])
    expect(asTask.score).toBeLessThan(MIN)
    expect(gradeAnswer(test, `${body}${end}\n## Descartado na reunião\n\n- Sorteio de panetone no Instagram → não tem sorteio.\n`).score).toBe(10)
    expect(gradeAnswer(test, `${body}${end}`).score).toBe(10)
  })

  it('a task needs its owner and deadline in the same row', () => {
    const graded = text('ata', answer => answer.replace('"dono":"joel"', '"dono":"marta"').replace('"dono":"marta","prazo":"26"', '"dono":"joel","prazo":"26"'))
    expect(graded.found).toBe(4)
  })

  it('checks the format the use asks for', () => {
    expect(text('prova', () => 'não é JSON').format).toBe(false)
    expect(text('estudo', answer => answer.replaceAll('## ', '')).format).toBe(false)
    expect(text('cartoes', answer => answer.replace(/\{"frente":[^}]*\},/, '')).format).toBe(false)
    expect(text('titulo', () => JSON.stringify({ titulo: 'Um título longo demais com muitas palavras a mais aqui', etiquetas: ['a', 'b', 'c'] })).format).toBe(false)
  })

  it('options that repeat, or cards with the same front, fail the format', () => {
    expect(text('prova', answer => answer.replace('"B":"dois"', '"B":"um"')).format).toBe(false)
    const test = requirementOf('cartoes').test
    const same = JSON.stringify({ cartoes: Array.from({ length: 8 }, () => ({ frente: 'a mesma', verso: 'x' })) })
    expect(gradeAnswer(test, same).format).toBe(false)
  })

  it('checks the tree of the map', () => {
    const test = requirementOf('mapa').test
    const parsed = JSON.parse(gold(test)) as { raiz: { filhos: { filhos: unknown[] }[] } }
    parsed.raiz.filhos[0].filhos.pop()
    expect(gradeAnswer(test, JSON.stringify(parsed)).format).toBe(false)
    expect(gradeAnswer(test, gold(test).replace('Ramo a', Array(13).fill('palavra').join(' '))).format).toBe(false)
  })

  it.each(PT_PT_MARKS)('"%s" fails the Brazilian Portuguese check', mark => {
    expect(text('estudo', answer => `${answer}\nO ${mark} ficou pronto.`).ptBr).toBe(false)
  })

  it('a word that merely contains a mark is fine', () => {
    expect(text('estudo', answer => `${answer}\nVamos execrar a poeira da difacto.`).ptBr).toBe(true)
  })

  it('an answer in English fails the Portuguese check', () => {
    const graded = text('estudo', () => '## The salt\n\n## The wind\n\nThe salt of the sea is made with the sun and the wind for this region.')
    expect(graded.ptBr).toBe(false)
  })

  it('scores a transcription by its word errors', () => {
    const { wer } = requirementOf('transcricao').test
    // "sexta-feira" counts as two words, like "sexta feira".
    const words = wer!.reference.replaceAll('-', ' ').split(' ')
    const wrong = [...words]
    for (let at = 0; at < 3; at++) wrong[at * 5] = 'errado'
    const graded = text('transcricao', () => wrong.join(' '))
    expect(graded.wer).toBeCloseTo(3 / words.length, 5)
    expect(graded.score).toBe(werScore(3 / words.length))
  })

  it('word errors ignore punctuation and case', () => {
    const { wer } = requirementOf('transcricao').test
    expect(text('transcricao', () => wer!.reference.replaceAll('.', '').toUpperCase()).wer).toBe(0)
  })

  it('a video whose speech came out wrong cannot pass', () => {
    const test = requirementOf('midia').test
    const graded = gradeAnswer(test, gold(test).replace('foi marcada para quinta-feira, às sete da noite, no', 'aconteceu ontem de manhã cedo bem perto do'))
    expect(graded.score).toBeLessThanOrEqual(INVENTION_CAP)
  })

  it('a screen read with many wrong characters cannot pass', () => {
    const test = requirementOf('tela').test
    const falando = test.material.kind === 'tela' ? test.material.call!.speaking : ''
    const graded = gradeAnswer(test, JSON.stringify({ texto: `${materialText(test.material)}\n${'texto a mais que não está na tela '.repeat(6)}`, falando }))
    expect(graded.cer).toBeGreaterThan(test.cer!.max)
    expect(graded.score).toBeLessThanOrEqual(INVENTION_CAP)
  })

  describe('Leitura de tela: quem fala na chamada (the ring on the speaking tile)', () => {
    const test = requirementOf('tela').test
    if (test.material.kind !== 'tela' || !test.material.call) throw new Error('the screen of the test is a video call')
    const { tiles, speaking } = test.material.call
    const read = materialText(test.material)
    const answer = (falando: string) => JSON.stringify({ texto: read, falando })
    const others = tiles.filter(name => name !== speaking)

    it('naming the tile with the ring keeps the full score', () => {
      const graded = gradeAnswer(test, answer(speaking))
      expect(graded.inventions).toEqual([])
      expect(graded.score).toBe(10)
    })

    it('accent, case and spaces around the name do not matter', () => {
      expect(gradeAnswer(test, answer(`  ${speaking.toUpperCase()} `)).score).toBe(10)
    })

    it.each(others)('naming another tile (%s) loses score below the minimum, even with all the text right', other => {
      const graded = gradeAnswer(test, answer(other))
      expect(graded.found).toBe(graded.expected)
      expect(graded.inventions).toEqual([`${other} como quem fala, e o anel está em ${speaking}`])
      expect(graded.score).toBe(INVENTION_CAP)
      expect(graded.score).toBeLessThan(MIN)
    })

    it('naming nobody, a name that is on no tile, or two tiles at once is also under the minimum', () => {
      for (const falando of ['', 'ninguém', 'Marta Oliveira', `${speaking} e ${others[0]}`]) expect(gradeAnswer(test, answer(falando)).score).toBeLessThan(MIN)
      expect(gradeAnswer(test, answer('')).inventions).toEqual([`ninguém como quem fala, e o anel está em ${speaking}`])
    })

    it('an answer with no "falando" at all is under the minimum', () => {
      expect(gradeAnswer(test, JSON.stringify({ texto: read })).score).toBeLessThan(MIN)
      expect(gradeAnswer(test, read).score).toBeLessThan(MIN)
    })

    it('says in the reason who was named, when a model fails it', async () => {
      const { deps } = fake({
        catalogs: { or: [model('ve', 0.05, 0.1, SEES), model('erra', 0.06, 0.1, SEES)] },
        reply: call => (call.model.model === 'erra' ? answer(others[0]) : undefined),
      })
      const result = await runDiagnosis(await planDiagnosis({ providers: [OR], uses: ['tela'] }, deps), deps)
      expect(of(result, 've')?.score).toBe(10)
      expect(of(result, 'erra')?.score).toBeLessThan(MIN)
      expect(of(result, 'erra')?.reason).toContain(`${others[0]} como quem fala`)
      expect(result.indicated.tela?.model).toBe('ve')
    })
  })

  it('a screen with its table written in pipes keeps a clean reading', () => {
    const test = requirementOf('tela').test
    const answer = materialText(test.material).replace('7º B\n12 projetos\nLaboratório 2', '| 7º B | 12 projetos | Laboratório 2 |')
    expect(gradeAnswer(test, answer).cer).toBe(0)
  })

  it('a web answer needs a page its search really read', () => {
    const test = requirementOf('web').test
    expect(gradeAnswer(test, gold(test), [{ url: `${CITED}/?utm=x#a` }]).inventions).toEqual([])
    expect(gradeAnswer(test, gold(test), [{ url: 'https://outra.exemplo/' }]).inventions).toEqual(['a página citada, que a busca não leu'])
  })

  it('the statement must match the page, when the page text is known', () => {
    const test = requirementOf('web').test
    expect(gradeAnswer(test, gold(test), [{ url: CITED, text: 'Questão sobre fotossíntese do ENEM de ano passado' }]).inventions).toEqual([])
    expect(gradeAnswer(test, gold(test), [{ url: CITED, text: 'Texto sobre a Revolução Francesa e a queda da Bastilha' }]).inventions).toEqual(['um enunciado que não está na página citada'])
  })
})

describe('the cheap AI judge', () => {
  it('is called only where the use asks for it', async () => {
    const { deps, log } = fake({ catalogs: { or: [model('um', 0.05, 0.1)] } })
    await runDiagnosis(await planDiagnosis({ providers: [OR], uses: ['titulo'] }, deps), deps)
    expect(log.filter(line => line.startsWith('juiz'))).toEqual([])
    const again = fake({ catalogs: { or: [model('um', 0.05, 0.1)] } })
    await runDiagnosis(await planDiagnosis({ providers: [OR], uses: ['estudo'] }, again.deps), again.deps)
    expect(again.log.filter(line => line.startsWith('juiz'))).toEqual(['juiz:estudo:um'])
  })

  it('is always the same cheap model', async () => {
    const { deps, calls } = fake({ catalogs: { or: [model('barato', 0.01, 0.02), model('medio', 0.5, 1), model('caro', 1, 2)] } })
    await runDiagnosis(await planDiagnosis({ providers: [OR], uses: ['estudo', 'aula'] }, deps), deps)
    expect(new Set(calls.filter(call => call.purpose === 'juiz').map(call => call.model.model))).toEqual(new Set(['barato']))
    expect(calls.filter(call => call.purpose === 'juiz')).toHaveLength(6)
  })

  it('gets the questions and the answer, and a "não" costs points', async () => {
    const { deps, calls } = fake({
      catalogs: { or: [model('um', 0.05, 0.1)] },
      judge: call => JSON.stringify({ respostas: requirementOf(call.use).test.judge!.map(() => 'não') }),
    })
    const result = await runDiagnosis(await planDiagnosis({ providers: [OR], uses: ['estudo'] }, deps), deps)
    const judged = calls.find(call => call.purpose === 'juiz')!
    expect(judged.prompt).toContain('Alguém que não leu o capítulo entenderia a nota?')
    expect(judged.prompt).toContain('jacumã')
    expect(of(result, 'um')).toMatchObject({ score: 6, reason: expect.stringContaining('juiz') })
  })

  it('a judge that does not answer costs nothing', async () => {
    const { deps } = fake({ catalogs: { or: [model('um', 0.05, 0.1)] }, judge: () => 'não sei dizer' })
    const result = await runDiagnosis(await planDiagnosis({ providers: [OR], uses: ['estudo'] }, deps), deps)
    expect(of(result, 'um')?.score).toBe(10)
  })
})

describe('the indicated pair', () => {
  it('is the cheapest at or above the minimum', async () => {
    const { deps } = fake({
      catalogs: { or: [model('barato-ruim', 0.01, 0.02), model('medio', 0.1, 0.2), model('caro', 1, 2)] },
      reply: call => (call.model.model === 'barato-ruim' ? `${gold(requirementOf(call.use).test)} mossoró` : undefined),
    })
    const result = await runDiagnosis(await planDiagnosis({ providers: [OR], uses: ['titulo'] }, deps), deps)
    expect(of(result, 'barato-ruim')?.score).toBe(INVENTION_CAP)
    expect(result.indicated.titulo?.model).toBe('medio')
  })

  it('is none when nothing passes', async () => {
    const { deps } = fake({ catalogs: { or: [model('ruim', 0.01, 0.02)] }, reply: () => 'qualquer coisa' })
    const result = await runDiagnosis(await planDiagnosis({ providers: [OR], uses: ['titulo'] }, deps), deps)
    expect(result.indicated.titulo).toBeUndefined()
  })

  it('is computed from the records, with the score of each pair', () => {
    const rows: DiagnosisRecord[] = [
      { use: 'estudo', provider: 'openrouter', model: 'a', score: 8, costPerNote: 0.01, at: NOW },
      { use: 'estudo', provider: 'openrouter', model: 'b', score: 9, costPerNote: 0.01, at: NOW },
      { use: 'estudo', provider: 'openrouter', model: 'c', score: 7, costPerNote: 0.001, at: NOW },
      { use: 'estudo', provider: 'openrouter', model: 'd', score: 10, costPerNote: null, at: NOW },
    ]
    expect(indicatedOf(rows, 'estudo')?.model).toBe('b')
  })
})

describe('a result near the minimum', () => {
  // titulo needs 2 of its items: one found scores 7.5 (near the minimum of 8), none scores 5.
  const titulo = requirementOf('titulo').test
  const oneFound = JSON.stringify({ titulo: 'salinas', etiquetas: ['um', 'dois', 'tres'] })
  const noneFound = JSON.stringify({ titulo: 'nada', etiquetas: ['um', 'dois', 'tres'] })

  it('is repeated once, and the two scores are averaged', async () => {
    expect(gradeAnswer(titulo, oneFound).score).toBeCloseTo(7.5, 5)
    const { deps, log } = fake({ catalogs: { or: [model('um', 0.05, 0.1)] }, reply: (_call, nth) => (nth === 1 ? oneFound : undefined) })
    const result = await runDiagnosis(await planDiagnosis({ providers: [OR], uses: ['titulo'] }, deps), deps)
    expect(tests(log)).toEqual(['teste:titulo:um', 'teste:titulo:um'])
    expect(of(result, 'um')?.score).toBeCloseTo(8.75, 5)
  })

  it('a result above the minimum but within the margin is repeated too', async () => {
    // Everything found, but only two tags: 9, one above the minimum.
    const { deps, log } = fake({ catalogs: { or: [model('um', 0.05, 0.1)] }, reply: () => JSON.stringify({ titulo: 'salinas e pedra branca', etiquetas: ['um', 'dois'] }) })
    const result = await runDiagnosis(await planDiagnosis({ providers: [OR], uses: ['titulo'] }, deps), deps)
    expect(of(result, 'um')?.score).toBe(9)
    expect(Math.abs(of(result, 'um')!.score! - 8)).toBeLessThanOrEqual(RETEST_MARGIN)
    expect(tests(log)).toHaveLength(2)
  })

  it('a result far from the minimum runs once', async () => {
    const one = fake({ catalogs: { or: [model('um', 0.05, 0.1)] } })
    await runDiagnosis(await planDiagnosis({ providers: [OR], uses: ['titulo'] }, one.deps), one.deps)
    expect(tests(one.log)).toHaveLength(1)
    const low = fake({ catalogs: { or: [model('um', 0.05, 0.1)] }, reply: () => noneFound })
    const result = await runDiagnosis(await planDiagnosis({ providers: [OR], uses: ['titulo'] }, low.deps), low.deps)
    expect(of(result, 'um')?.score).toBeCloseTo(5, 5)
    expect(tests(low.log)).toHaveLength(1)
  })

  it('a retest that breaks keeps the first score', async () => {
    const { deps, log } = fake({ catalogs: { or: [model('um', 0.05, 0.1)] }, reply: (_call, nth) => (nth === 1 ? oneFound : new Error('caiu')) })
    const result = await runDiagnosis(await planDiagnosis({ providers: [OR], uses: ['titulo'] }, deps), deps)
    expect(tests(log)).toHaveLength(2)
    expect(of(result, 'um')?.score).toBeCloseTo(7.5, 5)
    expect(result.failed).toEqual([])
  })
})

describe('what is saved', () => {
  const FIRST = [model('um', 0.05, 0.1), model('dois', 0.06, 0.1)]

  async function firstRun() {
    const { deps } = fake({ catalogs: { or: FIRST } })
    return (await runDiagnosis(await planDiagnosis({ providers: [OR], uses: ['titulo'] }, deps), deps)).records
  }

  it('saves per provider and model, with the date and the reason', async () => {
    const records = await firstRun()
    expect(records).toHaveLength(2)
    expect(records[0]).toEqual({ use: 'titulo', provider: 'openrouter', model: 'um', score: 10, costPerNote: expect.closeTo((3_000 * 0.05 + 100 * 2 * 0.1) / 1e6, 10), at: NOW, reason: 'Passou: tudo certo.' })
  })

  it('does not repeat what is saved, nor spend on it', async () => {
    const previous = await firstRun()
    const { deps, log } = fake({ catalogs: { or: FIRST } })
    const plan = await planDiagnosis({ providers: [OR], uses: ['titulo'], previous }, deps)
    expect(plan.estimate.total).toBe(0)
    const result = await runDiagnosis(plan, deps)
    expect(tests(log)).toEqual([])
    expect(log.some(line => line.startsWith('pesquisa'))).toBe(false)
    expect(result.records).toEqual(previous)
    expect(result.fresh).toEqual([])
    expect(result.indicated.titulo?.model).toBe('um')
  })

  it('tests a new model, and only it', async () => {
    const previous = await firstRun()
    const { deps, log } = fake({ catalogs: { or: [...FIRST, model('novo', 0.07, 0.1)] } })
    const result = await runDiagnosis(await planDiagnosis({ providers: [OR], uses: ['titulo'], previous }, deps), deps)
    expect(tests(log)).toEqual(['teste:titulo:novo'])
    expect(result.records).toHaveLength(3)
  })

  it('a new cheapest model gets in even when every place is taken', async () => {
    const list = Array.from({ length: 6 }, (_, at) => model(`m${at}`, 0.1 + at * 0.01, 0.2))
    const first = fake({ catalogs: { or: list } })
    const previous = (await runDiagnosis(await planDiagnosis({ providers: [OR], uses: ['titulo'] }, first.deps), first.deps)).records
    expect(previous).toHaveLength(5)
    const { deps, log } = fake({ catalogs: { or: [...list, model('novo', 0.01, 0.02)] } })
    await runDiagnosis(await planDiagnosis({ providers: [OR], uses: ['titulo'], previous }, deps), deps)
    expect(tests(log)).toEqual(['teste:titulo:novo'])
  })

  it('tests a model whose price changed', async () => {
    const previous = await firstRun()
    const { deps, log } = fake({ catalogs: { or: [model('um', 0.05, 0.3), model('dois', 0.06, 0.1)] } })
    const result = await runDiagnosis(await planDiagnosis({ providers: [OR], uses: ['titulo'], previous }, deps), deps)
    expect(tests(log)).toEqual(['teste:titulo:um'])
    expect(result.records).toHaveLength(2)
    expect(of(result, 'um')?.costPerNote).toBeCloseTo((3_000 * 0.05 + 100 * 2 * 0.3) / 1e6, 10)
  })

  it('a price that stopped being reported is not a new price', async () => {
    const previous = await firstRun()
    const { deps, log } = fake({ catalogs: { or: [unpriced('um'), model('dois', 0.06, 0.1)] } })
    await runDiagnosis(await planDiagnosis({ providers: [OR], uses: ['titulo'], previous }, deps), deps)
    expect(tests(log)).toEqual([])
  })

  it('repeats on request', async () => {
    const previous = await firstRun()
    const { deps, log } = fake({ catalogs: { or: FIRST } })
    const result = await runDiagnosis(await planDiagnosis({ providers: [OR], uses: ['titulo'], previous, redo: true }, deps), deps)
    expect(tests(log)).toHaveLength(2)
    expect(result.records).toHaveLength(2)
  })

  it('keeps the results of the other uses', async () => {
    const previous: DiagnosisRecord[] = [{ use: 'estudo', provider: 'openrouter', model: 'x', score: 9, costPerNote: 0.01, at: '2026-01-01T00:00:00.000Z' }]
    const { deps } = fake({ catalogs: { or: FIRST } })
    const result = await runDiagnosis(await planDiagnosis({ providers: [OR], uses: ['titulo'], previous }, deps), deps)
    expect(result.records).toContainEqual(previous[0])
    expect(result.records).toHaveLength(3)
  })

  it('does not fill the settings with every model of a big catalog', async () => {
    const list = Array.from({ length: 200 }, (_, at) => model(`sem-audio-${at}`, 0.01, 0.02))
    const { deps } = fake({ catalogs: { or: [...list, hourly('ouve', 0.012)] } })
    const result = await runDiagnosis(await planDiagnosis({ providers: [OR], uses: ['transcricao'] }, deps), deps)
    expect(of(result, 'ouve')?.score).toBe(10)
    expect(result.records.length).toBeLessThanOrEqual(13)
  })
})

describe('stopping midway', () => {
  it('keeps what already ran and spends nothing more', async () => {
    const control = new AbortController()
    const list = [model('um', 0.05, 0.1), model('dois', 0.06, 0.1), model('tres', 0.07, 0.1)]
    const { deps, log } = fake({
      catalogs: { or: list },
      reply: () => {
        control.abort()
        return undefined
      },
    })
    const plan = await planDiagnosis({ providers: [OR], uses: ['titulo'] }, deps)
    const result = await runDiagnosis(plan, deps, { signal: control.signal })
    expect(result.stopped).toBe(true)
    expect(tests(log)).toEqual(['teste:titulo:um'])
    expect(result.records.map(record => record.model)).toEqual(['um'])
    expect(result.spent).toBeGreaterThan(0)
  })

  it('a stop that interrupts a call counts as a stop, not as a failure', async () => {
    const control = new AbortController()
    const { deps } = fake({
      catalogs: { or: [model('um', 0.05, 0.1), model('dois', 0.06, 0.1)] },
      reply: (call, nth) => {
        if (call.model.model === 'dois' && nth === 1) {
          control.abort()
          return new Error('Geração cancelada.')
        }
        return undefined
      },
    })
    const result = await runDiagnosis(await planDiagnosis({ providers: [OR], uses: ['titulo'] }, deps), deps, { signal: control.signal })
    expect(result.stopped).toBe(true)
    expect(result.failed).toEqual([])
    expect(result.records.map(record => record.model)).toEqual(['um'])
  })

  it('a stop during the retest keeps the first score', async () => {
    const control = new AbortController()
    const oneFound = JSON.stringify({ titulo: 'salinas', etiquetas: ['um', 'dois', 'tres'] })
    const { deps } = fake({
      catalogs: { or: [model('um', 0.05, 0.1)] },
      reply: (_call, nth) => {
        if (nth === 1) return oneFound
        control.abort()
        return new Error('Geração cancelada.')
      },
    })
    const result = await runDiagnosis(await planDiagnosis({ providers: [OR], uses: ['titulo'] }, deps), deps, { signal: control.signal })
    expect(result.stopped).toBe(true)
    expect(of(result, 'um')?.score).toBeCloseTo(7.5, 5)
  })

  it('stopped before starting, nothing is called and the free results stay', async () => {
    const control = new AbortController()
    control.abort()
    const { deps, log } = fake({ catalogs: { or: [model('um', 0.05, 0.1), model('so-audio', 0.05, 0.1, SPEECH)] } })
    const result = await runDiagnosis(await planDiagnosis({ providers: [OR], uses: ['titulo'] }, deps), deps, { signal: control.signal })
    expect(result.stopped).toBe(true)
    expect(log).toEqual(['catalogo:or'])
    expect(result.records.map(record => record.model)).toEqual(['so-audio'])
  })
})

describe('a model that cannot do the use', () => {
  it('is out by the catalog, with the reason, and is never called', async () => {
    const { deps, log } = fake({ catalogs: { di: [model('so-texto', 0.05, 0.1), hourly('ouve', 0.012)] } })
    const result = await runDiagnosis(await planDiagnosis({ providers: [DI], uses: ['transcricao'] }, deps), deps)
    expect(of(result, 'so-texto')).toMatchObject({ score: null, reason: 'Ficou fora: o catálogo diz que o modelo não recebe áudio.' })
    expect(new Set(tests(log))).toEqual(new Set(['teste:transcricao:ouve']))
  })

  it('is out when the model refuses the material at test time, with the reason', async () => {
    const { deps } = fake({ catalogs: { di: [model('nao-diz', 0.05, 0.1, null)] }, reply: () => new NoCapability('audio') })
    const result = await runDiagnosis(await planDiagnosis({ providers: [DI], uses: ['transcricao'] }, deps), deps)
    expect(of(result, 'nao-diz')).toMatchObject({ score: null, reason: expect.stringContaining('áudio') })
  })

  it('needs a provider that searches for the web use', async () => {
    const { deps, log } = fake({ catalogs: { di: [model('sem-busca', 0.05, 0.1)] } })
    const result = await runDiagnosis(await planDiagnosis({ providers: [DI], uses: ['web'] }, deps), deps)
    expect(of(result, 'sem-busca')).toMatchObject({ score: null, reason: expect.stringContaining('web') })
    expect(tests(log)).toEqual([])
  })

  it('takes a model the catalog says searches', async () => {
    const native: CatalogModel = { ...model('nativo', 0.05, 0.1), web: true }
    const { deps, log } = fake({ catalogs: { di: [native] } })
    await runDiagnosis(await planDiagnosis({ providers: [DI], uses: ['web'] }, deps), deps)
    expect(tests(log)).toEqual(['teste:web:nativo'])
  })

  it('is out for the web when it says it cannot search', async () => {
    const { deps } = fake({ catalogs: { or: [model('um', 0.05, 0.1)] }, reply: () => JSON.stringify({ url: null }) })
    const result = await runDiagnosis(await planDiagnosis({ providers: [OR], uses: ['web'] }, deps), deps)
    expect(of(result, 'um')).toMatchObject({ score: null, reason: expect.stringContaining('web') })
  })

  it('leaves out the :batch models, which do not work in the app chat', async () => {
    const { deps, log } = fake({ catalogs: { or: [model('x:batch', 0.01, 0.02), model('x', 0.05, 0.1)] } })
    const result = await runDiagnosis(await planDiagnosis({ providers: [OR], uses: ['titulo'] }, deps), deps)
    expect(of(result, 'x:batch')).toMatchObject({ score: null, reason: expect.stringContaining('batch') })
    expect(tests(log)).toEqual(['teste:titulo:x'])
  })

  it('a call that fails for another reason gives no result and comes back next time', async () => {
    const { deps } = fake({ catalogs: { or: [model('um', 0.05, 0.1), model('dois', 0.06, 0.1)] }, reply: call => (call.model.model === 'um' ? new Error('O provedor caiu') : undefined) })
    const result = await runDiagnosis(await planDiagnosis({ providers: [OR], uses: ['titulo'] }, deps), deps)
    expect(result.failed).toEqual([{ use: 'titulo', provider: 'openrouter', model: 'um', reason: 'O provedor caiu' }])
    expect(of(result, 'um')).toBeUndefined()
    expect(of(result, 'dois')?.score).toBe(10)
    const again = fake({ catalogs: { or: [model('um', 0.05, 0.1), model('dois', 0.06, 0.1)] } })
    await runDiagnosis(await planDiagnosis({ providers: [OR], uses: ['titulo'], previous: result.records }, again.deps), again.deps)
    expect(tests(again.log)).toEqual(['teste:titulo:um'])
  })

  it('a use nobody can do says so', async () => {
    const { deps } = fake({ catalogs: { di: [model('so-texto', 0.05, 0.1)] } })
    const result = await runDiagnosis(await planDiagnosis({ providers: [DI], uses: ['tela'] }, deps), deps)
    expect(result.skipped).toEqual([{ use: 'tela', reason: expect.stringContaining('nenhum modelo') }])
  })
})

describe('the media samples', () => {
  const FILE_AUDIO = 'diagnostico/fala-20s.mp3'
  const FILE_VIDEO = 'diagnostico/video-15s.webm'

  it('without the sample the use is not tested, the result says why, and the run goes on', async () => {
    const { deps, log, calls } = fake({ catalogs: { or: [model('tudo', 0.05, 0.1, EVERYTHING)] }, missing: [FILE_AUDIO, FILE_VIDEO] })
    const plan = await planDiagnosis({ providers: [OR], uses: ['transcricao', 'midia', 'titulo'] }, deps)
    expect(plan.estimate.byUse.map(row => row.use)).toEqual(['titulo'])
    const result = await runDiagnosis(plan, deps)
    expect(result.skipped).toEqual([
      { use: 'midia', reason: expect.stringContaining(FILE_VIDEO) },
      { use: 'transcricao', reason: expect.stringContaining(FILE_AUDIO) },
    ])
    expect(tests(log)).toEqual(['teste:titulo:tudo'])
    expect(calls.some(call => call.use !== 'titulo')).toBe(false)
    expect(result.records.map(record => record.use)).toEqual(['titulo'])
  })

  it('sends the sample when it exists, with its duration', async () => {
    const { deps, calls } = fake({ catalogs: { di: [hourly('ouve', 0.012)] } })
    await runDiagnosis(await planDiagnosis({ providers: [DI], uses: ['transcricao'] }, deps), deps)
    expect(calls[0].sample).toEqual({ kind: 'audio', data: 'QUJD', mime: 'audio/mpeg', seconds: 20, file: FILE_AUDIO })
  })

  it('the screen test needs no file: its image is drawn from the fields', async () => {
    const { deps, calls, screens } = fake({ catalogs: { or: [model('ve', 0.05, 0.1, SEES)] }, missing: [FILE_AUDIO, FILE_VIDEO] })
    await runDiagnosis(await planDiagnosis({ providers: [OR], uses: ['tela'] }, deps), deps)
    expect(screens).toEqual(['Feira de Ciências · Escola Ipê-Amarelo'])
    expect(calls[0].sample).toEqual({ kind: 'imagem', data: 'QUJD', mime: 'image/png' })
  })

  it('bills a model priced by the hour for the seconds of the sample', async () => {
    const { deps } = fake({ catalogs: { di: [hourly('ouve', 0.012)] } })
    const result = await runDiagnosis(await planDiagnosis({ providers: [DI], uses: ['transcricao'] }, deps), deps)
    // The minimum is 9, so even a perfect transcription is within the margin and repeats.
    expect(result.spent).toBeCloseTo(((0.012 * 20) / 3600) * 2, 10)
    expect(of(result, 'ouve')?.costPerNote).toBeCloseTo(0.012, 10)
  })
})

describe('the progress', () => {
  it('reports done of total and what was spent so far', async () => {
    const events: DiagnosisProgress[] = []
    const { deps } = fake({ catalogs: { or: [model('um', 0.05, 0.1), model('dois', 0.06, 0.1)] } })
    const plan = await planDiagnosis({ providers: [OR], uses: ['titulo'] }, deps)
    const result = await runDiagnosis(plan, deps, { onProgress: event => events.push(event) })
    expect(events.map(event => [event.phase, event.done, event.total])).toEqual([
      ['pesquisa', 0, 3],
      ['pesquisa', 1, 3],
      ['testes', 2, 3],
      ['testes', 3, 3],
    ])
    const spent = events.map(event => event.spent)
    expect([...spent].sort((a, b) => a - b)).toEqual(spent)
    expect(events.at(-1)!.spent).toBeCloseTo(result.spent, 10)
    expect(events.at(-1)!.records).toEqual(result.records)
  })

  it('names the model being tested', async () => {
    const events: DiagnosisProgress[] = []
    const { deps } = fake({ catalogs: { or: [model('um', 0.05, 0.1)] } })
    await runDiagnosis(await planDiagnosis({ providers: [OR], uses: ['titulo'] }, deps), deps, { onProgress: event => events.push(event) })
    expect(events.at(-1)).toMatchObject({ use: 'titulo', model: 'um' })
  })

  it('the total shrinks when the research drops candidates that had a place', async () => {
    const events: DiagnosisProgress[] = []
    const { deps } = fake({ catalogs: { or: [model('um', 0.05, 0.1), model('dois', 0.06, 0.1)] }, verdicts: () => [{ provider: 'openrouter', model: 'um', keep: false, reason: 'fraco' }] })
    await runDiagnosis(await planDiagnosis({ providers: [OR], uses: ['titulo'] }, deps), deps, { onProgress: event => events.push(event) })
    expect(events.at(-1)).toMatchObject({ done: 2, total: 2 })
  })
})

describe('SC-010: the estimate against what the (fake) run reports as spent', () => {
  // The fake bills on its own terms, so this catches a part missing from either side (judge, search fee, media, hours, retests).
  const VISIBLE: Record<AiUse, number> = { estudo: 1300, aula: 1400, explicacao: 1250, prova: 950, web: 280, cartoes: 650, mapa: 750, tutor: 1100, curso: 860, titulo: 56, midia: 130, transcricao: 70, tela: 55, ata: 3200 }
  const MEDIA_TOKENS = { audio: 600, video: 4400, imagem: 1100 }
  const CHARS_PER_TOKEN = 3.7
  const REASONING = 2

  function billing(options: Omit<FakeOptions, 'reply'> & { reply?: FakeOptions['reply'] } = {}) {
    const made = fake({
      ...options,
      judgeUsage: call => ({ inputTokens: Math.ceil((call.system.length + call.prompt.length) / CHARS_PER_TOKEN), outputTokens: 40 }),
      reply: (call, nth) => {
        const custom = options.reply?.(call, nth)
        if (custom instanceof Error) return custom
        const test = requirementOf(call.use).test
        const text = typeof custom === 'string' ? custom : gold(test)
        const padding = Math.max(0, Math.round(VISIBLE[call.use] * CHARS_PER_TOKEN) - text.length)
        const answer = `${text}\n${'nota '.repeat(Math.floor(padding / 5))}`
        const sent = call.system.length + call.prompt.length
        return { text: test.measure === 'wer' ? text : answer, usage: { inputTokens: Math.ceil(sent / CHARS_PER_TOKEN) + (call.sample ? MEDIA_TOKENS[call.sample.kind] : 0), outputTokens: Math.ceil(answer.length / CHARS_PER_TOKEN) * REASONING } }
      },
    })
    return made
  }

  const within = (estimate: number, spent: number) => expect(Math.abs(estimate - spent) / spent).toBeLessThanOrEqual(0.2)

  const CATALOG = [model('deepseek-like', 0.06, 0.18, EVERYTHING), model('mimo-like', 0.14, 0.28, EVERYTHING), model('glm-like', 0.15, 0.5, EVERYTHING), model('gemini-like', 0.75, 3.75, EVERYTHING)]

  it.each(USES.map(use => use.id))('%s, one use on a new provider: within 20%% and under US$ 0.05', async use => {
    const { deps } = billing({ catalogs: { or: CATALOG } })
    const plan = await planDiagnosis({ providers: [OR], uses: [use] }, deps)
    const result = await runDiagnosis(plan, deps)
    expect(result.records.filter(record => record.score !== null).length).toBeGreaterThan(0)
    within(plan.estimate.total, result.spent)
    expect(result.spent).toBeLessThan(USE_BUDGET)
  })

  it('every use at once: within 20%', async () => {
    const { deps } = billing({ catalogs: { or: CATALOG } })
    const plan = await planDiagnosis({ providers: [OR] }, deps)
    within(plan.estimate.total, (await runDiagnosis(plan, deps)).spent)
  })

  it('still within 20% when a quarter of the models land near the minimum and repeat', async () => {
    const oneFound = JSON.stringify({ titulo: 'salinas', etiquetas: ['um', 'dois', 'tres'] })
    const { deps, log } = billing({ catalogs: { or: CATALOG }, reply: (call, nth) => (call.model.model === 'mimo-like' && nth === 1 ? oneFound : undefined) })
    const plan = await planDiagnosis({ providers: [OR], uses: ['titulo'] }, deps)
    const result = await runDiagnosis(plan, deps)
    expect(tests(log)).toHaveLength(5)
    within(plan.estimate.total, result.spent)
  })

  it('counts the judge, which runs on another model', async () => {
    const { deps, calls } = billing({ catalogs: { or: [model('barato', 0.01, 0.02), model('alvo', 0.5, 1.5)] } })
    const plan = await planDiagnosis({ providers: [OR], uses: ['estudo'] }, deps)
    const result = await runDiagnosis(plan, deps)
    expect(calls.filter(call => call.purpose === 'juiz')).toHaveLength(2)
    within(plan.estimate.total, result.spent)
  })

  it('falls back to the estimated research cost when the research cannot say what it spent', async () => {
    const { deps } = billing({ catalogs: { or: CATALOG }, researchSpent: null })
    const plan = await planDiagnosis({ providers: [OR], uses: ['titulo'] }, deps)
    const result = await runDiagnosis(plan, deps)
    within(plan.estimate.total, result.spent)
    expect(result.spent).toBeGreaterThanOrEqual(RESEARCH_COST)
  })

  it('without usage from the provider it counts the tokens of the reply', async () => {
    const { deps } = fake({ catalogs: { di: [model('um', 0.5, 1.5)] }, reply: () => ({ text: gold(requirementOf('titulo').test), usage: null as never }) })
    const inner = deps.call
    deps.call = async request => ({ ...(await inner(request)), usage: null })
    const result = await runDiagnosis(await planDiagnosis({ providers: [DI], uses: ['titulo'] }, deps), deps)
    expect(result.spent).toBeGreaterThan(0)
  })

  it('the requirement of each use is what the estimate reads', () => {
    expect(Object.keys(USE_REQUIREMENTS).sort()).toEqual(USES.map(use => use.id).sort())
  })
})

describe('the pieces of the estimate', () => {
  // A 20% tolerance cannot see a small part going missing, so each part is pinned on its own.
  const priced = (input: number, output: number, search?: number) => ({ providerId: 'or', provider: 'openrouter' as const, model: 'm', name: 'm', price: { per: 'token' as const, input, output, ...(search === undefined ? {} : { search }) }, web: true })
  const JUDGE = priced(1, 2)

  it('counts the judge only where the use asks for it', () => {
    expect(testCost('estudo', priced(1, 1), JUDGE)!).toBeGreaterThan(testCost('estudo', priced(1, 1), null)!)
    expect(testCost('titulo', priced(1, 1), JUDGE)).toBe(testCost('titulo', priced(1, 1), null))
  })

  it('counts the tokens of the video and of the screen', () => {
    expect(testCost('midia', priced(1, 0), null)!).toBeGreaterThan(4_000 / 1e6)
    expect(testCost('tela', priced(1, 0), null)!).toBeGreaterThan(1_000 / 1e6)
  })

  it('counts the fee of the search', () => {
    expect(testCost('web', priced(0, 0, 0.007), null)!).toBeGreaterThanOrEqual(0.007)
  })

  it('counts the reasoning, billed as output', () => {
    expect(testCost('titulo', priced(0, 1), null)!).toBeGreaterThanOrEqual((50 * 2) / 1e6)
  })

  it('bills the hour by the seconds of the sample', () => {
    const speech = { ...priced(0, 0), price: { per: 'hour' as const, hour: 3.6 } }
    expect(testCost('transcricao', speech, null)).toBeCloseTo(0.02 * 1.1, 10)
  })

  it('has no cost for a model without a price', () => {
    expect(testCost('estudo', { ...priced(1, 1), price: null }, JUDGE)).toBeNull()
  })

  it('adds the research to the total, once per family', async () => {
    const { deps } = fake({ catalogs: { or: [model('um', 0.05, 0.1, EVERYTHING)] } })
    const plan = await planDiagnosis({ providers: [OR], uses: ['prova', 'cartoes', 'estudo'] }, deps)
    expect(plan.estimate.research).toBeCloseTo(2 * RESEARCH_COST, 10)
    expect(plan.estimate.total).toBeCloseTo(plan.estimate.tests + 2 * RESEARCH_COST, 10)
  })

  it('what is spent counts the research, the tests, the fee and the judge', async () => {
    const { deps } = fake({ catalogs: { or: [model('um', 1, 2)] }, researchSpent: 0.01 })
    const web = await runDiagnosis(await planDiagnosis({ providers: [OR], uses: ['web'] }, deps), deps)
    expect(web.spent).toBeCloseTo(0.01 + (1000 * 1 + 500 * 2) / 1e6 + 0.007, 10)
    const judged = fake({ catalogs: { di: [model('um', 1, 2)] } })
    const estudo = await runDiagnosis(await planDiagnosis({ providers: [DI], uses: ['estudo'] }, judged.deps), judged.deps)
    expect(estudo.spent).toBeCloseTo((1000 * 1 + 500 * 2 + 300 * 1 + 20 * 2) / 1e6, 10)
  })
})

describe('the real connections, with the network faked', () => {
  const TARGET = { providerId: 'or', provider: 'openrouter', model: 'um', name: 'um', price: { per: 'token', input: 0.1, output: 0.2, search: 0.007 }, web: true } as DiagnosisCall['model']
  const SPEECH_MODEL = { providerId: 'di', provider: 'deepinfra', model: 'whisper', name: 'whisper', price: { per: 'hour', hour: 0.012 }, web: false } as DiagnosisCall['model']
  const base = { use: 'estudo', purpose: 'teste', system: 'Responda em português do Brasil.', prompt: 'Faça a nota.', maxTokens: 2000 } as DiagnosisCall
  const deps = liveDiagnosisDeps([OR, DI])

  it('asks the chat and reports the usage', async () => {
    const { calls } = installFetch(() => openAiStream('## Nota', 2, { prompt_tokens: 70, completion_tokens: 30 }))
    const reply = await deps.call({ ...base, model: TARGET })
    expect(reply).toMatchObject({ text: '## Nota', usage: { inputTokens: 70, outputTokens: 30 } })
    expect(calls[0].url).toBe('https://openrouter.ai/api/v1/chat/completions')
    expect(calls[0].body?.model).toBe('um')
  })

  it('sends the image, audio and video as the provider expects', async () => {
    const { calls } = installFetch(() => openAiStream('ok', 1, { prompt_tokens: 1, completion_tokens: 1 }))
    await deps.call({ ...base, model: TARGET, sample: { kind: 'imagem', data: 'QUJD', mime: 'image/png' } })
    await deps.call({ ...base, model: TARGET, sample: { kind: 'audio', data: 'QUJD', mime: 'audio/mpeg', seconds: 20, file: 'a.mp3' } })
    await deps.call({ ...base, model: TARGET, sample: { kind: 'video', data: 'QUJD', mime: 'video/webm', seconds: 15, file: 'v.webm' } })
    const parts = calls.map(call => ((call.body?.messages as { content: { type: string }[] }[])[1].content[0]))
    expect(parts[0]).toEqual({ type: 'image_url', image_url: { url: 'data:image/png;base64,QUJD' } })
    expect(parts[1]).toEqual({ type: 'input_audio', input_audio: { data: 'QUJD', format: 'mp3' } })
    expect(parts[2]).toEqual({ type: 'video_url', video_url: { url: 'data:video/webm;base64,QUJD' } })
  })

  it('a provider that refuses the media means the model lacks the capability', async () => {
    installFetch(() => jsonResponse({ error: { message: 'sem imagem' } }, 415))
    await expect(deps.call({ ...base, model: TARGET, sample: { kind: 'imagem', data: 'QUJD', mime: 'image/png' } })).rejects.toBeInstanceOf(NoCapability)
  })

  it('a refusal of plain text is an ordinary failure', async () => {
    installFetch(() => jsonResponse({ error: { message: 'modelo errado' } }, 404))
    const failure = await deps.call({ ...base, model: TARGET }).catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(Error)
    expect(failure).not.toBeInstanceOf(NoCapability)
  })

  it('searches with the web plugin and reports the pages read', async () => {
    const { calls } = installFetch(() => jsonResponse({ choices: [{ message: { content: '{"url":"https://a.b/c"}', annotations: [{ url_citation: { url: 'https://a.b/c' } }] } }] }))
    const reply = await deps.call({ ...base, model: TARGET, use: 'web', search: true })
    expect(reply).toMatchObject({ text: '{"url":"https://a.b/c"}', cited: [{ url: 'https://a.b/c' }], usage: null })
    expect(calls[0].body?.plugins).toEqual([{ id: 'web', max_results: 1 }])
  })

  it('sends a model priced by the hour to the transcription endpoint', async () => {
    const mock = vi.fn(async (_url: string, _init?: RequestInit) => jsonResponse({ text: 'Bom dia turma' }))
    vi.stubGlobal('fetch', mock)
    const reply = await deps.call({ ...base, model: SPEECH_MODEL, use: 'transcricao', sample: { kind: 'audio', data: 'QUJD', mime: 'audio/mpeg', seconds: 20, file: 'a.mp3' } })
    expect(reply.text).toBe('Bom dia turma')
    expect(mock.mock.calls[0][0]).toBe('https://api.deepinfra.com/v1/openai/audio/transcriptions')
    const form = mock.mock.calls[0][1]!.body as FormData
    expect(form.get('model')).toBe('whisper')
  })

  it('researches through the web plugin and reads the verdicts', async () => {
    const { calls } = installFetch(() => jsonResponse({ choices: [{ message: { content: JSON.stringify({ modelos: [{ id: 'um', fica: false, motivo: 'nota baixa' }, { id: 'dois', fica: true }] }) } }] }))
    const answer = await deps.research({ family: 'texto', uses: ['estudo'], candidates: [{ provider: 'openrouter', model: 'um', name: 'Um' }, { provider: 'openrouter', model: 'dois', name: 'Dois' }], searcher: TARGET })
    expect(answer.verdicts).toEqual([
      { provider: 'openrouter', model: 'um', keep: false, reason: 'nota baixa' },
      { provider: 'openrouter', model: 'dois', keep: true },
    ])
    expect(calls[0].body?.plugins).toEqual([{ id: 'web', max_results: 5 }])
    expect(JSON.stringify(calls[0].body?.messages)).toContain('um')
  })

  it('a sample that is not there is null, even when the server answers with the app page', async () => {
    installFetch(() => new Response('nada', { status: 404 }))
    expect(await deps.sample('diagnostico/fala-20s.mp3')).toBeNull()
    installFetch(() => new Response('<html>', { status: 200, headers: { 'content-type': 'text/html' } }))
    expect(await deps.sample('diagnostico/fala-20s.mp3')).toBeNull()
  })

  it('reads a sample into base64', async () => {
    installFetch(() => new Response(new Uint8Array([65, 66, 67]), { status: 200, headers: { 'content-type': 'audio/mpeg' } }))
    expect(await deps.sample('diagnostico/fala-20s.mp3')).toEqual({ data: 'QUJD', mime: 'audio/mpeg' })
  })

  it('draws every text of the screen', async () => {
    const drawn: string[] = []
    const paint = { fillRect: vi.fn(), strokeRect: vi.fn(), fillText: (text: string) => drawn.push(text), fillStyle: '', strokeStyle: '', font: '' }
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(paint as never)
    vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue('data:image/png;base64,QUJD')
    const material = requirementOf('tela').test.material
    if (material.kind !== 'tela') throw new Error('the screen test has a screen')
    expect(await drawScreen(material)).toEqual({ data: 'QUJD', mime: 'image/png' })
    expect(drawn.join('\n').split('\n').sort()).toEqual(materialText(material).split('\n').sort())
  })

  it('rings the tile of the speaker: the thickest stroke goes around the name of the speaking tile and no other', async () => {
    type Stroke = { x: number; y: number; w: number; h: number; width: number }
    const strokes: Stroke[] = []
    const names: { text: string; x: number; y: number }[] = []
    const paint = {
      fillRect: vi.fn(),
      strokeRect: (x: number, y: number, w: number, h: number) => strokes.push({ x, y, w, h, width: paint.lineWidth }),
      fillText: (text: string, x: number, y: number) => names.push({ text, x, y }),
      fillStyle: '',
      strokeStyle: '',
      font: '',
      lineWidth: 1,
    }
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(paint as never)
    vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue('data:image/png;base64,QUJD')
    const material = requirementOf('tela').test.material
    if (material.kind !== 'tela' || !material.call) throw new Error('the screen of the test is a video call')
    await drawScreen(material)
    const thickest = Math.max(...strokes.map(stroke => stroke.width))
    const rings = strokes.filter(stroke => stroke.width === thickest)
    expect(rings).toHaveLength(1)
    const [ring] = rings
    expect(thickest).toBeGreaterThanOrEqual(6)
    const inside = names.filter(name => name.x >= ring.x && name.x <= ring.x + ring.w && name.y >= ring.y && name.y <= ring.y + ring.h).map(name => name.text)
    expect(inside).toEqual([material.call.speaking])
    // Every tile has its name; the others have a frame in the same row, thinner than the ring.
    for (const name of material.call.tiles) expect(names.map(item => item.text)).toContain(name)
    expect(strokes.filter(stroke => stroke.width < thickest && stroke.y === ring.y)).toHaveLength(material.call.tiles.length - 1)
  })

  it('without a canvas there is no screen', async () => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null)
    const material = requirementOf('tela').test.material
    if (material.kind !== 'tela') throw new Error('the screen test has a screen')
    expect(await drawScreen(material)).toBeNull()
  })
})
