import { describe, expect, it } from 'vitest'

import { USES } from '@/lib/ai/config'
import { costPerNote, findPair, LIST_DATE, LIST_DATE_LABEL, LIST_TITLE, listReviewDue, type ModelPair, PAIRS, priceFromCatalog, RECOMMENDATIONS, recommendationOf, situationsOf, type TestedPair } from '@/lib/ai/recommendations'
import { requirementOf } from '@/lib/ai/use-requirements'
import type { AiConfig, AiUse } from '@/types/domain'

const DS_DI = 'deepseek-ai/DeepSeek-V4-Flash-0731'
const DS_OR = 'deepseek/deepseek-v4-flash-0731'
const MIMO = 'XiaomiMiMo/MiMo-V2.6-Flash'
const WHISPER = 'openai/whisper-large-v3-turbo'
const GLM_OR = 'z-ai/glm-5.3-flash'
const GEMINI_OR = 'google/gemini-3.8-flash'

const USE_IDS = USES.map(use => use.id)

/** The significant digits pesquisa.md rounded each cost to. */
const rounded = (value: number | null, digits: number) => Number(value!.toPrecision(digits))

function config(defaults: AiConfig['defaults'], extra: { mid: string; pid: string }[] = []): AiConfig {
  const known = [
    { pid: 'deepinfra', mid: DS_DI },
    { pid: 'deepinfra', mid: MIMO },
    { pid: 'deepinfra', mid: WHISPER },
    { pid: 'openrouter', mid: DS_OR },
    { pid: 'openrouter', mid: GLM_OR },
    { pid: 'openrouter', mid: GEMINI_OR },
    ...extra,
  ]
  return {
    providers: [
      { id: 'deepinfra', type: 'deepinfra', name: 'DeepInfra', key: 'k', base: '' },
      { id: 'openrouter', type: 'openrouter', name: 'OpenRouter', key: 'k', base: '' },
      { id: 'mine', type: 'custom', name: 'Minha IA', key: '', base: 'http://localhost:11434/v1' },
    ],
    models: known.map(({ pid, mid }) => ({ uid: `${pid}::${mid}`, pid, mid, name: mid })),
    defaults,
    steps: {},
  }
}

const di = (mid: string) => `deepinfra::${mid}`
const or = (mid: string) => `openrouter::${mid}`
const RECOMMENDED: AiConfig['defaults'] = { estudo: di(DS_DI), web: or(DS_OR), midia: di(MIMO), transcricao: di(WHISPER) }

const situationOf = (situations: ReturnType<typeof situationsOf>, use: AiUse) => situations.find(situation => situation.use === use)!

