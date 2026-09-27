import { afterEach, describe, expect, it, vi } from 'vitest'
import { newFileMeta, newFolderMeta } from '@/lib/defaults'
import { analyzeCourse, readAnalysis, sliceMaterial } from '@/lib/generation/course'
import { courseLessonInput, courseOf, explanationName, lineageOf, selectionInput, selectionTitle } from '@/lib/generation/course-lesson'
import { buildMinutes, minutesFileName, renderMinutes } from '@/lib/generation/minutes'
import { PROMPTS } from '@/lib/generation/prompts.data'
import { GenerationSession } from '@/lib/generation/session'
import { installFetch, llm7Settings, openAiStream, systemPromptOf, userContentOf } from '@/test/ai/fake-provider'

const MATERIAL = 'Módulo 1 Introdução ao tema aula um fala de A. Aula dois fala de B. Módulo 2 Avançado aula três fala de C.'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('course detection', () => {
  it('slices material between start and end markers', () => {
    expect(sliceMaterial(MATERIAL, 'aula um', 'fala de A.')).toBe('aula um fala de A.')
    expect(sliceMaterial(MATERIAL, 'Módulo 2', null)).toBe('Módulo 2 Avançado aula três fala de C.')
    expect(sliceMaterial(MATERIAL, 'inexistente', 'x')).toBe('')
  })

  it('matches a marker by its leading words when the model paraphrases the ending', () => {
    expect(sliceMaterial(MATERIAL, 'Aula dois fala de Bananas', null)).toBe('Aula dois fala de B. Módulo 2 Avançado aula três fala de C.')
  })

  it('builds modules and lessons with excerpts', () => {
    const analysis = readAnalysis(
      {
        is_course: true,
        name: 'Curso X',
        description: 'desc',
        modules: [
          { title: 'Módulo 1', covers: 'base', start: 'Módulo 1', end: 'Módulo 2', lessons: [{ title: 'Aula 1', covers: 'A', start: 'aula um', end: 'fala de A.' }, { title: 'Aula 2', start: 'Aula dois', end: 'fala de B.' }, { title: '' }] },
          { title: 'Módulo 2', start: 'Módulo 2' },
          { title: '' },
        ],
      },
      MATERIAL,
    )
    expect(analysis.isCourse).toBe(true)
    expect(analysis.name).toBe('Curso X')
    expect(analysis.modules.map(module => module.title)).toEqual(['Módulo 1', 'Módulo 2'])
    expect(analysis.modules[0].lessons.map(lesson => lesson.title)).toEqual(['Aula 1', 'Aula 2'])
    expect(analysis.modules[0].lessons[0].excerpt).toBe('aula um fala de A.')
    expect(analysis.modules[0].excerpt.startsWith('Módulo 1')).toBe(true)
    expect(analysis.lessonCount).toBe(3)
  })

  it('is not a course without modules', () => {
    expect(readAnalysis({ is_course: true, modules: [] }, MATERIAL)).toMatchObject({ isCourse: false, modules: [], lessonCount: 0 })
  })

  it('asks the provider with the course analysis prompt', async () => {
    const { calls } = installFetch(() => openAiStream(JSON.stringify({ is_course: true, name: 'C', modules: [{ title: 'M', lessons: [{ title: 'L' }] }] })))
    const analysis = await analyzeCourse(MATERIAL, new GenerationSession(llm7Settings()))
    expect(systemPromptOf(calls[0])).toBe(PROMPTS.COURSE_ANALYSIS_PROMPT)
    expect(userContentOf(calls[0])).toBe(MATERIAL)
    expect(analysis).toMatchObject({ isCourse: true, name: 'C', lessonCount: 1 })
  })

  it('treats a non-JSON reply as a single lesson', async () => {
    installFetch(() => openAiStream('não sei'))
    expect((await analyzeCourse(MATERIAL, new GenerationSession(llm7Settings()))).isCourse).toBe(false)
  })
})

describe('course lessons', () => {
  const course = newFolderMeta({ name: 'Curso X', isCourse: true, courseDescription: 'Sobre X', courseMaterial: 'material inteiro' })
  const module = newFolderMeta({ name: 'Módulo 1', parentId: course.id })
  const lessonOne = newFileMeta({ name: 'Aula 1', type: 'class', folderId: module.id, description: 'cobre A', pendingExcerpt: 'trecho A', position: 0 })
  const lessonTwo = newFileMeta({ name: 'Aula 2', type: 'class', folderId: module.id, position: 1 })

  it('finds the course from a nested folder', () => {
    expect(courseOf([course, module], module.id)?.id).toBe(course.id)
    expect(courseOf([module], module.id)).toBeNull()
  })

  it('builds lesson input with course context, outline and excerpt', () => {
    const input = courseLessonInput(lessonOne, [course, module], [lessonOne, lessonTwo])
    expect(input).toContain('# Aula 1')
    expect(input).toContain('Esta aula precisa cobrir: cobre A')
    expect(input).toContain('Curso: Curso X')
    expect(input).toContain('Sobre X')
    expect(input).toContain('Estrutura do curso:\n- Módulo 1\n  - Aula 1\n  - Aula 2')
    expect(input).toContain('## Material desta aula\ntrecho A')
  })

  it('falls back to the course material when the lesson has no excerpt', () => {
    expect(courseLessonInput(lessonTwo, [course, module], [lessonOne, lessonTwo])).toContain('## Material desta aula\nmaterial inteiro')
  })

  it('tracks lineage and builds selection inputs', () => {
    const root = newFileMeta({ name: 'Raiz', type: 'class' })
    const child = newFileMeta({ name: 'Filho', type: 'explanation', parentFileId: root.id })
    expect(lineageOf(child, [root, child]).map(file => file.name)).toEqual(['Raiz'])
    expect(selectionInput(child, 'conteúdo', [root, child], 'trecho', '', 'context')).toContain('Documento de origem: Filho\nVeio de: Raiz')
    expect(selectionInput(child, 'c', [], 'trecho', '', 'concept')).toContain('Explique o conceito')
    expect(selectionTitle('a'.repeat(80))).toBe(`${'a'.repeat(57)}...`)
    expect(explanationName('texto\n## Título bom\n', 'x')).toBe('Título bom')
  })
})

