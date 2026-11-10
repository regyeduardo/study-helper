import type { MapArtifact, MapChatTurn, MapDiagram, MapForm, MapNode } from '@/types/domain'
import { newId } from '@/lib/ids'
import { extractJson } from '@/lib/generation/mermaid'
import { CHUNK_CHARS } from '@/lib/generation/minutes'
import type { GenerationSession } from '@/lib/generation/session'

export const MAP_CHAT_PROMPT = `Você conversa com a pessoa sobre um mapa mental feito de uma nota de estudo ou de reunião, em português do Brasil. Você recebe a nota, o mapa atual, a conversa até agora e o pedido.

A pessoa pode perguntar sobre o mapa ou a nota, pedir para criar, mudar ou tirar ramos, ou pedir outra forma de mapa.

Regras:
- Responda com base na nota. Se usar algo que não está na nota, diga na resposta: "isso não está na nota".
- Ramo novo só com o que está na nota, a não ser que a pessoa peça para trazer algo de fora.
- Pergunta não muda o mapa: "mapa": null.
- Pedido de mudança: "mapa" é a árvore inteira, já mudada. Mexa só no que foi pedido.
- Nó que continua mantém o seu "id"; nó novo ganha um id novo (ex.: "novo1").
- "forma" só quando a pessoa pedir outra: "radial", "arvore", "fluxo" ou "linha-do-tempo".
- "resposta": curta; num pedido de mudança, diga o que mudou.

Devolva SOMENTE um JSON assim:
{"resposta": "Pronto, separei a continuidade em dois ramos.", "mapa": {"id": "n1", "texto": "Limites", "filhos": [{"id": "n2", "texto": "Limites laterais", "marca": "📌", "filhos": []}, {"id": "novo1", "texto": "Continuidade", "ligacoes": [{"para": "n2", "rotulo": "depende de"}], "filhos": []}]}}

"marca" (opcional): emoji que a nota já usa (✅, 📌…). Na forma "fluxo", "grupo": true desenha uma caixa em volta dos filhos e "ligacoes" são setas para outros nós pelo "id" (os dois opcionais).`

const NOTE_CHARS = CHUNK_CHARS * 2
const HISTORY_TURNS = 12
const FORMS: MapForm[] = ['radial', 'arvore', 'fluxo', 'linha-do-tempo']
const FORMAT_ERROR = 'A IA respondeu fora do formato esperado. Tente de novo.'
const NO_CENTER_ERROR = 'A IA devolveu um mapa sem centro. Tente pedir de novo.'
/** Words that show up in any request to the chat, so they say nothing about which part of the note it is about. */
const COMMON_WORDS = new Set(['nota', 'mapa', 'ramo', 'ramos', 'para', 'como', 'isso', 'esse', 'essa', 'este', 'esta', 'qual', 'quais', 'quando', 'onde', 'porque', 'sobre', 'mais', 'pode', 'cria', 'muda', 'tira', 'coloca'])

type Raw = Record<string, unknown>

function nodesOf(root: MapNode): MapNode[] {
  return [root, ...root.children.flatMap(nodesOf)]
}

function wordsOf(text: string): Set<string> {
  const plain = text.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
  return new Set((plain.match(/[a-z0-9]{4,}/g) ?? []).filter(word => !COMMON_WORDS.has(word)))
}

/**
 * A note longer than the budget goes in blocks: the ones that share words with the question first,
 * then the rest from the top, back in the note's order with "[…]" where something was left out.
 * Word overlap is crude, but it needs no extra call and a block-level cut keeps each idea whole.
 */
export function notePart(note: string, question: string): string {
  const text = note.trim()
  if (text.length <= NOTE_CHARS) return text
  const asked = wordsOf(question)
  const blocks = text.split(/\n\s*\n/).map((block, index) => ({ block, index, score: [...wordsOf(block)].filter(word => asked.has(word)).length }))
  const ranked = [...blocks].sort((one, other) => other.score - one.score || one.index - other.index)
  const kept = new Set<number>()
  let size = 0
  for (const { block, index } of ranked) {
    if (size + block.length > NOTE_CHARS) continue
    kept.add(index)
    size += block.length + 2
  }
  if (!kept.size) return ranked[0].block.slice(0, NOTE_CHARS)
  return blocks.map(({ block, index }) => (kept.has(index) ? block : '[…]')).filter((block, index, all) => block !== '[…]' || all[index - 1] !== '[…]').join('\n\n')
}

/** The model sees short ids (n1, n2…) in reading order: fewer tokens and fewer copying mistakes than the real ones. */
function shortIds(root: MapNode): Map<string, string> {
  return new Map(nodesOf(root).map((node, index) => [node.id, `n${index + 1}`]))
}

function rawOf(node: MapNode, short: Map<string, string>): Raw {
  const raw: Raw = { id: short.get(node.id), texto: node.text }
  if (node.mark) raw.marca = node.mark
  if (node.group) raw.grupo = true
  if (node.links?.length) raw.ligacoes = node.links.map(link => (link.label ? { para: short.get(link.to) ?? link.to, rotulo: link.label } : { para: short.get(link.to) ?? link.to }))
  raw.filhos = node.children.map(child => rawOf(child, short))
  return raw
}

function talkOf(chat: MapChatTurn[]): string {
  return chat
    .slice(-HISTORY_TURNS)
    .map(turn => `${turn.who === 'você' ? 'Pessoa' : 'IA'}: ${turn.text}`)
    .join('\n')
}

