import { describe, expect, it } from 'vitest'

import { plain } from '@/lib/ai/catalog'
import { ATA_STEPS, USES } from '@/lib/ai/config'
import { INVENTION_CAP, materialText, MIN_SCORE, PT_PT_MARKS, requirementOf, RETEST_MARGIN, scoreOf, SCORE_POINTS, STEP_REQUIREMENTS, USE_REQUIREMENTS, werScore } from '@/lib/ai/use-requirements'
import type { AiStep, AiUse } from '@/types/domain'

// Iterates over the app's real lists: a new AiUse or Ata step without a declaration breaks here (FR-051).
const USE_IDS = USES.map(use => use.id)
const STEP_IDS = ATA_STEPS.map(step => step.id)
const ALL: (AiUse | AiStep)[] = [...USE_IDS, ...STEP_IDS]

const CAPABILITIES = ['texto', 'imagem', 'audio', 'video', 'pdf', 'web', 'json']
const JUDGED = ['estudo', 'aula', 'explicacao']

const hasAny = (haystack: string, forms: string[]) => forms.some(form => haystack.includes(plain(form)))

describe('every use and every Ata step declares what it requires', () => {
  it('has no declaration for something that does not exist', () => {
    expect(Object.keys(USE_REQUIREMENTS).sort()).toEqual([...USE_IDS].sort())
    expect(Object.keys(STEP_REQUIREMENTS).sort()).toEqual([...STEP_IDS].sort())
  })

  it.each(ALL)('%s declares capabilities, PT-BR and what it asks of the model', id => {
    const requirement = requirementOf(id)
    expect(requirement).toBeDefined()
    expect(requirement.id).toBe(id)
    expect(requirement.needs.length).toBeGreaterThan(0)
    for (const need of requirement.needs) expect(CAPABILITIES).toContain(need)
    expect(requirement.language).toBe('pt-BR')
    expect(requirement.asks.length).toBeGreaterThan(0)
  })

  it.each(ALL)('%s has a minimum score: 8, unless its test measures something else', id => {
    const requirement = requirementOf(id)
    if (requirement.test.measure === 'wer') expect(requirement.minScore).toBe(werScore(requirement.test.wer!.max))
    else expect(requirement.minScore).toBe(MIN_SCORE)
  })

  it.each(ALL)('%s has a typical-note ruler', id => {
    const { ruler, altRulers = [] } = requirementOf(id)
    for (const item of [ruler, ...altRulers]) {
      expect(item.per.length).toBeGreaterThan(0)
      expect(item.input).toBeGreaterThan(0)
      expect(item.output).toBeGreaterThan(0)
    }
  })

  it.each(ALL)('%s has a miniature test with a known answer', id => {
    const { test } = requirementOf(id)
    expect(test.ask.length).toBeGreaterThan(0)
    expect(test.material).toBeDefined()
    expect(test.expected.length).toBeGreaterThan(0)
    for (const expected of test.expected) {
      expect(expected.item.length).toBeGreaterThan(0)
      expect(expected.accept.length).toBeGreaterThan(0)
    }
    expect(Array.isArray(test.forbidden)).toBe(true)
    expect(test.format).toBeDefined()
    expect(test.need ?? test.expected.length).toBeLessThanOrEqual(test.expected.length)
  })

  it('takes each use with what config.ts says it receives, except what the use routes elsewhere', () => {
    for (const use of USES) {
      if (use.route) continue
      for (const need of use.needs) expect(requirementOf(use.id).needs).toContain(need)
    }
    // Aula: PDF and photo go through Leitura de tela, so the Aula model only reads text.
    expect(requirementOf('aula').needs).toEqual(['texto'])
  })

  it('asks for what only some models do', () => {
    expect(requirementOf('web').needs).toContain('web')
    expect(requirementOf('midia').needs).toEqual(expect.arrayContaining(['audio', 'video']))
    expect(requirementOf('transcricao').needs).toEqual(['audio'])
    expect(requirementOf('tela').needs).toEqual(['imagem'])
    for (const id of ['prova', 'cartoes', 'mapa', 'titulo', 'ata', 'curso', 'contexto', 'tarefas', 'revisar', 'semdono'] as const) expect(requirementOf(id).needs).toContain('json')
  })

  it('asks for a long context where the material is long', () => {
    for (const id of ['estudo', 'aula', 'curso', 'tutor', 'ata'] as const) expect(requirementOf(id).context).toBeGreaterThanOrEqual(128_000)
    expect(requirementOf('midia').context).toBe(1_000_000)
    expect(requirementOf('titulo').context).toBeUndefined()
  })
})