describe('minutes', () => {
  const verified = {
    assunto: 'Planejamento',
    resumo: 'Reunião curta.',
    itens: [
      { tipo: 'decisao', texto: 'Lançar em maio', citacao: '"vamos lançar em maio"' },
      { tipo: 'decisao', texto: 'Descartada', veredito: 'descarta' },
      { tipo: 'encaminhamento', texto: 'Enviar proposta', quem: 'Ana', quando: 'sexta', citacao: 'eu mando | até sexta' },
      { tipo: 'encaminhamento', texto: 'Revisar' },
      { tipo: 'pendencia', texto: 'Orçamento' },
      { tipo: 'confirmar', texto: 'Data da feira', citacao: 'acho que é dia 3' },
      { tipo: 'contexto', texto: 'Cliente novo' },
    ],
  }

  it('renders the minutes sections', () => {
    expect(renderMinutes(verified)).toBe(
      [
        '# Planejamento',
        '',
        '## Resumo',
        'Reunião curta.',
        '',
        '## Decisões',
        '- Lançar em maio\n  > "vamos lançar em maio"',
        '',
        '## Encaminhamentos',
        '| O que fazer | Quem | Quando | Frase que sustenta |',
        '|---|---|---|---|',
        '| Enviar proposta | Ana | sexta | eu mando / até sexta |',
        '| Revisar | sem dono | sem prazo |  |',
        '',
        '## Em aberto',
        '- Orçamento',
        '',
        '## A confirmar',
        '- Data da feira\n  > "acho que é dia 3"',
        '',
        '## Contexto',
        '- Cliente novo',
      ].join('\n') + '\n',
    )
  })

  it('names the file by date and subject', () => {
    expect(minutesFileName('Planejamento', new Date(2024, 0, 5, 9, 7))).toBe('2024-01-05 09-07 - Planejamento')
    expect(minutesFileName('  ', new Date(2024, 0, 5, 9, 7))).toBe('2024-01-05 09-07 - Reunião')
  })

  it('extracts per chunk with overlap and verifies once', async () => {
    const transcript = 'a'.repeat(12000) + 'b'.repeat(5000)
    const { calls } = installFetch(request => {
      const system = systemPromptOf(request)
      if (system === PROMPTS.MINUTES_EXTRACT_PROMPT) return openAiStream(JSON.stringify({ itens: [{ tipo: 'decisao', texto: `d${userContentOf(request).length}` }, 'lixo'] }))
      if (system === PROMPTS.MINUTES_VERIFY_PROMPT) return openAiStream(JSON.stringify({ ...verified, itens: JSON.parse(userContentOf(request)).itens }))
      return new Response('x', { status: 500 })
    })
    const events: string[] = []
    const { markdown, subject } = await buildMinutes(transcript, new GenerationSession(llm7Settings()), event => events.push(event.type))
    const extract = calls.filter(call => systemPromptOf(call) === PROMPTS.MINUTES_EXTRACT_PROMPT)
    expect(extract.map(call => userContentOf(call).length)).toEqual([12000, 5800])
    expect(calls.filter(call => systemPromptOf(call) === PROMPTS.MINUTES_VERIFY_PROMPT)).toHaveLength(1)
    expect(subject).toBe('Planejamento')
    expect(markdown).toContain('## Decisões\n- d12000\n- d5800')
    expect(events).toEqual(['phase1_complete', 'lesson_complete'])
  })

  it('uses the extracted candidates when verification returns no JSON', async () => {
    installFetch(request => (systemPromptOf(request) === PROMPTS.MINUTES_EXTRACT_PROMPT ? openAiStream(JSON.stringify({ itens: [{ tipo: 'pendencia', texto: 'algo' }] })) : openAiStream('sem json')))
    const { markdown, subject } = await buildMinutes('fala curta', new GenerationSession(llm7Settings()))
    expect(subject).toBe('Reunião')
    expect(markdown).toBe('# Reunião\n\n## Em aberto\n- algo\n')
  })
})
