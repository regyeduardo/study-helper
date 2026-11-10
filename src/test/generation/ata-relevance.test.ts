// T097 (FR-057 a FR-061, FR-063): the Ata follows the approved method (~/Downloads/atas-09-11/metodo.md).
// Fake AI only: no paid call, no key from .env.
import { describe, expect, it } from 'vitest'

import { ATA_MODELS, buildAta } from '@/lib/generation/ata'
import * as P from '@/lib/generation/ata-prompts'
import { meetingMaterial } from '@/lib/generation/meeting-material'
import { PROMPTS } from '@/lib/generation/prompts.data'
import { fakeAi } from '@/test/generation/ata-fixture'
import type { AtaModelId, AtaPart, RecordingData } from '@/types/domain'

const startedAt = new Date(2026, 9, 27, 9, 0)
const audioOnly = { frames: null, difference: () => 0, renderPrint: async () => '' }

/** A fictional meeting: a task proposed and then dropped, topics of mixed weight, a request nobody took. */
const reuniao: RecordingData = {
  blocks: [
    { speaker: 'mic', start: 5, end: 12, text: 'Bom dia. Choveu muito aí ontem? Aqui alagou a rua toda.' },
    { speaker: 'speaker_0', start: 15, end: 30, text: 'Choveu. Bom, eu vou fazer um site para cada loja até sexta.' },
    { speaker: 'mic', start: 40, end: 55, text: 'O botão de exportar está meio apagado na tela, mas tudo bem.' },
    { speaker: 'speaker_1', start: 60, end: 80, text: 'O contrato da Padaria Sol sobe para 12 mil por mês e a entrega passa para 20 de dezembro.' },
    { speaker: 'speaker_0', start: 120, end: 140, text: 'Pensando melhor, esquece um site por loja: fica um site só para as três lojas.' },
    { speaker: 'speaker_1', start: 150, end: 165, text: 'Combinado. Eu mando o contrato novo assinado até quinta.' },
    { speaker: 'mic', start: 170, end: 180, text: 'Alguém precisa revisar o logo antes da entrega.' },
    { speaker: 'speaker_0', start: 185, end: 190, text: 'Fechado, tchau.' },
  ],
  speakers: [
    { id: 'mic', name: 'Regy Niles', suggested: false },
    { id: 'speaker_0', name: 'Bruna Leal', suggested: false },
    { id: 'speaker_1', name: 'Caio Prado', suggested: false },
  ],
  marks: [],
}

const json = (value: unknown) => JSON.stringify(value)

const CONTRATO = { minuto: '02:30', quem: 'Caio Prado', citacao: 'Eu mando o contrato novo assinado até quinta' }
const LOGO = { minuto: '02:50', quem: 'Regy Niles', citacao: 'Alguém precisa revisar o logo antes da entrega' }

