import { describe, expect, it, vi } from 'vitest'

import { applyChange, askMap, changedNodes, clearHighlight, MAP_CHAT_PROMPT, undo } from '@/lib/generation/map-chat'
import { CHUNK_CHARS } from '@/lib/generation/minutes'
import type { GenerationSession } from '@/lib/generation/session'
import type { MapArtifact, MapChatTurn, MapDiagram, MapNode } from '@/types/domain'

const NOTE = '# Limites\n\nLimites laterais: pela esquerda e pela direita.\n\nSe os laterais diferem, o limite não existe.\n\nContinuidade exige que o limite exista e seja igual ao valor.'

function diagram(): MapDiagram {
  return {
    form: 'radial',
    root: {
      id: 'r',
      text: 'Limites',
      children: [
        { id: 'a', text: 'Limites laterais', mark: '📌', children: [{ id: 'a1', text: 'Pela esquerda', children: [] }] },
        { id: 'b', text: 'Continuidade', children: [] },
        { id: 'c', text: 'Inexistência', children: [] },
      ],
    },
  }
}

function mapOf(chat: MapChatTurn[] = []): MapArtifact {
  return { id: 'm1', kind: 'mapa', name: 'Limites', createdAt: '2026-11-06T10:00:00.000Z', updatedAt: '2026-11-06T10:00:00.000Z', diagram: diagram(), versions: [], chat }
}

function aiSays(reply: unknown) {
  const chat = vi.fn(async () => (typeof reply === 'string' ? reply : JSON.stringify(reply)))
  return { session: { chat } as unknown as GenerationSession, chat }
}

const sent = (chat: ReturnType<typeof aiSays>['chat']) => chat.mock.calls[0] as unknown as [string, string]

interface RawNode {
  id?: string
  texto: string
  marca?: string
  grupo?: boolean
  ligacoes?: { para: string; rotulo?: string }[]
  filhos: RawNode[]
}

/** The current map as the model sees it: ids n1… in reading order (r, a, a1, b, c). */
const SAME_TREE: RawNode = {
  id: 'n1',
  texto: 'Limites',
  filhos: [
    { id: 'n2', texto: 'Limites laterais', marca: '📌', filhos: [{ id: 'n3', texto: 'Pela esquerda', filhos: [] }] },
    { id: 'n4', texto: 'Continuidade', filhos: [] },
    { id: 'n5', texto: 'Inexistência', filhos: [] },
  ],
}

function allNodes(root: MapNode): MapNode[] {
  return [root, ...root.children.flatMap(allNodes)]
}