describe('the fixed list', () => {
  it('carries its date, shown as 07/11/2026', () => {
    expect(LIST_DATE).toBe('2026-11-07')
    expect(LIST_DATE_LABEL).toBe('07/11/2026')
    expect(LIST_TITLE).toBe('Recomendação do app · lista de 07/11/2026')
  })

  it('has one recommendation per use, in the order of the app', () => {
    expect(RECOMMENDATIONS.map(item => item.use)).toEqual(USE_IDS)
  })

  // pesquisa.md, "Recomendação do app · lista de 07/11/2026"
  const INDICATED: [AiUse, string, string][] = [
    ['estudo', 'deepinfra', DS_DI],
    ['aula', 'deepinfra', DS_DI],
    ['explicacao', 'deepinfra', DS_DI],
    ['prova', 'deepinfra', DS_DI],
    ['web', 'openrouter', DS_OR],
    ['cartoes', 'deepinfra', DS_DI],
    ['mapa', 'deepinfra', DS_DI],
    ['tutor', 'deepinfra', DS_DI],
    ['curso', 'deepinfra', DS_DI],
    ['titulo', 'deepinfra', DS_DI],
    ['midia', 'deepinfra', MIMO],
    ['transcricao', 'deepinfra', WHISPER],
    ['tela', 'deepinfra', MIMO],
    ['ata', 'deepinfra', DS_DI],
  ]

  it.each(INDICATED)('indicates for %s the pair %s · %s', (use, provider, model) => {
    expect(recommendationOf(use).indicated?.pair).toMatchObject({ provider, model })
  })

  // The scores of the wireframes (r-a2-geral.wf, r-a-lista-e-escada.wf): provisional until the battery runs.
  it.each([
    ['estudo', 9],
    ['aula', 9],
    ['explicacao', 8],
    ['prova', 9],
    ['web', 8],
    ['cartoes', 9],
    ['mapa', 9],
    ['tutor', 9],
    ['curso', 8],
    ['titulo', 10],
    ['midia', 8],
    ['transcricao', 9],
    ['tela', 9],
    ['ata', 9],
  ] as const)('%s has the score %i in the list', (use, score) => {
    expect(recommendationOf(use).indicated?.score).toBe(score)
  })

  it('says why, for every use', () => {
    for (const item of RECOMMENDATIONS) expect(item.why.length).toBeGreaterThan(0)
  })

  it('marks the uses that take the same pair as their mother, as in the "(herda)" of the list', () => {
    const inherits = RECOMMENDATIONS.filter(item => item.inherits).map(item => item.use)
    expect(inherits).toEqual(['aula', 'explicacao', 'prova', 'cartoes', 'mapa', 'tutor', 'curso', 'titulo', 'tela', 'ata'])
    expect(recommendationOf('tela').inherits).toBe('midia')
    expect(recommendationOf('ata').inherits).toBe('estudo')
    expect(recommendationOf('web').inherits).toBeNull()
    expect(recommendationOf('transcricao').inherits).toBeNull()
  })
})

describe('the indicated pair is the cheapest at or above the minimum', () => {
  it.each(USE_IDS)('%s', use => {
    const { indicated, ladder, outside } = recommendationOf(use)
    const min = requirementOf(use).minScore
    expect(indicated).toBe(ladder[0])
    expect(indicated!.score).toBeGreaterThanOrEqual(min) // SC-011
    const costs = ladder.map(rung => rung.cost!)
    expect(costs).toEqual([...costs].sort((a, b) => a - b))
    for (const rung of ladder) expect(rung.score).toBeGreaterThanOrEqual(min)
    for (const rung of outside) expect(rung.score === null || rung.score < min).toBe(true)
  })

  it.each(USE_IDS)('%s: the ladder only has pairs that can do the use', use => {
    const requirement = requirementOf(use)
    const { ladder, outside } = recommendationOf(use)
    for (const rung of [...ladder, ...outside]) {
      for (const need of requirement.needs) expect(rung.pair.takes, `${rung.pair.name}: ${need}`).toContain(need)
      expect(rung.pair.context).toBeGreaterThanOrEqual(requirement.context ?? 0)
    }
  })

  it('prioritizes the cheap: every indicated token pair costs at most US$ 0.30 per 1M of output', () => {
    for (const { indicated } of RECOMMENDATIONS) {
      const price = indicated!.pair.price
      if (price?.per === 'token') expect(price.output).toBeLessThanOrEqual(0.3)
    }
  })

  it('keeps out of the ladder what the list has not tested and what is below the minimum', () => {
    const outside = recommendationOf('ata').outside
    expect(outside.map(rung => [rung.pair.name, rung.score])).toEqual([
      ['Ling-3.0-flash', null],
      ['Gemma 4 26B A4B', 7],
    ])
  })

  it('keeps the whole ladder of the Ata as in the wireframe', () => {
    expect(recommendationOf('ata').ladder.map(rung => [rung.pair.name, rung.pair.provider, rung.score])).toEqual([
      ['DeepSeek V4 Flash 0731', 'deepinfra', 9],
      ['DeepSeek V4 Flash 0731', 'openrouter', 8],
      ['MiMo-V2.6-Flash', 'deepinfra', 8],
      ['GLM-5.3-Flash', 'openrouter', 10],
      ['Gemini 3.8 Flash', 'openrouter', 10],
    ])
  })
})