export function mapChatInput(note: string, map: MapArtifact, question: string, short: Map<string, string>): string {
  const tree = JSON.stringify(rawOf(map.diagram.root, short))
  return `Nota:\n${notePart(note, question)}\n\nForma do mapa: ${map.diagram.form}\nMapa atual:\n${tree}\n\nConversa até agora:\n${talkOf(map.chat) || '(começo da conversa)'}\n\nPedido agora: ${question.trim()}`
}

interface Reading {
  /** Short id the model saw → real id. */
  known: Map<string, string>
  used: Set<string>
  /** Id the model wrote → id the node got, so links can point to new nodes too. */
  aliases: Map<string, string>
  linked: { node: MapNode; raw: unknown[] }[]
}

function idOf(raw: unknown, reading: Reading): string {
  const real = typeof raw === 'string' ? reading.known.get(raw) : undefined
  const id = real && !reading.used.has(real) ? real : newId()
  reading.used.add(id)
  if (typeof raw === 'string' && !reading.aliases.has(raw)) reading.aliases.set(raw, id)
  return id
}

function nodeOf(raw: unknown, reading: Reading): MapNode | null {
  if (typeof raw !== 'object' || raw === null) return null
  const item = raw as Raw
  const text = typeof item.texto === 'string' ? item.texto.trim() : ''
  if (!text) return null
  const node: MapNode = { id: idOf(item.id, reading), text, children: [] }
  const mark = typeof item.marca === 'string' ? item.marca.trim() : ''
  if (mark) node.mark = mark
  if (item.grupo === true) node.group = true
  if (Array.isArray(item.ligacoes)) reading.linked.push({ node, raw: item.ligacoes })
  if (Array.isArray(item.filhos)) node.children = item.filhos.map(child => nodeOf(child, reading)).filter((child): child is MapNode => Boolean(child))
  return node
}

function linkOf(raw: unknown, from: MapNode, aliases: Map<string, string>): { to: string; label?: string } | null {
  const item = typeof raw === 'object' && raw !== null ? (raw as Raw) : {}
  const to = typeof item.para === 'string' ? aliases.get(item.para) : undefined
  if (!to || to === from.id) return null
  const label = typeof item.rotulo === 'string' ? item.rotulo.trim() : ''
  return label ? { to, label } : { to }
}

function treeOf(raw: unknown, short: Map<string, string>): MapNode | null {
  const reading: Reading = { known: new Map([...short].map(([real, alias]) => [alias, real])), used: new Set(), aliases: new Map(), linked: [] }
  const root = nodeOf(raw, reading)
  for (const { node, raw: links } of reading.linked) {
    const resolved = links.map(link => linkOf(link, node, reading.aliases)).filter((link): link is { to: string; label?: string } => link !== null)
    if (resolved.length) node.links = resolved
  }
  return root
}

function sameNode(one: MapNode, other: MapNode): boolean {
  const childIds = (node: MapNode) => node.children.map(child => child.id).join('\n')
  const links = (node: MapNode) => JSON.stringify(node.links ?? [])
  return one.text === other.text && one.mark === other.mark && Boolean(one.group) === Boolean(other.group) && links(one) === links(other) && childIds(one) === childIds(other)
}

/** Ids of the nodes of `next` that are new or whose text, mark, group, links or children differ from `old`; a removed node shows up as its parent. */
export function changedNodes(old: MapNode, next: MapNode): string[] {
  const before = new Map(nodesOf(old).map(node => [node.id, node]))
  return nodesOf(next)
    .filter(node => {
      const was = before.get(node.id)
      return !was || !sameNode(was, node)
    })
    .map(node => node.id)
}

function diagramOf(reply: Raw, current: MapDiagram, short: Map<string, string>): MapDiagram | null {
  const form = FORMS.find(item => item === reply.forma) ?? current.form
  if (reply.mapa === null || reply.mapa === undefined) return form === current.form ? null : { form, root: current.root }
  const root = treeOf(reply.mapa, short)
  if (!root) throw new Error(NO_CENTER_ERROR)
  return { form, root }
}

export async function askMap(note: string, map: MapArtifact, question: string, session: GenerationSession): Promise<{ answer: string; diagram?: MapDiagram; changed: string[] }> {
  const short = shortIds(map.diagram.root)
  const reply = extractJson(await session.chat(mapChatInput(note, map, question, short), MAP_CHAT_PROMPT))
  const answer = typeof reply?.resposta === 'string' ? reply.resposta.trim() : ''
  if (!reply || !answer) throw new Error(FORMAT_ERROR)
  const diagram = diagramOf(reply, map.diagram, short)
  if (!diagram) return { answer, changed: [] }
  const changed = changedNodes(map.diagram.root, diagram.root)
  if (!changed.length && diagram.form === map.diagram.form) return { answer, changed: [] }
  return { answer, diagram, changed }
}

export function applyChange(map: MapArtifact, diagram: MapDiagram, changed: string[], turns: MapChatTurn[]): MapArtifact {
  return { ...map, diagram, versions: [...map.versions, map.diagram], chat: [...map.chat, ...turns], highlight: changed }
}

export function clearHighlight(map: MapArtifact): MapArtifact {
  return map.highlight ? { ...map, highlight: undefined } : map
}

export function undo(map: MapArtifact): MapArtifact {
  const previous = map.versions.at(-1)
  if (!previous) return map
  return { ...map, diagram: previous, versions: map.versions.slice(0, -1), highlight: undefined }
}
