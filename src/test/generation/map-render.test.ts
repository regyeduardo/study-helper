import { beforeAll, describe, expect, it } from 'vitest'
import mermaid from 'mermaid'

import type { MapDiagram, MapForm, MapNode } from '@/types/domain'
import { mapToMermaid } from '@/lib/generation/map-render'

// Mermaid's diagram databases have no public types: read as `any`.
async function parsed(code: string): Promise<any> {
  await expect(mermaid.parse(code)).resolves.toBeTruthy()
  const api = (mermaid as unknown as { mermaidAPI: { getDiagramFromText(text: string): Promise<{ db: any }> } }).mermaidAPI
  return (await api.getDiagramFromText(code)).db
}

/** What the person sees: Mermaid turns the entity codes back into characters when drawing. */
function shown(text: string): string {
  const area = document.createElement('textarea')
  area.innerHTML = text.replace(/ﬂ°°/g, '&#').replace(/ﬂ°/g, '&').replace(/¶ß/g, ';')
  return area.value.trim()
}

function node(id: string, text: string, children: MapNode[] = [], extra: Partial<MapNode> = {}): MapNode {
  return { id, text, children, ...extra }
}

function chain(prefix: string, depth: number): MapNode {
  return node(`${prefix}${depth}`, `Nível ${depth} explica o nível de cima`, depth > 1 ? [chain(prefix, depth - 1)] : [])
}

/** 9 branches, one of them 6 levels deep. */
function wide(): MapNode {
  const branches = Array.from({ length: 9 }, (_, index) => node(`b${index}`, `Ramo ${index} diz algo`))
  branches[0] = chain('d', 6)
  return node('root', 'Importação de colaboradores', branches)
}

function mindNodes(item: any): any[] {
  return [item, ...item.children.flatMap(mindNodes)]
}

const NASTY = 'Chave "única" [filial] (matrícula) {x} | a:b : c # 50% %% <b>negrito</b> `crase` 🎯 ✅\n  linha 2'
const NASTY_SHOWN = NASTY.replace(/\s+/g, ' ')

beforeAll(() => {
  mermaid.initialize({ startOnLoad: false })
})

describe('radial', () => {
  it('draws a mindmap with every node at its depth, past 3 levels and 7 branches', async () => {
    const code = mapToMermaid({ form: 'radial', root: wide() })
    expect(code.startsWith('mindmap\n')).toBe(true)
    const root = (await parsed(code)).getMindmap()
    expect(shown(root.descr)).toBe('Importação de colaboradores')
    expect(root.children).toHaveLength(9)
    expect(mindNodes(root)).toHaveLength(1 + 8 + 6)
    let deepest = root.children[0]
    while (deepest.children.length) deepest = deepest.children[0]
    expect(shown(deepest.descr)).toBe('Nível 1 explica o nível de cima')
  })

  it('puts the mark before the text', async () => {
    const code = mapToMermaid({ form: 'radial', root: node('r', 'Reunião do INCC', [node('a', 'Reajuste fica em 4%', [], { mark: '✅' })]) })
    expect(shown((await parsed(code)).getMindmap().children[0].descr)).toBe('✅ Reajuste fica em 4%')
  })
})

describe('arvore', () => {
  it('draws a left-to-right flowchart tree, one arrow per child', async () => {
    const code = mapToMermaid({ form: 'arvore', root: wide() })
    expect(code.startsWith('flowchart LR\n')).toBe(true)
    const db = await parsed(code)
    expect(db.getVertices().size).toBe(15)
    expect(db.getEdges()).toHaveLength(14)
    expect(db.getSubGraphs()).toHaveLength(0)
  })
})

describe('fluxo', () => {
  const flow: MapDiagram = {
    form: 'fluxo',
    root: node('r', 'Importação da planilha', [
      node('g', 'Validação no RH', [node('v1', 'RH confere as matrículas'), node('g2', 'Correções', [node('c1', 'Matrícula repetida volta para o RH')], { group: true })], { group: true }),
      node('s', 'Sistema grava filial + matrícula como chave única', [], { links: [{ to: 'v1', label: 'só depois de' }, { to: 'sumiu' }] }),
    ]),
  }

  it('draws group nodes as boxes around their children', async () => {
    const db = await parsed(mapToMermaid(flow))
    const boxes = db.getSubGraphs().map((box: any) => [shown(box.title), box.nodes.length])
    expect(boxes).toEqual([
      ['Correções', 1],
      ['Validação no RH', 2],
    ])
  })

  it('draws the tree arrows and the extra links, dropping links to nodes that are gone', async () => {
    const edges = (await parsed(mapToMermaid(flow))).getEdges()
    expect(edges.filter((edge: any) => edge.stroke === 'normal')).toHaveLength(2)
    const extra = edges.filter((edge: any) => edge.stroke === 'dotted')
    expect(extra).toHaveLength(1)
    expect(shown(extra[0].text)).toBe('só depois de')
  })
})