describe('cost per note', () => {
  // pesquisa.md, "Custo por nota" (the output counts double: reasoning)
  it.each([
    ['estudo', 0.002, 1],
    ['aula', 0.003, 1],
    ['explicacao', 0.002, 1],
    ['prova', 0.002, 1],
    ['cartoes', 0.002, 1],
    ['mapa', 0.001, 1],
    ['tutor', 0.007, 1],
    ['curso', 0.003, 1],
    ['titulo', 0.0002, 1],
    ['midia', 0.14, 2],
    ['transcricao', 0.012, 2],
    ['tela', 0.005, 1],
    ['ata', 0.006, 1],
  ] as const)('%s costs about US$ %f', (use, cost, digits) => {
    expect(rounded(recommendationOf(use).indicated!.cost, digits)).toBe(cost)
  })

  it('adds the search fee in Questões da web: about US$ 0.01', () => {
    expect(recommendationOf('web').indicated!.cost).toBeCloseTo(0.0092, 4)
  })

  it('counts the output twice, unless told otherwise', () => {
    const price = { per: 'token', input: 1, output: 1 } as const
    const ruler = { per: 'nota', input: 1_000_000, output: 1_000_000 }
    expect(costPerNote(price, ruler)).toBe(3)
    expect(costPerNote(price, ruler, 1)).toBe(2)
  })

  it('charges by the hour what is priced by the hour', () => {
    expect(costPerNote({ per: 'hour', hour: 0.012 }, requirementOf('transcricao').ruler)).toBeCloseTo(0.012)
  })

  it('cannot bill by the hour a use without hours', () => {
    expect(costPerNote({ per: 'hour', hour: 0.012 }, requirementOf('estudo').ruler)).toBeNull()
  })

  it('is null without a price, which the screen shows as "?"', () => {
    expect(costPerNote(null, requirementOf('estudo').ruler)).toBeNull()
  })

  it('gives every ruler of the use: Vídeo e áudio by the hour of video and of audio', () => {
    const costs = recommendationOf('midia').indicated!.costs
    expect(costs.map(cost => cost.per)).toEqual(['hora de vídeo', 'hora de áudio'])
    expect(rounded(costs[0].value, 2)).toBe(0.14)
    expect(rounded(costs[1].value, 1)).toBe(0.02)
  })

  it('gives the Ata by the five steps and by the ruler asked for', () => {
    const costs = recommendationOf('ata').indicated!.costs
    expect(rounded(costs[0].value, 1)).toBe(0.006)
    expect(rounded(costs[1].value, 1)).toBe(0.002)
  })

  // pesquisa.md, column "Subindo"
  const rungCost = (use: AiUse, name: string) => [...recommendationOf(use).ladder, ...recommendationOf(use).outside].find(rung => rung.pair.name === name)!.cost

  it.each([
    ['estudo', 'MiMo-V2.6-Flash', 0.004, 1],
    ['estudo', 'Gemma 4 26B A4B', 0.003, 1],
    ['estudo', 'GLM-5.3-Flash', 0.006, 1],
    ['estudo', 'Gemini 3.8 Flash', 0.039, 2],
    ['aula', 'GLM-5.3-Flash', 0.007, 1],
    ['prova', 'Ling-3.0-flash', 0.0007, 1],
    ['tutor', 'MiMo-V2.6-Flash', 0.014, 2],
    ['tutor', 'Claude Haiku 5.5', 0.013, 2],
    ['curso', 'DeepSeek V4.1 Flash 1017', 0.008, 1],
    ['midia', 'Qwen3.8 Omni Flash', 0.15, 2],
    ['midia', 'Gemini 3.5 Flash-Lite', 0.33, 2],
    ['midia', 'Gemini 3.8 Flash', 0.79, 2],
    ['tela', 'Gemma 4 26B A4B', 0.003, 1],
    ['tela', 'GLM-5.3-Flash', 0.007, 1],
    ['tela', 'Gemini 3.5 Flash-Lite', 0.022, 2],
    ['transcricao', 'whisper-large-v3', 0.027, 2],
    ['transcricao', 'Voxtral Small 24B', 0.18, 2],
    ['transcricao', 'MiMo-V2.6-Flash', 0.025, 2],
  ] as const)('%s · %s costs about US$ %f', (use, name, cost, digits) => {
    expect(rounded(rungCost(use, name), digits)).toBe(cost)
  })
})

