import { describe, expect, it, vi } from 'vitest'

import type { MapNode } from '@/types/domain'
import { INSTRUCTION_HEAD } from '@/lib/generation/instruction'
import { generateMap, mapFromOld } from '@/lib/generation/mindmap'
import { CHUNK_CHARS } from '@/lib/generation/minutes'
import { PROMPTS } from '@/lib/generation/prompts.data'
import type { GenerationSession } from '@/lib/generation/session'

type Raw = Record<string, unknown>

function fakeAi(answer: (input: string, system: string) => unknown) {
  const chat = vi.fn(async (input: string, system: string) => {
    const said = answer(input, system)
    return typeof said === 'string' ? said : JSON.stringify(said)
  })
  return { session: { chat } as unknown as GenerationSession, chat }
}

function all(node: MapNode): MapNode[] {
  return [node, ...node.children.flatMap(all)]
}

function depth(node: MapNode): number {
  return 1 + Math.max(0, ...node.children.map(depth))
}

function found(root: MapNode, text: string): MapNode {
  const node = all(root).find(item => item.text === text)
  if (!node) throw new Error(`sem o nó "${text}"`)
  return node
}

function deep(level: number): Raw {
  return { texto: `Nível ${level} explica o de cima`, filhos: level < 6 ? [deep(level + 1)] : [] }
}

const NOTE = 'Na reunião decidimos que filial + matrícula vira a chave única da importação.'

describe('generateMap', () => {
  it('keeps a free tree: deeper than 3 levels and more than 7 branches', async () => {
    const branches = [deep(1), ...Array.from({ length: 9 }, (_, index) => ({ texto: `Ramo ${index} diz algo`, filhos: [] }))]
    const { session } = fakeAi(() => ({ nome: 'Importação', forma: 'arvore', raiz: { texto: 'Importação de colaboradores', filhos: branches } }))
    const made = await generateMap(NOTE, session)
    expect(made?.diagram.root.children).toHaveLength(10)
    expect(depth(made!.diagram.root)).toBe(7)
  })

  it('brings statements, marks, groups and links through, with ids made by the app', async () => {
    const { session } = fakeAi(() => ({
      nome: 'Decisões da importação',
      forma: 'fluxo',
      raiz: {
        id: 'n1',
        texto: 'Importação de colaboradores',
        filhos: [
          { id: 'a', texto: 'Filial + matrícula vira a chave única da importação', marca: '✅', filhos: [] },
          { id: 'a', texto: 'Ana valida a planilha com o RH · Ana · sexta', marca: '📌', ligacoes: [{ para: 'a', rotulo: 'depende de' }, { para: 'zzz' }], filhos: [] },
          { texto: '  ', filhos: [{ texto: 'Nó sem texto deixa os filhos no lugar dele', filhos: [] }] },
          { texto: 'Validação', grupo: true, filhos: [{ texto: 'RH confere as matrículas repetidas', filhos: [] }] },
        ],
      },
    }))
    const { diagram } = (await generateMap(NOTE, session))!
    const nodes = all(diagram.root)
    expect(new Set(nodes.map(node => node.id)).size).toBe(nodes.length)
    expect(nodes.map(node => node.id)).not.toContain('a')
    expect(nodes.map(node => node.id)).not.toContain('n1')
    const key = found(diagram.root, 'Filial + matrícula vira a chave única da importação')
    expect(key.mark).toBe('✅')
    const task = found(diagram.root, 'Ana valida a planilha com o RH · Ana · sexta')
    expect(task.links).toEqual([{ to: key.id, label: 'depende de' }])
    expect(diagram.root.children.map(node => node.text)).toContain('Nó sem texto deixa os filhos no lugar dele')
    expect(found(diagram.root, 'Validação').group).toBe(true)
    expect(key.group).toBeUndefined()
    expect(key.links).toBeUndefined()
  })

  it('returns the name and the form the AI chose', async () => {
    const { session } = fakeAi(() => ({ nome: 'Decisões do reajuste do INCC', forma: 'linha-do-tempo', raiz: { texto: 'Reajuste do INCC', filhos: [{ texto: 'Março: reajuste de 4% aprovado', filhos: [] }] } }))
    expect(await generateMap(NOTE, session)).toMatchObject({ name: 'Decisões do reajuste do INCC', diagram: { form: 'linha-do-tempo', root: { text: 'Reajuste do INCC' } } })
  })

  it('names the map after its root and draws it radial when the AI leaves them out', async () => {
    const { session } = fakeAi(() => ({ forma: 'espiral', raiz: { texto: 'Limites laterais', filhos: [{ texto: 'O limite existe quando os dois lados concordam', filhos: [] }] } }))
    expect(await generateMap(NOTE, session)).toMatchObject({ name: 'Limites laterais', diagram: { form: 'radial' } })
  })

  it('puts the instruction in the request as the marked block, and leaves it out when empty', async () => {
    const { session, chat } = fakeAi(() => ({ nome: 'Mapa', forma: 'radial', raiz: { texto: 'Assunto', filhos: [{ texto: 'Uma ideia', filhos: [] }] } }))
    await generateMap(NOTE, session, 'Foque nas decisões')
    expect(chat.mock.calls[0][0]).toContain(NOTE)
    expect(chat.mock.calls[0][0]).toContain(`${INSTRUCTION_HEAD}\n\nFoque nas decisões`)
    expect(chat.mock.calls[0][1]).toBe(PROMPTS.MINDMAP_PROMPT)
    await generateMap(NOTE, session, '   ')
    await generateMap(NOTE, session)
    expect(chat.mock.calls[1][0]).not.toContain(INSTRUCTION_HEAD)
    expect(chat.mock.calls[2][0]).not.toContain(INSTRUCTION_HEAD)
  })

  it('gives null when there is nothing to read or the AI answers no map', async () => {
    const quiet = fakeAi(() => ({}))
    expect(await generateMap('   ', quiet.session)).toBeNull()
    expect(quiet.chat).not.toHaveBeenCalled()
    expect(await generateMap(NOTE, fakeAi(() => 'não consegui').session)).toBeNull()
    expect(await generateMap(NOTE, fakeAi(() => ({ nome: 'Só raiz', raiz: { texto: 'Assunto', filhos: [] } })).session)).toBeNull()
  })
})

