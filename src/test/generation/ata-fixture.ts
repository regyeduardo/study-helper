// Simulated AI for the Ata pipeline: one answer per pass, chosen by the system prompt / vision prompt.
import type { AtaAi, TextPass } from '@/lib/generation/ata-ai'
import * as P from '@/lib/generation/ata-prompts'
import type { Box, FrameSource, Shot } from '@/lib/generation/ata-types'
import { TILES_PROMPT, WHO_PROMPT } from '@/lib/generation/speakers-from-tiles'
import type { RecordingData } from '@/types/domain'

export const meeting: RecordingData = {
  blocks: [
    { speaker: 'mic', start: 10, end: 20, text: 'Boa tarde, vamos ver a tabela de vendas.' },
    { speaker: 'speaker_0', start: 30, end: 45, text: 'Natália, ajusta a Tabela de Vendas até amanhã, alinha os campos pelo topo.' },
    { speaker: 'speaker_1', start: 60, end: 75, text: 'Deixa comigo, eu ajusto amanhã.' },
    { speaker: 'mic', start: 100, end: 110, text: 'E o BGV corrigido entra quando?' },
    { speaker: 'speaker_0', start: 200, end: 210, text: 'O BGV corrigido fica para sexta, alguém precisa ver o ano 2030.' },
    { speaker: 'speaker_1', start: 220, end: 230, text: 'Tá, mas o ano 2030 ninguém decidiu.' },
    { speaker: 'mic', start: 300, end: 310, text: 'Fechado então, tchau.' },
  ],
  speakers: [
    { id: 'mic', name: 'Você', suggested: false },
    { id: 'speaker_0', name: 'Falante 1', suggested: false },
    { id: 'speaker_1', name: 'Falante 2', suggested: false },
  ],
  marks: [],
}

const json = (value: unknown) => JSON.stringify(value)

/** Who has the lit tile at each second (the mic voice's tile never lights, like in the real call). */
function litTile(at: number): string {
  const block = meeting.blocks.find(item => item.start <= at && at <= item.end)
  if (block?.speaker === 'speaker_0') return 'Henrique Souza'
  if (block?.speaker === 'speaker_1') return 'Natália Lenza'
  return 'Natália Lenza'
}

export function textAnswer(system: string, user: string): string {
  if (system === P.ENTENDER)
    return json({
      assunto: 'Tabela de Vendas (HM)',
      contexto: 'Henrique Souza cobra ajustes na Tabela de Vendas.',
      pessoas: [
        { nome: 'Henrique Souza', papel: 'cobra a equipe', participou: true },
        { nome: 'Natália Lenza', papel: 'faz o sistema', participou: true },
        { nome: 'Regy Niles', papel: 'gravou', participou: true },
      ],
      cartoes: [{ numero: '#009', titulo: 'Versão Duque de Caxias', responsaveis: ['Regy Niles'], prazo: '30/10/2026', momento: '03:00' }],
      glossario: [{ termo: 'VGV', ouvido_como: ['BGV'], significado: 'Valor Geral de Vendas.' }],
    })
  if (system === P.CANDIDATAS)
    return json({
      tarefas: [
        { o_que: 'Ajustar a Tabela de Vendas', citacao: 'ajusta a Tabela de Vendas até amanhã', minuto: '00:30', dono: 'Natália Lenza', situacao: 'aceita', tela: 'Tabela de Vendas', pedida_por: 'Henrique Souza' },
        { o_que: 'Fazer a Versão Duque de Caxias (cartão #009)', citacao: 'Versão Duque de Caxias', minuto: '03:00', dono: 'Regy Niles', situacao: 'pedida', tela: 'cartão #009' },
      ],
    })
  if (system === P.JUNTAR)
    return json({
      tarefas: [
        { titulo: 'Ajustar a Tabela de Vendas', candidatas: ['c1'], momentos: ['00:30'] },
        { titulo: 'Fazer a Versão Duque de Caxias', candidatas: ['c2'], momentos: ['03:00'] },
      ],
      sem_dono: [{ assunto: 'Ano 2030', candidatas: [], momentos: ['03:40'] }],
      descartadas: [],
    })
  if (system === P.REVISAR)
    return json({
      decisoes: [
        { n: 1, decisao: 'fica' },
        { n: 2, decisao: 'fica' },
      ],
    })
  if (system === P.VERIFICAR)
    return json({
      manter: true,
      titulo: 'Ajustar a Tabela de Vendas (card #007)',
      dono: 'Natália Lenza',
      prazo: '29/10/2026',
      situacao: 'aceita',
      situacao_detalhe: 'Natália: "Deixa comigo"',
      prova_fala: { minuto: '00:30', quem: 'Henrique Souza', citacao: 'ajusta a Tabela de Vendas até amanhã' },
      aceite: { minuto: '01:00', quem: 'Natália Lenza', citacao: 'Deixa comigo, eu ajusto amanhã.' },
      base: [
        { minuto: '00:30', quem: 'Henrique Souza', citacao: 'ajusta a Tabela de Vendas até amanhã' },
        { minuto: '01:00', quem: 'Natália Lenza', citacao: 'Deixa comigo, eu ajusto amanhã.' },
      ],
      prints: [{ minuto: '00:40', marcar: 'campo Valor ticket médio', legenda: 'Campos a alinhar' }],
    })
  if (system === P.ESCREVER_TAREFA)
    return '**Dono:** Natália Lenza · **Prazo:** 29/10/2026 · **Situação:** aceita (Natália: "Deixa comigo")\n\n**Por quê:** o card vence amanhã.\n\n**Base:** [▸ 00:30] "ajusta a Tabela de Vendas até amanhã" · [▸ 01:00] Natália Lenza: "Deixa comigo"'
  if (system === P.PENDENCIAS)
    return json({
      divergencias: [{ tela: 'Curva', igual_a_tarefa: 0, assunto: 'Ano 2030', texto: 'Ninguém decidiu o ano 2030.', base: [{ minuto: '03:40', quem: 'Natália Lenza', citacao: 'o ano 2030 ninguém decidiu' }] }],
      vai_ter: [{ igual_a_tarefa: 1, assunto: 'Repete a tarefa 1', base: [{ minuto: '00:30', citacao: 'ajusta a Tabela de Vendas' }] }],
      cobrancas_de_fora: [{ igual_a_tarefa: 0, assunto: 'Inventada', base: [{ minuto: '02:00', citacao: 'isso ninguém falou na reunião' }] }],
      perguntas_abertas: [],
    })
  if (system === P.ESCREVER_GERAL)
    return json({
      titulo: 'Tabela de Vendas (HM)',
      contexto: ['Reunião de 28/10/2026, 18:15, sobre o sistema HM.', 'Henrique Souza cobrou a Tabela de Vendas.'],
      sem_dono: [{ assunto: 'Ano 2030', texto: 'Ninguém decidiu o ano 2030.', base: [{ minuto: '03:40', citacao: 'o ano 2030 ninguém decidiu' }] }],
      glossario: [{ termo: 'VGV', significado: 'Valor Geral de Vendas. A transcrição escreve BGV.' }],
    })
  if (system.startsWith(P.BASE) && system.endsWith(P.RESUMO))
    return '# Tabela de Vendas e VGV\n\n## Em poucas linhas\nHenrique Souza pediu o ajuste da Tabela de Vendas e Natália Lenza assumiu. [▸ 00:30] [▸ 01:00]\n\n{{print 00:40 | campo Valor ticket médio}}\n\n## Pontos principais\n- O VGV corrigido fica para sexta. [▸ 03:20]'
  if (system.startsWith(P.BASE) && system.endsWith(P.PERGUNTAS)) return '# Perguntas\n\n## Perguntas sem resposta\n- Regy Niles perguntou quando entra o VGV corrigido. [▸ 01:40]'
  if (system.startsWith(P.BASE) && system.endsWith(P.LINHA_DO_TEMPO)) return '# Linha\n\n### 00:30 · Tabela de Vendas\nHenrique Souza pede o ajuste. [▸ 00:30]'
  if (system.startsWith(P.BASE) && system.endsWith(P.UM_A_UM)) return '# 1:1\n\nNão foi um 1:1.\n\n## Combinados\n- Natália Lenza ajusta a tabela. [▸ 01:00]'
  return `inesperado: ${system.slice(0, 40)} ${user.slice(0, 10)}`
}

