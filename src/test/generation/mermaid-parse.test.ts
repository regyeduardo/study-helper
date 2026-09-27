import { beforeAll, describe, expect, it } from 'vitest'
import mermaid from 'mermaid'

import { generateDiagram } from '@/lib/generation/mermaid'

const SAMPLES: [string, unknown][] = [
  ['flowchart', { direction: 'LR', nodes: [{ id: 'A', text: 'Início (fase "1")', shape: 'stadium' }, { id: 'B', text: 'Decide?', shape: 'diam' }, { id: 'C', shape: 'hex' }, { id: 'D', shape: 'cyl' }, { id: 'E', shape: 'circle' }, { id: 'F', shape: 'parallelogram' }, { id: 'G', shape: 'rounded' }], links: [{ from: 'A', to: 'B', text: 'vai (sempre)' }, { from: 'B', to: 'C', shape: 'dotted' }, { from: 'C', to: 'D', shape: 'thick', text: 'forte' }, { from: 'D', to: 'E', shape: 'invisible', text: 'x' }, { from: 'A', to: 'C', head: 'none' }], subgraphs: [{ id: 'S', title: 'Grupo (1)', nodes: [{ id: 'x', text: 'X' }, { id: 'y', text: 'Y' }], links: [{ from: 'x', to: 'y' }], children: [{ id: 'T', nodes: [{ id: 'z' }] }] }] }],
  ['sequence', { autonumber: true, actors: [{ id: 'U', name: 'Usuário (web)', type: 'actor' }, { id: 'S', name: 'Servidor' }], messages: [{ from: 'U', to: 'S', text: 'pede "dados"', type: 'solid' }, { from: 'S', to: 'U', text: 'responde', type: 'dashed' }, { from: 'U', to: 'S', text: 'falha', type: 'dotted' }, { from: 'U', to: 'S', text: 'async', type: 'async' }] }],
  ['class', { direction: 'LR', classes: [{ name: 'Animal', members: [{ name: 'nome', type: 'String' }], methods: [{ name: 'falar', parameters: [{ name: 'alto', type: 'bool' }], return_type: 'void', visibility: '-' }] }, { name: 'Dog' }, { name: 'Tail' }], relations: [{ from: 'Dog', to: 'Animal', type: 'inheritance', label: 'is a' }, { from: 'Dog', to: 'Tail', type: 'composition' }, { from: 'Animal', to: 'Tail', type: 'aggregation' }] }],
  ['state', { states: [{ id: 'Aberto', description: 'porta (aberta)' }, { id: 'Fechado' }], transitions: [{ from: 'Aberto', to: 'Fechado', description: 'fecha' }, { from: 'Fechado', to: 'Aberto' }] }],
  ['pie', { title: 'Uso (%)', data: [{ label: 'A "x"', value: 60 }, { label: 'B', value: 40.5 }] }],
  ['gantt', { title: 'Plano', sections: [{ name: 'Fase 1', tasks: [{ desc: 'Estudo', status: 'done', id: 't1', start: '2024-01-01', end: '3d' }, { desc: 'Prova', status: 'crit', start: 'after t1' }] }] }],
  ['mindmap', { root: 'POO (Java)', nodes: [{ text: 'Classe', level: 1 }, { text: 'Objeto', level: 2 }, { text: 'Herança', level: 1 }] }],
]

beforeAll(() => {
  mermaid.initialize({ startOnLoad: false })
})

describe('generated diagrams are valid Mermaid', () => {
  it.each(SAMPLES)('%s parses with the mermaid parser', async (type, data) => {
    const code = generateDiagram(type, data)
    await expect(mermaid.parse(code)).resolves.toBeTruthy()
  })
})