/** What a model that follows the method answers, pass by pass. */
function answer(system: string, user: string): string {
  if (system === P.ESTADO_FINAL)
    return json({
      assuntos: [{ assunto: 'Site das lojas', importancia: '1', estado_final: 'um site só para as três lojas', descartado: [{ era: 'Um site para cada loja', ficou: 'um site só para as três lojas', minutos: ['00:15', '02:00'] }] }],
      prazos: [{ o_que: 'Fazer um site para cada loja', prazo_dito: 'sexta', minuto: '00:15', vale_no_fim: false, mudou: 'esquecido em 02:00' }],
      compromissos: [{ quem: 'Caio Prado', o_que: 'Mandar o contrato novo assinado', prazo: 'quinta', minuto: '02:30', vale_no_fim: true }],
      pedidos_sem_aceite: [{ o_que: 'Revisar o logo', pedido_por: 'Regy Niles', minuto: '02:50' }],
    })
  if (system === P.ENTENDER) return json({ assunto: 'Site e contrato da Padaria Sol', contexto: 'Bruna Leal, Caio Prado e Regy Niles.', pessoas: [], glossario: [] })
  if (system === P.CANDIDATAS)
    return json({
      tarefas: [
        { o_que: 'Fazer um site para cada loja', dono: 'Bruna Leal', prazo: 'sexta', minuto: '00:15', citacao: 'eu vou fazer um site para cada loja até sexta', situacao: 'aceita' },
        { o_que: 'Desistir do site por loja', minuto: '02:00', citacao: 'esquece um site por loja: fica um site só', situacao: 'revertida', detalhes: 'era um site por loja; ficou um site só para as três lojas' },
        { o_que: 'Mandar o contrato novo assinado', dono: 'Caio Prado', prazo: 'quinta', minuto: '02:30', citacao: CONTRATO.citacao, situacao: 'aceita' },
        { o_que: 'Revisar o logo', dono: '', minuto: '02:50', citacao: LOGO.citacao, situacao: 'pedida' },
      ],
    })
  if (system === P.JUNTAR)
    return json({
      tarefas: [
        { titulo: 'Mandar o contrato novo assinado', candidatas: ['c3'], momentos: ['02:30'] },
        { titulo: 'Revisar o logo antes da entrega', candidatas: ['c4'], momentos: ['02:50'] },
      ],
      revertidas: [{ candidatas: ['c1', 'c2'], era: 'Um site para cada loja', ficou: 'um site só para as três lojas', momentos: ['00:15', '02:00'] }],
      descartadas: [],
    })
  if (system === P.REVISAR)
    return json({
      decisoes: [
        { n: 1, decisao: 'fica', de: 0 },
        { n: 2, decisao: 'fica', de: 0 },
      ],
    })
  if (system === P.VERIFICAR)
    return user.includes('TAREFA A VERIFICAR: 1.')
      ? json({ manter: true, titulo: 'Mandar o contrato novo assinado', dono: 'Caio Prado', prazo: '30/10/2026', situacao: 'aceita', aceite: CONTRATO, prova_fala: CONTRATO, base: [CONTRATO] })
      : json({ manter: true, titulo: 'Revisar o logo antes da entrega', dono: 'sem responsável', prazo: 'sem prazo', situacao: 'pedida', aceite: null, prova_fala: LOGO, base: [LOGO] })
  if (system === P.ESCREVER_TAREFA) return '**Dono:** Caio Prado · **Prazo:** 30/10/2026 · **Situação:** aceita\n\n**Base:** [▸ 02:30] "Eu mando o contrato novo assinado até quinta"'
  if (system === P.ESCREVER_GERAL) return json({ titulo: 'Site único e contrato da Padaria Sol', contexto: ['Reunião de 27/10/2026.'], glossario: [] })
  if (system === P.PENDENCIAS) return json({ divergencias: [], vai_ter: [], cobrancas_de_fora: [], perguntas_abertas: [] })
  if (system.startsWith(P.BASE)) return '# Contrato da Padaria Sol\n\n## Pontos principais\n- O contrato sobe para 12 mil por mês. [▸ 01:00]'
  if (system.startsWith(P.ABERTURA_MODELO))
    return [
      '# Ata: Site único e contrato da Padaria Sol',
      '',
      '## Conclusões (Key Takeaways)',
      '',
      '- **O contrato da Padaria Sol sobe para R$ 12 mil por mês e a entrega passa para 20/12.** [01:00]',
      '',
      '### Descartado na reunião',
      '',
      '- Um site para cada loja → um site só para as três lojas. [00:15] → [02:00]',
      '',
      '## Próximos passos (Next Steps)',
      '',
      '1. **Mandar o contrato novo assinado**',
      '   - **Caio Prado** · até qui 30/10 · [▸ 02:30]',
    ].join('\n')
  return `inesperado: ${system.slice(0, 40)}`
}

const ai = () => fakeAi({ vision: false, text: answer })