export function visionAnswer(image: string, prompt: string): string {
  const at = Number(/-(\d+(?:\.\d+)?)$/.exec(image)?.[1] ?? 0)
  if (prompt === WHO_PROMPT) return json({ falando: litTile(at), pista: 'ondinha acesa' })
  if (prompt === TILES_PROMPT) return json({ quadros: ['Henrique Souza', 'Natália Lenza', 'Regy Niles'] })
  if (prompt === P.AREA) return json({ caixa: [200, 250, 700, 900] })
  if (prompt === P.LER_TELA) return json({ programa: 'HM', tela: 'Tabela de Vendas', campos: [{ rotulo: 'Valor ticket médio', valor: '288.837,14' }], resumo: 'Tabela de Vendas aberta' })
  if (prompt.startsWith('Recorte da tela compartilhada no minuto')) return json({ tela: 'Tabela de Vendas', relacionados: [] })
  if (prompt.startsWith('Recorte da tela compartilhada numa reunião. Marque')) return json({ achou: true, itens: [{ rotulo: 'Valor ticket médio', caixa: [100, 100, 300, 200] }] })
  return '{}'
}

export interface FakeAi extends AtaAi {
  calls: { pass: TextPass | 'vision'; system: string; user: string }[]
}

export function fakeAi(options: { vision?: boolean; text?: (system: string, user: string) => Promise<string> | string } = {}): FakeAi {
  const calls: FakeAi['calls'] = []
  return {
    calls,
    hasVision: options.vision ?? true,
    async text(pass, system, user) {
      calls.push({ pass, system, user })
      return options.text ? options.text(system, user) : textAnswer(system, user)
    },
    async see(images, prompt) {
      calls.push({ pass: 'vision', system: prompt, user: images.join(',') })
      return visionAnswer(images[0], prompt)
    },
    models: () => ({ write: 'fake' }),
    costUsd: () => undefined,
  }
}

export function fakeFrames(): FrameSource & { crops: Box[] } {
  const crops: Box[] = []
  const shot = (kind: string, at: number): Shot => ({ at, image: `data:image/jpeg;base64,${kind}-${at}`, width: 1280, height: 720, signature: new Array(1728).fill(Math.floor(at / 60) * 10) })
  return {
    crops,
    width: 1920,
    height: 1080,
    duration: 320,
    full: async at => shot('full', at),
    crop: async (at, box) => (crops.push(box), shot('crop', at)),
  }
}