describe('model + provider pairs', () => {
  it('the same model in two providers is two pairs, with their own price and score', () => {
    const deepInfra = findPair('deepinfra', DS_DI)!
    const openRouter = findPair('openrouter', DS_OR)!
    expect(deepInfra.name).toBe(openRouter.name)
    expect(deepInfra.price).toMatchObject({ input: 0.06, output: 0.18 })
    expect(openRouter.price).toMatchObject({ input: 0.046, output: 0.3 })
    const scores = recommendationOf('ata').ladder.filter(rung => rung.pair.name === 'DeepSeek V4 Flash 0731').map(rung => rung.score)
    expect(scores).toEqual([9, 8])
  })

  it('finds a pair only with its own provider', () => {
    expect(findPair('openrouter', DS_DI)).toBeUndefined()
    expect(findPair('custom', DS_DI)).toBeUndefined()
  })

  it('has no pair twice', () => {
    const keys = PAIRS.map((pair: ModelPair) => `${pair.provider}::${pair.model}`)
    expect(new Set(keys).size).toBe(keys.length)
  })

  it('searches the web only through OpenRouter pairs', () => {
    expect(findPair('openrouter', DS_OR)!.takes).toContain('web')
    expect(findPair('deepinfra', DS_DI)!.takes).not.toContain('web')
  })
})

describe('the price read from the provider', () => {
  it('turns a price per token into a Price', () => {
    expect(priceFromCatalog({ input: 0.06, output: 0.18 })).toEqual({ per: 'token', input: 0.06, output: 0.18 })
  })

  it('turns a price per hour into a Price', () => {
    expect(priceFromCatalog({ value: 0.012, unit: '/h', about: 'por hora de áudio' })).toEqual({ per: 'hour', hour: 0.012 })
  })

  it('has no price without both sides, or in another unit', () => {
    expect(priceFromCatalog({ input: 0.06, output: null })).toBeNull()
    expect(priceFromCatalog({ value: 0.01, unit: '/s', about: 'x' })).toBeNull()
    expect(priceFromCatalog(null)).toBeNull()
    expect(priceFromCatalog(undefined)).toBeNull()
  })
})