describe('the approved method in the prompt of the Ata', () => {
  it('the method has its rules and no fact of any real meeting', () => {
    for (const rule of [
      'Vale o estado final',
      'Descartado na reunião',
      'Pedido sem aceite não é tarefa',
      'o quê, quem, até quando e o minuto',
      '"sem responsável"',
      '"sem prazo"',
      'Recuo de prazo é decisão',
      'escopo, prazo, dinheiro ou responsável',
      'bloqueios e dependências',
      '"não ficou claro"',
      'Nunca invente',
      '"(você)"',
      'menos de 3 minutos',
    ])
      expect(P.METODO, rule).toContain(rule)
    expect(P.METODO).not.toMatch(/Samila|Regy|Prolinx|Consultar|VP6|Andreia/)
  })

  it.each(Object.keys(ATA_MODELS))('%s: the model is written with the method, keeps its skeleton and has a place for what was dropped', async id => {
    const fake = ai()
    await buildAta({ recording: reuniao, parts: [], model: id as AtaModelId, startedAt }, { ai: fake, ...audioOnly })
    const system = fake.calls.find(call => call.pass === 'write')!.system
    expect(system).toContain(P.METODO)
    const skeleton = system.slice(system.indexOf('Modelo '))
    expect(skeleton).toContain('Descartado na reunião')
    expect(skeleton).toContain('[mm:ss]')
    // the method overrides the old rules of the models: owner, deadline and minute now go with every task
    expect(system).not.toContain('Nunca escreva quem falou')
    expect(system).not.toContain('na ordem em que apareceram')
    expect(system).not.toContain('Sem nomes nesta versão')
  })

  it('the Resumo of the Padrão is written with the method and has "Em aberto" and "Descartado na reunião"', async () => {
    const fake = ai()
    await buildAta({ recording: reuniao, parts: ['resumo'], startedAt }, { ai: fake, ...audioOnly })
    const system = fake.calls.find(call => call.pass === 'write')!.system
    expect(system).toBe(`${P.BASE}\n\n${P.RESUMO}`)
    expect(P.RESUMO).toContain(P.METODO)
    expect(P.RESUMO).toContain('"## Em aberto"')
    expect(P.RESUMO).toContain('"## Descartado na reunião"')
    // what the internal timeline found dropped is always listed, never left out of the Resumo
    expect(P.RESUMO).toContain('a seção é obrigatória quando o ESTADO FINAL traz algo descartado')
  })

  it('the single-pass Ata (Agente Reunião, still used from the media and to redo a meeting note) has the rules of the method too', () => {
    for (const rule of ['Vale o estado final', 'Descartado na reunião', 'Pedido sem aceite', 'escopo, prazo, dinheiro ou responsável', 'menos de 3 minutos']) expect(PROMPTS.MEETING_PROMPT, rule).toContain(rule)
    expect(PROMPTS.MEETING_PROMPT).not.toContain('Seja exaustivo')
  })

  it('the passes of the Levantamento know what was reverted and order by real importance', () => {
    expect(P.CANDIDATAS).toContain('revertida')
    expect(P.JUNTAR).toContain('"revertidas"')
    expect(P.JUNTAR).toContain('escopo, prazo, dinheiro ou responsável')
    expect(P.JUNTAR).not.toContain('na ordem em que apareceram')
    expect(P.VERIFICAR).toContain('estado final')
    expect(P.VERIFICAR).toContain('"sem responsável"')
  })
})

describe('the internal timeline of the method (metodo.md §1)', () => {
  it('is made once, from the whole meeting, and every writer reads its final state', async () => {
    for (const request of [{ parts: [] as AtaPart[], model: 'fathom' as AtaModelId }, { parts: ['resumo', 'tarefas'] as AtaPart[] }]) {
      const fake = ai()
      await buildAta({ recording: reuniao, startedAt, ...request }, { ai: fake, ...audioOnly })
      const timeline = fake.calls.filter(call => call.system === P.ESTADO_FINAL)
      expect(timeline).toHaveLength(1)
      expect(timeline[0].user).toContain('02:00 | Bruna Leal: Pensando melhor, esquece um site por loja')
      const readers = fake.calls.filter(call => call.system.startsWith(P.ABERTURA_MODELO) || call.system.endsWith(P.RESUMO) || [P.CANDIDATAS, P.JUNTAR, P.VERIFICAR].includes(call.system))
      expect(readers.length).toBeGreaterThan(0)
      for (const call of readers) {
        expect(call.user).toContain('Um site para cada loja → um site só para as três lojas')
        expect(call.user).toContain('Pedidos sem aceite: Revisar o logo')
        // a deadline taken back comes first: it is a decision of its own (metodo.md §2)
        const state = call.user.slice(call.user.indexOf('ESTADO FINAL DA REUNIÃO'))
        expect(state.split('\n')[1]).toBe('Prazos que NÃO valem mais (decisão: vai no topo): Fazer um site para cada loja · sexta · 00:15 (esquecido em 02:00)')
      }
    }
  })

  it('an answer without JSON is asked once more, so a broken timeline does not leave the writers without the final state', async () => {
    let asked = 0
    const flaky = fakeAi({ vision: false, text: (system, user) => (system === P.ESTADO_FINAL && asked++ === 0 ? '{"assuntos": [{"assunto": "Site" "estado_final": quebrado' : answer(system, user)) })
    await buildAta({ recording: reuniao, parts: [], model: 'fathom', startedAt }, { ai: flaky, ...audioOnly })
    expect(flaky.calls.filter(call => call.system === P.ESTADO_FINAL)).toHaveLength(2)
    expect(flaky.calls.find(call => call.pass === 'write')!.user).toContain('Um site para cada loja → um site só para as três lojas')
  })
})