describe('the typical note (pesquisa.md, "Nota típica por uso")', () => {
  const RULERS: [AiUse, string, number, number][] = [
    ['estudo', 'nota', 12_000, 4_000],
    ['aula', 'hora de aula', 15_000, 5_000],
    ['explicacao', 'nota', 8_000, 3_000],
    ['prova', 'nota', 10_000, 4_000],
    ['web', 'nota', 9_000, 3_000],
    ['cartoes', 'nota', 10_000, 3_000],
    ['mapa', 'nota', 10_000, 2_000],
    ['tutor', 'conversa', 85_000, 4_000],
    ['curso', 'nota', 20_000, 4_000],
    ['titulo', 'nota', 3_000, 100],
    ['midia', 'hora de vídeo', 1_000_000, 5_000],
    ['tela', '20 telas', 24_000, 3_000],
    ['ata', 'hora de reunião', 50_000, 8_000],
  ]

  it.each(RULERS)('%s: per %s, %i in and %i out', (id, per, input, output) => {
    expect(requirementOf(id).ruler).toMatchObject({ per, input, output })
  })

  it('counts one search in Questões da web', () => {
    expect(requirementOf('web').ruler.searches).toBe(1)
  })

  it('bills transcription by the hour of audio, and keeps tokens for models that hear through the chat', () => {
    expect(requirementOf('transcricao').ruler).toMatchObject({ per: 'hora de áudio', hours: 1, input: 115_000, output: 15_000 })
  })

  it('keeps the second ruler of Vídeo e áudio (audio only) and of the Ata (the one asked for)', () => {
    expect(requirementOf('midia').altRulers).toEqual([expect.objectContaining({ per: 'hora de áudio', input: 115_000, output: 5_000 })])
    expect(requirementOf('ata').altRulers).toEqual([expect.objectContaining({ input: 15_000, output: 3_000 })])
  })

  it('the five Ata steps add up to the whole Ata', () => {
    const sum = (key: 'input' | 'output') => STEP_IDS.reduce((total, id) => total + requirementOf(id).ruler[key], 0)
    expect(sum('input')).toBe(requirementOf('ata').ruler.input)
    expect(sum('output')).toBe(requirementOf('ata').ruler.output)
  })
})