describe('the situation of each use against the defaults of the person', () => {
  it('has one line per use', () => {
    expect(situationsOf(config({})).map(situation => situation.use)).toEqual(USE_IDS)
  })

  it('with nothing set, nothing is compared', () => {
    const estudo = situationOf(situationsOf(config({})), 'estudo')
    expect(estudo.current).toBeNull()
    expect(estudo.same).toBe(false)
    expect(estudo.difference).toEqual({ kind: 'unset' })
  })

  it('with the recommended defaults, all 14 uses are the indicated', () => {
    const all = situationsOf(config(RECOMMENDED))
    expect(all.filter(situation => situation.same)).toHaveLength(14)
    for (const situation of all) expect(situation.difference).toBeNull()
  })

  it('says the provider type and the model id of the current pair', () => {
    const { current } = situationOf(situationsOf(config(RECOMMENDED)), 'estudo')
    expect(current).toMatchObject({ provider: 'deepinfra', providerId: 'deepinfra', model: DS_DI, inherits: false, from: null })
  })

  it('marks "herda" when the pair comes from Estudo', () => {
    const { current } = situationOf(situationsOf(config(RECOMMENDED)), 'aula')
    expect(current).toMatchObject({ provider: 'deepinfra', model: DS_DI, inherits: true, from: 'estudo' })
  })

  it('marks "herda" when the pair comes from Vídeo e áudio', () => {
    const { current } = situationOf(situationsOf(config(RECOMMENDED)), 'tela')
    expect(current).toMatchObject({ model: MIMO, inherits: true, from: 'midia' })
  })

  it('does not mark "herda" for a use with its own default, even if equal to the mother', () => {
    const { current } = situationOf(situationsOf(config({ ...RECOMMENDED, aula: di(DS_DI) })), 'aula')
    expect(current).toMatchObject({ inherits: false, from: null })
  })

  it('gives the score and the cost of the current pair', () => {
    const { current } = situationOf(situationsOf(config(RECOMMENDED)), 'aula')
    expect(current?.score).toBe(9)
    expect(rounded(current!.cost, 1)).toBe(0.003)
  })

  it('says how many times more expensive a different pair is', () => {
    const ata = situationOf(situationsOf(config({ ...RECOMMENDED, ata: or(GLM_OR) })), 'ata')
    expect(ata.same).toBe(false)
    expect(ata.difference?.kind).toBe('pricier')
    if (ata.difference?.kind !== 'pricier') throw new Error('expected pricier')
    expect(ata.difference.times).toBeCloseTo(0.0155 / 0.00588, 2)
  })

  it('uses the price of the list for a known pair that is not in the ladder of that use', () => {
    const tutor = situationOf(situationsOf(config({ ...RECOMMENDED, tutor: or(GEMINI_OR) })), 'tutor')
    expect(rounded(tutor.current!.cost, 2)).toBe(0.094)
    expect(tutor.current?.score).toBeNull()
    expect(tutor.difference?.kind).toBe('pricier')
  })

  it('says the score is below the minimum when the ladder says so, before talking about price', () => {
    const extra = [{ pid: 'openrouter', mid: 'google/gemma-4-26b-a4b-it' }]
    const ata = situationOf(situationsOf(config({ ...RECOMMENDED, ata: or('google/gemma-4-26b-a4b-it') }, extra)), 'ata')
    expect(ata.difference).toEqual({ kind: 'below', score: 7, min: 8 })
  })

  it('cannot compare a provider without price: the cost is null ("?")', () => {
    const extra = [{ pid: 'mine', mid: 'qwen3:14b' }]
    const ata = situationOf(situationsOf(config({ ...RECOMMENDED, ata: 'mine::qwen3:14b' }, extra)), 'ata')
    expect(ata.current).toMatchObject({ provider: 'custom', model: 'qwen3:14b', cost: null, score: null })
    expect(ata.difference).toEqual({ kind: 'other' })
  })

  it('reads the live price of a pair outside the list when given one', () => {
    const extra = [{ pid: 'openrouter', mid: 'some/other-model' }]
    const priceOf = () => ({ per: 'token', input: 1, output: 1 }) as const
    const ata = situationOf(situationsOf(config({ ...RECOMMENDED, ata: or('some/other-model') }, extra), { priceOf }), 'ata')
    expect(ata.current?.cost).toBeCloseTo((50_000 + 16_000) / 1e6)
    expect(ata.difference?.kind).toBe('pricier')
  })

  it('adds the OpenRouter search fee to a live price in Questões da web', () => {
    const extra = [{ pid: 'openrouter', mid: 'some/other-model' }]
    const priceOf = () => ({ per: 'token', input: 1, output: 1 }) as const
    const web = situationOf(situationsOf(config({ ...RECOMMENDED, web: or('some/other-model') }, extra), { priceOf }), 'web')
    expect(web.current?.cost).toBeCloseTo((9_000 + 6_000) / 1e6 + 0.007)
  })

  it('Questões da web only inherits a model that searches', () => {
    const noWeb = { estudo: di(DS_DI) }
    expect(situationOf(situationsOf(config(noWeb)), 'web').current).toBeNull()
    const onOpenRouter = { estudo: or(DS_OR) }
    expect(situationOf(situationsOf(config(onOpenRouter)), 'web').current).toMatchObject({ model: DS_OR, inherits: true })
    expect(situationOf(situationsOf(config(noWeb), { searchesWeb: () => true }), 'web').current).toMatchObject({ model: DS_DI, inherits: true })
  })

  describe('with the results of the person\'s own diagnosis', () => {
    const tested = (patch: Partial<TestedPair>): TestedPair => ({ use: 'mapa', provider: 'deepinfra', model: DS_DI, score: 7, costPerNote: null, at: '2026-11-08T09:12:00.000Z', ...patch })

    it('moves the indicated pair when the list one failed the test of the person', () => {
      const mapa = recommendationOf('mapa', [tested({})])
      expect(mapa.indicated?.pair).toMatchObject({ provider: 'openrouter', model: GLM_OR })
      expect(mapa.outside.map(rung => [rung.pair.model, rung.score, rung.listScore, rung.testedScore])).toEqual([[DS_DI, 7, 9, 7]])
    })

    it('says "below" for the current pair by the score of the person', () => {
      const mapa = situationOf(situationsOf(config(RECOMMENDED), { tested: [tested({})] }), 'mapa')
      expect(mapa.difference).toEqual({ kind: 'below', score: 7, min: 8 })
      expect(mapa.current).toMatchObject({ inherits: true, score: 7 })
    })

    it('keeps the list score of a pair the diagnosis did not run', () => {
      const ata = recommendationOf('ata', [tested({ use: 'ata', provider: 'openrouter', model: GEMINI_OR, score: null })])
      expect(ata.ladder.find(rung => rung.pair.model === GEMINI_OR)).toMatchObject({ score: 10, listScore: 10, testedScore: null })
    })

    it('uses the date and the newest record of a pair', () => {
      const newer = tested({ score: 9, at: '2026-11-09T09:12:00.000Z' })
      const mapa = recommendationOf('mapa', [tested({}), newer])
      expect(mapa.indicated).toMatchObject({ score: 9, testedScore: 9, testedAt: newer.at })
    })

    it('places a pair only the person tested, and leaves it out of the ladder without a price', () => {
      const custom = tested({ use: 'ata', provider: 'custom', model: 'qwen3:14b', score: 9, costPerNote: null })
      const ata = recommendationOf('ata', [custom])
      expect(ata.ladder.some(rung => rung.pair.model === 'qwen3:14b')).toBe(false)
      expect(ata.outside.find(rung => rung.pair.model === 'qwen3:14b')).toMatchObject({ score: 9, cost: null })
    })

    it('indicates a pair only the person tested when it is the cheapest with a price', () => {
      const custom = tested({ use: 'ata', provider: 'custom', model: 'qwen3:14b', score: 9, costPerNote: 0.001 })
      expect(recommendationOf('ata', [custom]).indicated?.pair).toMatchObject({ provider: 'custom', model: 'qwen3:14b', name: 'qwen3:14b' })
    })

    it('has no indicated pair when nothing passes', () => {
      const failed = recommendationOf('aula').ladder.map(rung => tested({ use: 'aula', provider: rung.pair.provider, model: rung.pair.model, score: 2 }))
      const aula = recommendationOf('aula', failed)
      expect(aula.indicated).toBeNull()
      expect(aula.inherits).toBeNull()
    })

    it('does not mix the results of other uses', () => {
      expect(recommendationOf('aula', [tested({})]).indicated?.score).toBe(9)
    })
  })
})

describe('the periodic review of the list (FR-052)', () => {
  it('is not due a day after the list', () => {
    expect(listReviewDue(new Date('2026-11-08T12:00:00Z'))).toBe(false)
  })

  it('is not due at exactly 30 days', () => {
    expect(listReviewDue(new Date('2026-12-07T00:00:00Z'))).toBe(false)
  })

  it('is due after about 30 days', () => {
    expect(listReviewDue(new Date('2026-12-08T00:00:00Z'))).toBe(true)
  })

  it('takes another interval', () => {
    expect(listReviewDue(new Date('2026-11-10T00:00:00Z'), 2)).toBe(true)
    expect(listReviewDue(new Date('2026-11-10T00:00:00Z'), 5)).toBe(false)
  })
})
