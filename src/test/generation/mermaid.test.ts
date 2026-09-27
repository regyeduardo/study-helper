import { describe, expect, it } from 'vitest'
import { DIAGRAM_TYPES, DiagramError, extractJson, generateDiagram } from '@/lib/generation/mermaid'

describe('extractJson', () => {
  it('reads plain JSON', () => {
    expect(extractJson('{"a":1}')).toEqual({ a: 1 })
  })

  it('reads JSON inside a markdown fence', () => {
    expect(extractJson('```json\n{"a":{"b":[1,2]}}\n```')).toEqual({ a: { b: [1, 2] } })
  })

  it('reads the first balanced object surrounded by prose', () => {
    expect(extractJson('Claro! Aqui está: {"x":{"y":2}} e mais {"z":3}')).toEqual({ x: { y: 2 } })
  })

  it('returns null without an object or with broken JSON', () => {
    expect(extractJson('nada aqui')).toBeNull()
    expect(extractJson('{"a":}')).toBeNull()
    expect(extractJson('{"a":1')).toBeNull()
  })
})

describe('generateDiagram', () => {
  it('supports exactly the seven diagram types', () => {
    expect([...DIAGRAM_TYPES]).toEqual(['flowchart', 'sequence', 'class', 'state', 'pie', 'gantt', 'mindmap'])
  })

  it('builds a flowchart with shapes, link styles, labels and prefixed subgraphs', () => {
    const code = generateDiagram('flowchart', {
      direction: 'LR',
      nodes: [
        { id: 'A', text: 'Início (fase "1")', shape: 'stadium' },
        { id: 'B', text: 'Decide?', shape: 'diam' },
        { id: 'C' },
      ],
      links: [
        { from: 'A', to: 'B', text: 'vai (sempre)' },
        { from: 'B', to: 'C', shape: 'dotted' },
        { from: 'A', to: 'C', head: 'none' },
      ],
      subgraphs: [{ id: 'S', title: 'Grupo', nodes: [{ id: 'x', text: 'X' }], links: [{ from: 'x', to: 'x' }] }],
    })
    expect(code.split('\n')).toEqual([
      'flowchart LR',
      `A(["Início  fase '1'"])`,
      'B{"Decide?"}',
      'C["C"]',
      'A -->|vai  sempre| B',
      'B -.-> C',
      'A --- C',
      'subgraph S[Grupo]',
      'S_x["X"]',
      'S_x --> S_x',
      'end',
    ])
  })

  it('falls back to TD for an invalid direction', () => {
    expect(generateDiagram('flowchart', { direction: 'XX', nodes: [{ id: 'a' }] }).startsWith('flowchart TD')).toBe(true)
  })

  it('never lets parentheses or double quotes leak into labels', () => {
    const code = generateDiagram('flowchart', { nodes: [{ id: 'n', text: 'f(x) = "y"' }] })
    const label = /\["(.*)"\]/.exec(code)?.[1] ?? ''
    expect(label).not.toMatch(/[()"]/)
  })

  it('builds a sequence diagram', () => {
    expect(
      generateDiagram('sequence', {
        autonumber: true,
        actors: [{ id: 'U', name: 'Usuário', type: 'actor' }, { id: 'S' }],
        messages: [
          { from: 'U', to: 'S', text: 'pede', type: 'solid' },
          { from: 'S', to: 'U', text: 'responde', type: 'dashed' },
        ],
      }),
    ).toBe(['sequenceDiagram', '    autonumber', '    actor U as Usuário', '    participant S', '    U->>S: pede', '    S-->>U: responde'].join('\n'))
  })

  it('builds a class diagram', () => {
    const code = generateDiagram('class', {
      classes: [
        { name: 'Animal', members: [{ name: 'nome', type: 'String' }], methods: [{ name: 'falar', parameters: [{ name: 'alto', type: 'bool' }], return_type: 'void', visibility: '-' }] },
        { name: 'Cão' },
      ],
      relations: [{ from: 'Cão', to: 'Animal', type: 'inheritance', label: 'é um' }],
    })
    expect(code).toContain('classDiagram\ndirection TB')
    expect(code).toContain('class Animal {\n    +String nome\n    -falar(bool alto) void\n}')
    expect(code).toContain('class Cão')
    expect(code).toContain('Cão --|> Animal : é um')
  })

  it('builds a state diagram and skips transitions to unknown states', () => {
    expect(
      generateDiagram('state', {
        states: [{ id: 'Aberto', description: 'porta aberta' }, { id: 'Fechado' }],
        transitions: [
          { from: 'Aberto', to: 'Fechado', description: 'fecha' },
          { from: 'Aberto', to: 'Sumiu' },
        ],
      }),
    ).toBe(['stateDiagram-v2', '    Aberto : porta aberta', '    Fechado', '    Aberto --> Fechado : fecha'].join('\n'))
  })

  it('builds a pie chart and rejects non-numeric values', () => {
    expect(generateDiagram('pie', { title: 'Uso', data: [{ label: 'A', value: 60 }, { label: 'B', value: 40 }] })).toBe('pie title Uso\n    "A" : 60\n    "B" : 40')
    expect(() => generateDiagram('pie', { data: [{ label: 'A', value: '60' }] })).toThrow(DiagramError)
  })

  it('builds a gantt chart', () => {
    const code = generateDiagram('gantt', {
      title: 'Plano',
      sections: [{ name: 'Fase 1', tasks: [{ desc: 'Estudo', status: 'done', id: 't1', start: '2024-01-01', end: '3d' }, { desc: 'Prova', start: 'after t1' }] }],
    })
    expect(code.split('\n')).toEqual(['gantt', '    title Plano', '    dateFormat YYYY-MM-DD', '    section Fase 1', '    Estudo : done, t1, 2024-01-01, 3d', '    Prova : after t1, 1d'])
  })

  it('builds a mindmap with tab indentation', () => {
    expect(generateDiagram('mindmap', { root: 'POO', nodes: [{ text: 'Classe', level: 1 }, { text: 'Objeto', level: 2 }] })).toBe('mindmap\n\troot((POO))\n\t\tClasse\n\t\t\tObjeto')
  })

  it('rejects invalid payloads with DiagramError', () => {
    expect(() => generateDiagram('radar', {})).toThrow(DiagramError)
    expect(() => generateDiagram('flowchart', [])).toThrow(DiagramError)
    expect(() => generateDiagram('flowchart', { nodes: [] })).toThrow(DiagramError)
    expect(() => generateDiagram('flowchart', { nodes: [{ text: 'sem id' }] })).toThrow(DiagramError)
    expect(() => generateDiagram('sequence', { actors: [] })).toThrow(DiagramError)
    expect(() => generateDiagram('class', { classes: [{}] })).toThrow(DiagramError)
    expect(() => generateDiagram('state', { states: [] })).toThrow(DiagramError)
    expect(() => generateDiagram('gantt', { sections: [] })).toThrow(DiagramError)
    expect(() => generateDiagram('mindmap', { root: '' })).toThrow(DiagramError)
    expect(() => generateDiagram('mindmap', { root: 'r', nodes: [{ text: 'x', level: 0 }] })).toThrow(DiagramError)
  })

  it('accepts the type case-insensitively', () => {
    expect(generateDiagram('PIE', { data: [{ label: 'a', value: 1 }] })).toContain('pie')
  })
})