describe('askMap: a question about the map', () => {
  it('gets the answer and leaves the map as it is, in one call with the note, the map and the question', async () => {
    const { session, chat } = aiSays({ resposta: 'Quando os laterais diferem, o limite não existe.', mapa: null })
    const result = await askMap(NOTE, mapOf(), 'Quando o limite não existe?', session)
    expect(result).toEqual({ answer: 'Quando os laterais diferem, o limite não existe.', changed: [] })
    expect(chat).toHaveBeenCalledTimes(1)
    const [input, system] = sent(chat)
    expect(system).toBe(MAP_CHAT_PROMPT)
    expect(input).toContain('Se os laterais diferem, o limite não existe.')
    expect(input).toContain('"id":"n2","texto":"Limites laterais","marca":"📌"')
    expect(input).toContain('Forma do mapa: radial')
    expect(input).toContain('Pedido agora: Quando o limite não existe?')
  })

  it('an answer that brings something from outside the note says so, as the prompt asks', async () => {
    expect(MAP_CHAT_PROMPT).toContain('isso não está na nota')
    expect(MAP_CHAT_PROMPT).toContain('a não ser que a pessoa peça')
    const { session } = aiSays({ resposta: 'Um exemplo é 1/x em zero (isso não está na nota).', mapa: null })
    const { answer } = await askMap(NOTE, mapOf(), 'Me dá um exemplo?', session)
    expect(answer).toBe('Um exemplo é 1/x em zero (isso não está na nota).')
  })

  it('sends only the last turns of the map chat, with who said each', async () => {
    const turns: MapChatTurn[] = Array.from({ length: 20 }, (_, index) => ({ who: index % 2 ? 'ia' : 'você', text: `fala ${index}`, at: '2026-11-06T10:00:00.000Z' }))
    const { session, chat } = aiSays({ resposta: 'Ok.', mapa: null })
    await askMap(NOTE, mapOf(turns), 'E agora?', session)
    const [input] = sent(chat)
    expect(input).not.toMatch(/: fala 7$/m)
    expect(input).toContain('Pessoa: fala 8')
    expect(input).toContain('IA: fala 19')
  })

  it('a long note goes bounded, with the parts that talk about the question', async () => {
    const filler = Array.from({ length: 40 }, (_, index) => `Parte ${index}: texto de enchimento sem relação. ${'bla '.repeat(250)}`)
    const long = ['# Cálculo', ...filler, 'A derivada mede a taxa de variação instantânea.'].join('\n\n')
    const { session, chat } = aiSays({ resposta: 'Ok.', mapa: null })
    await askMap(long, mapOf(), 'O que a nota diz da derivada?', session)
    const [input] = sent(chat)
    expect(input).toContain('A derivada mede a taxa de variação instantânea.')
    expect(input).toContain('# Cálculo')
    expect(input).not.toContain('Parte 39:')
    expect(input.length).toBeLessThan(CHUNK_CHARS * 2 + 2000)
  })

  it('an answer out of the JSON format is a clear error', async () => {
    await expect(askMap(NOTE, mapOf(), 'Oi?', aiSays('Claro! Aqui vai o mapa…').session)).rejects.toThrow('A IA respondeu fora do formato esperado. Tente de novo.')
    await expect(askMap(NOTE, mapOf(), 'Oi?', aiSays({ mapa: null }).session)).rejects.toThrow('A IA respondeu fora do formato esperado. Tente de novo.')
  })

  it('a map with no center is a clear error', async () => {
    await expect(askMap(NOTE, mapOf(), 'Tira tudo', aiSays({ resposta: 'Pronto.', mapa: { texto: ' ', filhos: [] } }).session)).rejects.toThrow('A IA devolveu um mapa sem centro. Tente pedir de novo.')
  })
})

describe('askMap: a change request', () => {
  it('returns the new tree, keeping the ids of the nodes that stay, and the changed ids', async () => {
    const tree = structuredClone(SAME_TREE)
    tree.filhos[1].texto = 'Continuidade num ponto'
    tree.filhos[2].filhos.push({ id: 'novo1', texto: 'Laterais diferentes', filhos: [] })
    const { session } = aiSays({ resposta: 'Pronto, mudei.', mapa: tree })
    const result = await askMap(NOTE, mapOf(), 'Detalha a inexistência', session)
    const root = result.diagram!.root
    expect(result.diagram!.form).toBe('radial')
    expect(root.children.map(node => node.id)).toEqual(['a', 'b', 'c'])
    expect(root.children[0]).toEqual(diagram().root.children[0])
    expect(root.children[1].text).toBe('Continuidade num ponto')
    const added = root.children[2].children[0]
    expect(added.text).toBe('Laterais diferentes')
    expect(result.changed).toEqual(['b', 'c', added.id])
  })

  it('new nodes get fresh unique ids from the app, whatever id the AI wrote', async () => {
    const tree = structuredClone(SAME_TREE)
    tree.filhos[1].filhos.push({ id: 'novo1', texto: 'Valor igual ao limite', filhos: [] }, { id: 'novo1', texto: 'Limite existe', filhos: [] })
    tree.filhos.push({ id: 'n2', texto: 'Outro com id repetido', filhos: [] }, { texto: 'Sem id', filhos: [] })
    const { session } = aiSays({ resposta: 'Pronto.', mapa: tree })
    const { diagram: next, changed } = await askMap(NOTE, mapOf(), 'Acrescenta', session)
    const ids = allNodes(next!.root).map(node => node.id)
    expect(new Set(ids).size).toBe(ids.length)
    const old = ['r', 'a', 'a1', 'b', 'c']
    expect(ids).toEqual(expect.arrayContaining(old))
    const fresh = ids.filter(id => !old.includes(id))
    expect(fresh).toHaveLength(4)
    for (const id of fresh) expect(['novo1', 'n2', '']).not.toContain(id)
    expect(changed).toEqual(['r', 'b', fresh[0], fresh[1], fresh[2], fresh[3]])
  })

  it('removed nodes are not in changed, but their parent is; empty texts are dropped', async () => {
    const tree = structuredClone(SAME_TREE)
    tree.filhos[0].filhos = [{ id: 'n3', texto: '  ', filhos: [] }]
    const { session } = aiSays({ resposta: 'Tirei.', mapa: tree })
    const { diagram: next, changed } = await askMap(NOTE, mapOf(), 'Tira "Pela esquerda"', session)
    expect(next!.root.children[0].children).toEqual([])
    expect(changed).toEqual(['a'])
  })

  it('can change only the form of the map', async () => {
    const { session } = aiSays({ resposta: 'Agora é uma árvore.', mapa: null, forma: 'arvore' })
    const result = await askMap(NOTE, mapOf(), 'Mostra como árvore', session)
    expect(result.diagram).toEqual({ ...diagram(), form: 'arvore' })
    expect(result.changed).toEqual([])
  })

  it('a tree identical to the current one is no change', async () => {
    const { session } = aiSays({ resposta: 'Já está assim.', mapa: SAME_TREE, forma: 'banana' })
    expect(await askMap(NOTE, mapOf(), 'Deixa como está', session)).toEqual({ answer: 'Já está assim.', changed: [] })
  })

  it('links point to the real ids, also of new nodes, and unknown targets are dropped', async () => {
    const tree = structuredClone(SAME_TREE)
    tree.filhos[1].ligacoes = [{ para: 'n2', rotulo: 'depende de' }, { para: 'novo1' }, { para: 'n99' }]
    tree.filhos.push({ id: 'novo1', texto: 'Valor', grupo: true, filhos: [] })
    const { session } = aiSays({ resposta: 'Liguei.', mapa: tree, forma: 'fluxo' })
    const { diagram: next, changed } = await askMap(NOTE, mapOf(), 'Liga continuidade aos laterais', session)
    const value = next!.root.children[3]
    expect(next!.form).toBe('fluxo')
    expect(value.group).toBe(true)
    expect(next!.root.children[1].links).toEqual([{ to: 'a', label: 'depende de' }, { to: value.id }])
    expect(changed).toEqual(['r', 'b', value.id])
  })
})