describe('linha-do-tempo', () => {
  it('draws a Mermaid timeline: root is the title, its children the moments, the rest their events', async () => {
    const code = mapToMermaid({
      form: 'linha-do-tempo',
      root: node('r', 'Implantação do ponto', [node('m1', 'Março: piloto na filial 2', [node('e1', 'Ana treina os gestores', [node('e2', 'Gestores aprovam o fluxo')])]), node('m2', 'Abril: todas as filiais')]),
    })
    expect(code.startsWith('timeline\n')).toBe(true)
    const db = await parsed(code)
    expect(shown(db.getCommonDb().getDiagramTitle())).toBe('Implantação do ponto')
    expect(db.getTasks().map((task: any) => [shown(task.task), task.events.map(shown)])).toEqual([
      ['Março: piloto na filial 2', ['Ana treina os gestores', 'Gestores aprovam o fluxo']],
      ['Abril: todas as filiais', []],
    ])
  })

  it('turns groups into sections when every moment is grouped', async () => {
    const code = mapToMermaid({
      form: 'linha-do-tempo',
      root: node('r', 'Projeto', [node('f1', 'Fase 1', [node('m1', 'Janeiro', [node('e1', 'Kickoff com o cliente')])], { group: true }), node('f2', 'Fase 2', [node('m2', 'Fevereiro')], { group: true })]),
    })
    const db = await parsed(code)
    expect(db.getSections().map(shown)).toEqual(['Fase 1', 'Fase 2'])
    expect(db.getTasks().map((task: any) => [shown(task.section), shown(task.task)])).toEqual([
      ['Fase 1', 'Janeiro'],
      ['Fase 2', 'Fevereiro'],
    ])
  })
})

describe('labels', () => {
  const nasty = (form: MapForm): MapDiagram => ({ form, root: node('r', NASTY, [node('a', NASTY, [node('b', NASTY)], { group: true, links: [{ to: 'r', label: NASTY }] }), node('c', 'Title IX entra'), node('d', 'section 2 começa')]) })

  it.each<MapForm>(['radial', 'arvore', 'fluxo', 'linha-do-tempo'])('no text breaks the %s syntax and the person sees it whole', async form => {
    const db = await parsed(mapToMermaid(nasty(form)))
    const texts =
      form === 'radial'
        ? mindNodes(db.getMindmap()).map(item => item.descr)
        : form === 'linha-do-tempo'
          ? [db.getCommonDb().getDiagramTitle(), ...db.getTasks().flatMap((task: any) => [task.task, ...task.events])]
          : [...db.getVertices().values()].map((vertex: any) => vertex.text)
    expect(texts.map(shown)).toEqual(expect.arrayContaining([NASTY_SHOWN, 'Title IX entra', 'section 2 começa']))
    if (form === 'fluxo') expect(shown(db.getSubGraphs()[0].title)).toBe(NASTY_SHOWN)
    if (form === 'fluxo') expect(shown(db.getEdges().find((edge: any) => edge.stroke === 'dotted').text)).toBe(NASTY_SHOWN)
  })

  it('keeps an empty text from breaking the drawing', async () => {
    await parsed(mapToMermaid({ form: 'arvore', root: node('r', 'Assunto', [node('a', '  ')]) }))
  })
})

describe('highlight', () => {
  const root = () => node('r', 'Assunto', [node('a', 'Mudou agora', [node('a1', 'Ficou igual')], { group: true }), node('b', 'Também mudou')])

  function classed(db: any): string[] {
    const boxes = new Set(db.getSubGraphs().map((box: any) => box.id))
    return [...db.getVertices().values()].filter((vertex: any) => !boxes.has(vertex.id) && vertex.classes.includes('pisca')).map((vertex: any) => shown(vertex.text))
  }

  it('gives the highlighted nodes the "pisca" class in the flowcharts, boxes included', async () => {
    expect(classed(await parsed(mapToMermaid({ form: 'arvore', root: root() }, ['a', 'b', 'sumiu'])))).toEqual(['Mudou agora', 'Também mudou'])
    const flow = await parsed(mapToMermaid({ form: 'fluxo', root: root() }, ['a', 'b']))
    expect(classed(flow)).toEqual(['Também mudou'])
    expect(flow.getSubGraphs().filter((box: any) => box.classes.includes('pisca')).map((box: any) => shown(box.title))).toEqual(['Mudou agora'])
  })

  it('gives the highlighted nodes the "pisca" class in the radial map', async () => {
    const all = mindNodes((await parsed(mapToMermaid({ form: 'radial', root: root() }, ['a1']))).getMindmap())
    expect(all.filter(item => item.class === 'pisca').map(item => shown(item.descr))).toEqual(['Ficou igual'])
  })

  it('marks the highlighted items of a timeline with ✨, which has no classes in Mermaid', async () => {
    const db = await parsed(mapToMermaid({ form: 'linha-do-tempo', root: root() }, ['a1', 'b']))
    expect(db.getTasks().map((task: any) => [shown(task.task), task.events.map(shown)])).toEqual([
      ['Mudou agora', ['✨ Ficou igual']],
      ['✨ Também mudou', []],
    ])
  })

  it('draws no highlight when none is asked', () => {
    expect(mapToMermaid({ form: 'arvore', root: root() })).not.toContain('pisca')
  })
})