describe('the miniature tests have a real answer key', () => {
  it.each(ALL)('%s: what is expected is in the material, unless it is a result the model must work out', id => {
    const { test } = requirementOf(id)
    const material = plain(materialText(test.material))
    for (const expected of test.expected) {
      if (expected.derived) continue
      expect(hasAny(material, expected.accept), `${id}: ${expected.item}`).toBe(true)
      for (const part of expected.together ?? []) expect(hasAny(material, part), `${id}: ${expected.item} (${part.join('/')})`).toBe(true)
    }
  })

  it.each(ALL)('%s: what is forbidden is not in the material', id => {
    const { test } = requirementOf(id)
    const material = plain(materialText(test.material))
    for (const word of test.forbidden) expect(material.includes(plain(word)), `${id}: ${word}`).toBe(false)
  })

  // Forbidden words are compared by substring: "iodo" would catch "período", "excel" would catch "excelente".
  it.each(ALL)('%s: an honest answer does not trip over what is forbidden', id => {
    const honest = plain('No período da safra o resultado foi excelente. A cooperativa, criada em assembleia, tem preços reais, sem contar a inflação. Bruna vai ficar no balcão e Joel vai ajudar. Marta vai conversar.')
    for (const word of requirementOf(id).test.forbidden) expect(honest.includes(plain(word)), `${id}: ${word}`).toBe(false)
  })

  it('has a chapter of about 1.5k tokens and a class of about 5 minutes, as in pesquisa.md', () => {
    expect(materialText(requirementOf('estudo').test.material).length).toBeGreaterThanOrEqual(5_000)
    expect(materialText(requirementOf('aula').test.material).split(/\s+/).length).toBeGreaterThanOrEqual(600)
  })

  it('does not take any tag for the generic word "sal"', () => {
    const sal = requirementOf('titulo').test.expected.find(expected => expected.item === 'sal marinho')!
    expect(sal.accept).not.toContain('sal')
  })

  it('uses the cheap AI judge only for the clarity of Estudo, Aula and Explicação', () => {
    for (const id of ALL) {
      const { judge } = requirementOf(id).test
      if (JUDGED.includes(id)) expect(judge?.length).toBeGreaterThan(0)
      else expect(judge).toBeUndefined()
    }
  })

  it.each([
    ['estudo', 12, undefined],
    ['aula', 7, undefined],
    ['explicacao', 5, undefined],
    ['prova', 8, 5],
    ['cartoes', 11, 8],
    ['mapa', 6, undefined],
    ['tutor', 3, undefined],
    ['curso', 5, undefined],
    ['titulo', 5, 2],
    ['ata', 6, undefined],
  ] as const)('%s has the items pesquisa.md calls for', (id, count, need) => {
    const { test } = requirementOf(id)
    expect(test.expected).toHaveLength(count)
    expect(test.need).toBe(need)
  })

  it('catches an invented owner: the Ata names the people who can own a task', () => {
    expect(requirementOf('ata').test.people).toEqual(['Marta', 'Joel', 'Bruna'])
    expect(requirementOf('tarefas').test.people).toEqual(['Marta', 'Joel', 'Bruna'])
    expect(plain(materialText(requirementOf('ata').test.material))).toContain('antonio')
  })

  it('needs the task with its owner and its deadline, not only the task', () => {
    const tasks = requirementOf('ata').test.expected.filter(expected => expected.together)
    expect(tasks).toHaveLength(3)
    for (const task of tasks) expect(task.together).toHaveLength(2)
  })

  it('checks that the web answer was really read: the URL must be among the cited pages', () => {
    expect(requirementOf('web').test.citedUrl).toBe(true)
  })

  it('measures transcription by word errors, up to 10%, on a known speech of 50 words', () => {
    const { test } = requirementOf('transcricao')
    expect(test.measure).toBe('wer')
    expect(test.wer?.max).toBe(0.1)
    expect(test.wer?.reference.split(/\s+/)).toHaveLength(50)
    expect(test.material).toMatchObject({ kind: 'audio', seconds: 20 })
  })

  it('has Vídeo e áudio hear the speech (up to 15%) and read the slide', () => {
    const { test } = requirementOf('midia')
    expect(test.measure).toBe('itens')
    expect(test.wer?.max).toBe(0.15)
    expect(test.material).toMatchObject({ kind: 'video', seconds: 15 })
  })

  it('draws Leitura de tela: a 1280x720 screen with title, 3 topics, a number and a 2x3 table', () => {
    const { test } = requirementOf('tela')
    expect(test.material).toMatchObject({ kind: 'tela', width: 1280, height: 720 })
    if (test.material.kind !== 'tela') throw new Error('expected a screen')
    expect(test.material.topics).toHaveLength(3)
    expect(test.material.table).toHaveLength(2)
    for (const row of test.material.table) expect(row).toHaveLength(3)
    expect(test.cer?.max).toBeGreaterThan(0)
  })

  it('keeps the sample files under public/diagnostico/', () => {
    for (const id of ALL) {
      const { material } = requirementOf(id).test
      if (material.kind === 'audio' || material.kind === 'video') expect(material.file).toMatch(/^diagnostico\//)
    }
  })

  it('checks the map as the tree the app uses: 3 branches of 2 items, short phrases', () => {
    expect(requirementOf('mapa').test.format).toMatchObject({ kind: 'tree', branches: 3, leaves: 2, maxWords: 12 })
  })
})

describe('the score of a miniature test (pesquisa.md: 50, 30, 10, 10)', () => {
  const perfect = { found: 8, expected: 8, inventions: 0, format: true, ptBr: true }

  it('weighs expected items 5, nothing invented 3, format 1 and Brazilian Portuguese 1', () => {
    expect(SCORE_POINTS).toEqual({ expected: 5, invented: 3, format: 1, ptBr: 1 })
    expect(scoreOf(perfect)).toBe(10)
    expect(scoreOf({ ...perfect, found: 4 })).toBeCloseTo(7.5)
    expect(scoreOf({ ...perfect, format: false })).toBe(9)
    expect(scoreOf({ ...perfect, ptBr: false })).toBe(9)
  })

  it('caps the score at 6 when anything is invented', () => {
    expect(INVENTION_CAP).toBe(6)
    expect(scoreOf({ ...perfect, inventions: 1 })).toBe(6)
    expect(scoreOf({ ...perfect, inventions: 1, found: 2 })).toBeLessThan(6)
  })

  it('does not reward more items than the test asks for', () => {
    expect(scoreOf({ ...perfect, found: 11 })).toBe(10)
  })

  it('gives 9 at a word error rate of 10%, so that is the bar of transcription', () => {
    expect(werScore(0.1)).toBe(9)
    expect(werScore(0)).toBe(10)
    expect(werScore(2)).toBe(0)
    expect(requirementOf('transcricao').minScore).toBe(9)
  })

  it('repeats a test once when within one point of the minimum', () => {
    expect(RETEST_MARGIN).toBe(1)
  })

  it('knows the marks of European Portuguese', () => {
    expect(PT_PT_MARKS).toEqual(expect.arrayContaining(['facto', 'equipa', 'utilizador']))
  })
})