describe('changedNodes', () => {
  it('flags added nodes and nodes whose text, mark or children changed', () => {
    const next = diagram().root
    next.children[0].mark = '✅'
    next.children.reverse()
    expect(changedNodes(diagram().root, next)).toEqual(['r', 'a'])
    expect(changedNodes(diagram().root, diagram().root)).toEqual([])
  })
})

describe('applyChange, undo and clearHighlight', () => {
  const turn = (who: MapChatTurn['who'], text: string): MapChatTurn => ({ who, text, at: '2026-11-06T10:00:00.000Z' })

  function changedTo(text: string): MapDiagram {
    const next = diagram()
    next.root.text = text
    return next
  }

  it('applies a change keeping the previous version, marks what changed and adds the turns', () => {
    const map = mapOf()
    const turns = [turn('você', 'Renomeia'), turn('ia', 'Pronto.')]
    const next = applyChange(map, changedTo('Limites 1'), ['r'], turns)
    expect(next.diagram.root.text).toBe('Limites 1')
    expect(next.versions).toEqual([diagram()])
    expect(next.highlight).toEqual(['r'])
    expect(next.chat).toEqual(turns)
    expect(map.versions).toEqual([])
  })

  it('undo goes back step by step, and with nothing to undo returns the same map', () => {
    const first = applyChange(mapOf(), changedTo('Limites 1'), ['r'], [])
    const second = applyChange(first, changedTo('Limites 2'), ['r'], [])
    const back = undo(second)
    expect(back.diagram.root.text).toBe('Limites 1')
    expect(back.versions).toHaveLength(1)
    expect(back.highlight).toBeUndefined()
    const start = undo(back)
    expect(start.diagram).toEqual(diagram())
    expect(start.versions).toEqual([])
    expect(undo(start)).toBe(start)
  })

  it('clearHighlight stops the blinking', () => {
    const changed = applyChange(mapOf(), changedTo('Limites 1'), ['r'], [])
    expect(clearHighlight(changed).highlight).toBeUndefined()
    const calm = mapOf()
    expect(clearHighlight(calm)).toBe(calm)
  })
})