describe('the material the writers read (metodo.md §4)', () => {
  it('a sentence whose label flips word by word is read whole, under the voice that said most of it', () => {
    const quebrada: RecordingData = {
      blocks: [
        { speaker: 'speaker_0', start: 10, end: 12, text: 'Combinado então.' },
        { speaker: 'speaker_0', start: 20, end: 21, text: 'É, eu também acho. Não vai' },
        { speaker: 'mic', start: 21, end: 22, text: 'ser com todos os' },
        { speaker: 'speaker_0', start: 22, end: 22.5, text: 'seus' },
        { speaker: 'mic', start: 22.5, end: 30, text: 'pontos, não. A gente vai entregar outra versão, não vou conseguir fazer isso rápido.' },
        { speaker: 'speaker_0', start: 31, end: 33, text: 'Tá bom.' },
      ],
      speakers: reuniao.speakers,
      marks: [],
    }
    const material = meetingMaterial(quebrada, startedAt, [])
    expect(material.falas.split('\n')).toEqual([
      '00:10 | Bruna Leal: Combinado então.',
      '00:20 | Regy Niles: É, eu também acho. Não vai ser com todos os seus pontos, não. A gente vai entregar outra versão, não vou conseguir fazer isso rápido.',
      '00:31 | Bruna Leal: Tá bom.',
    ])
  })
})

describe('what the Ata keeps', () => {
  it('a model keeps the minute of each task and the "Descartado na reunião" list', async () => {
    const done = await buildAta({ recording: reuniao, parts: [], model: 'fathom', startedAt }, { ai: ai(), ...audioOnly })
    expect(done.markdown).toContain('- Um site para cada loja → um site só para as três lojas. [00:15] → [02:00]')
    expect(done.markdown).toContain('   - **Caio Prado** · até qui 30/10 · [02:30]')
    expect(done.markdown.indexOf('O contrato da Padaria Sol sobe')).toBeLessThan(done.markdown.indexOf('### Descartado na reunião'))
  })

  it('the Levantamento never lists the dropped task: it goes to "Descartado na reunião"; a task without owner goes to "Em aberto", owner and deadline not invented', async () => {
    const done = await buildAta({ recording: reuniao, parts: ['tarefas'], startedAt }, { ai: ai(), ...audioOnly })
    const md = done.markdown
    const lista = md.slice(md.indexOf('### Lista'), md.indexOf('<a id="t1">'))
    // every task: what, who, until when and the minute
    expect(lista).toContain('- [ ] [Mandar o contrato novo assinado](#t1) · Caio Prado · 30/10/2026 · [▸ 02:30](#t=150)')
    expect(lista).not.toMatch(/site/i)
    expect(lista).not.toMatch(/logo/i)
    expect(md).not.toContain('#### 2.')
    const aberto = md.slice(md.indexOf('### Em aberto'))
    expect(aberto).toMatch(/Revisar o logo antes da entrega.*sem responsável.*\[▸ 02:50\]\(#t=170\)/)
    const descartado = md.slice(md.indexOf('### Descartado na reunião'))
    expect(descartado).toContain('- Um site para cada loja → um site só para as três lojas. [▸ 00:15](#t=15) → [▸ 02:00](#t=120)')
    expect(md).not.toContain('a confirmar')
  })
})