describe('generateMap on a long note', () => {
  const MARKS = ['PARTE-A', 'PARTE-B', 'PARTE-C', 'PARTE-D']
  /** Each mark sits in the middle of its own stretch, so it falls in one part only; the end is past the old 24k cut. */
  const LONG = MARKS.map(mark => `${'texto '.repeat(CHUNK_CHARS / 12)}${mark} ${'texto '.repeat(CHUNK_CHARS / 12)}`).join('\n') + ' FIM-DA-NOTA'

  function partAnswer(input: string): Raw {
    const marks = MARKS.filter(mark => input.includes(mark))
    const branches = marks.map(mark => ({ id: `r-${mark}`, texto: `Ramo ${mark} diz algo`, filhos: [{ texto: `Detalhe ${mark}`, ligacoes: [{ para: `r-${mark}`, rotulo: 'detalha' }], filhos: [] }] }))
    if (input.includes('FIM-DA-NOTA')) branches.push({ id: 'fim', texto: 'O fim da nota também entra', filhos: [] })
    return { nome: `Parte com ${marks.join(', ')}`, forma: 'arvore', raiz: { texto: 'Importação', filhos: branches } }
  }

  function idOf(input: string, text: string): string {
    const parts = (JSON.parse(input.split(`\n\n${INSTRUCTION_HEAD}`)[0]) as { partes: { ramos: { id: string; texto: string }[] }[] }).partes
    return parts.flatMap(part => part.ramos).find(branch => branch.texto === text)!.id
  }

  function mergeAnswer(input: string): Raw {
    return {
      nome: 'Importação de colaboradores completa',
      forma: 'fluxo',
      raiz: 'Importação de colaboradores',
      ramos: [{ junta: [idOf(input, 'Ramo PARTE-C diz algo')] }, { texto: 'A e B tratam da mesma chave', junta: [idOf(input, 'Ramo PARTE-A diz algo'), idOf(input, 'Ramo PARTE-B diz algo'), 'id-inventado'] }],
    }
  }

  it('reads every part, merges them into one map and loses no branch the merge forgot', async () => {
    const { session, chat } = fakeAi((input, system) => (system === PROMPTS.MINDMAP_MERGE_PROMPT ? mergeAnswer(input) : partAnswer(input)))
    const made = (await generateMap(LONG, session, 'Foque na chave'))!
    const parts = chat.mock.calls.filter(([, system]) => system === PROMPTS.MINDMAP_PROMPT)
    expect(parts.length).toBeGreaterThan(2)
    expect(parts.some(([input]) => input.includes('FIM-DA-NOTA'))).toBe(true)
    expect(chat.mock.calls.filter(([, system]) => system === PROMPTS.MINDMAP_MERGE_PROMPT)).toHaveLength(1)
    expect(chat.mock.calls.every(([input]) => input.includes(`${INSTRUCTION_HEAD}\n\nFoque na chave`))).toBe(true)
    expect(made.name).toBe('Importação de colaboradores completa')
    expect(made.diagram.form).toBe('fluxo')
    const root = made.diagram.root
    expect(root.text).toBe('Importação de colaboradores')
    expect(root.children.map(node => node.text)).toEqual(['Ramo PARTE-C diz algo', 'A e B tratam da mesma chave', 'Ramo PARTE-D diz algo', 'O fim da nota também entra'])
    const joined = root.children[1]
    expect(joined.children.map(node => node.text)).toEqual(['Detalhe PARTE-A', 'Detalhe PARTE-B'])
    expect(joined.children.map(node => node.links?.[0].to)).toEqual([joined.id, joined.id])
    const nodes = all(root)
    expect(new Set(nodes.map(node => node.id)).size).toBe(nodes.length)
  })

  it('keeps every part when the merge answer is out of format', async () => {
    const { session } = fakeAi((input, system) => (system === PROMPTS.MINDMAP_MERGE_PROMPT ? 'não sei juntar' : partAnswer(input)))
    const made = (await generateMap(LONG, session))!
    expect(made.diagram.root.children.map(node => node.text)).toEqual([...MARKS.map(mark => `Ramo ${mark} diz algo`), 'O fim da nota também entra'])
    expect(made.diagram.form).toBe('arvore')
    expect(made.name).toBe('Parte com PARTE-A')
  })

  it('joins a branch repeated by the overlap between parts', async () => {
    const { session } = fakeAi((input, system) => (system === PROMPTS.MINDMAP_MERGE_PROMPT ? { ramos: [] } : { nome: 'Mapa', forma: 'radial', raiz: { texto: 'Assunto', filhos: [{ texto: 'A mesma ideia em toda parte', filhos: [{ texto: 'O mesmo detalhe', filhos: [] }] }] } }))
    const made = (await generateMap(LONG, session))!
    expect(made.diagram.root.children).toHaveLength(1)
    expect(made.diagram.root.children[0].children.map(node => node.text)).toEqual(['O mesmo detalhe'])
  })
})

describe('mapFromOld', () => {
  it('turns the old single map into a radial diagram with the same tree and fresh ids', () => {
    const diagram = mapFromOld({ title: 'Limites', children: [{ title: 'Laterais', children: [{ title: 'Esquerda e direita', children: [] }] }, { title: 'Continuidade', children: [] }] })
    expect(diagram.form).toBe('radial')
    const strip = (node: MapNode): unknown => ({ text: node.text, children: node.children.map(strip) })
    expect(strip(diagram.root)).toEqual({ text: 'Limites', children: [{ text: 'Laterais', children: [{ text: 'Esquerda e direita', children: [] }] }, { text: 'Continuidade', children: [] }] })
    const ids = all(diagram.root).map(node => node.id)
    expect(new Set(ids).size).toBe(4)
    expect(ids.every(Boolean)).toBe(true)
  })
})
