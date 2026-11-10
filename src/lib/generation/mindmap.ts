import type { MapDiagram, MapForm, MapNode, MindNode } from '@/types/domain'
import { withInstruction } from '@/lib/generation/instruction'
import { extractJson } from '@/lib/generation/mermaid'
import { transcriptChunks } from '@/lib/generation/minutes'
import { PROMPTS } from '@/lib/generation/prompts.data'
import type { GenerationSession } from '@/lib/generation/session'
import { newId } from '@/lib/ids'

type Item = Record<string, unknown>

interface Part {
  name: string
  form: MapForm
  root: MapNode
}

const FORMS: MapForm[] = ['radial', 'arvore', 'fluxo', 'linha-do-tempo']

function said(value: unknown): string {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : ''
}

function items(value: unknown): Item[] {
  return Array.isArray(value) ? value.filter((item): item is Item => typeof item === 'object' && item !== null && !Array.isArray(item)) : []
}

function formOf(value: unknown): MapForm | null {
  return FORMS.find(form => form === value) ?? null
}

function all(node: MapNode): MapNode[] {
  return [node, ...node.children.flatMap(all)]
}

/** The AI's nodes with ids made here; `refs` keeps the id the AI wrote, which its links point to. A node without text gives way to its children. */
function nodesOf(raw: Item, refs: Map<string, string>): MapNode[] {
  const children = items(raw.filhos).flatMap(child => nodesOf(child, refs))
  const text = said(raw.texto)
  if (!text) return children
  const node: MapNode = { id: newId(), text, children }
  const mark = said(raw.marca)
  if (mark) node.mark = mark
  if (raw.grupo === true) node.group = true
  const links = items(raw.ligacoes).flatMap(link => (said(link.para) ? [said(link.rotulo) ? { to: said(link.para), label: said(link.rotulo) } : { to: said(link.para) }] : []))
  if (links.length) node.links = links
  const ref = said(raw.id)
  if (ref && !refs.has(ref)) refs.set(ref, node.id)
  return [node]
}

function partOf(answer: Item | null): Part | null {
  const [raw] = items([answer?.raiz])
  const name = said(answer?.nome)
  const text = said(raw?.texto) || name
  if (!raw || !text) return null
  const refs = new Map<string, string>()
  const [root] = nodesOf({ ...raw, texto: text }, refs)
  if (!root.children.length) return null
  for (const node of all(root)) if (node.links) node.links = node.links.flatMap(link => (refs.has(link.to) ? [{ ...link, to: refs.get(link.to)! }] : []))
  return { name: name || text, form: formOf(answer?.forma) ?? 'radial', root }
}

/** `extra` folded into `kept`, which keeps its id: the two said the same thing. */
function fold(kept: MapNode, extra: MapNode, moved: Map<string, string>): MapNode {
  moved.set(extra.id, kept.id)
  const node: MapNode = { ...kept, children: [...kept.children, ...extra.children] }
  if (!node.mark && extra.mark) node.mark = extra.mark
  if (extra.group) node.group = true
  if (extra.links?.length) node.links = [...(kept.links ?? []), ...extra.links]
  return node
}

function sameness(text: string): string {
  return (
    text
      .normalize('NFD')
      .replace(/\p{M}/gu, '')
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, ' ')
      .trim() || text
  )
}

/** Nodes with the same text become one, all the way down: the overlap between parts repeats some. */
function combined(nodes: MapNode[], moved: Map<string, string>): MapNode[] {
  const kept = new Map<string, MapNode>()
  for (const node of nodes) {
    const earlier = kept.get(sameness(node.text))
    kept.set(sameness(node.text), earlier ? fold(earlier, node, moved) : node)
  }
  return [...kept.values()].map(node => ({ ...node, children: combined(node.children, moved) }))
}

/** One branch of the merge answer: the branches it names, joined; each branch is used once. */
function joined(asked: Item, left: Map<string, MapNode>, moved: Map<string, string>): MapNode[] {
  const taken = (Array.isArray(asked.junta) ? asked.junta : []).flatMap(id => {
    const branch = left.get(said(id))
    if (!branch) return []
    left.delete(branch.id)
    return [branch]
  })
  const [head, ...others] = taken
  if (!head) return []
  // A branch kept alone keeps its own words; only a joined one takes the merge's text.
  if (!others.length) return [head]
  return [others.reduce((node, other) => fold(node, other, moved), { ...head, text: said(asked.texto) || head.text })]
}

/** The AI orders and joins the parts' branches by id, so it cannot drop or rewrite one: whatever it leaves out goes in at the end. */
async function merged(parts: Part[], session: GenerationSession, instruction: string, moved: Map<string, string>): Promise<Part> {
  const outline = {
    partes: parts.map(part => ({ nome: part.name, forma: part.form, raiz: part.root.text, ramos: part.root.children.map(branch => ({ id: branch.id, texto: branch.text, filhos: branch.children.map(child => child.text) })) })),
  }
  const answer = extractJson(await session.chat(withInstruction(JSON.stringify(outline), instruction), PROMPTS.MINDMAP_MERGE_PROMPT))
  const left = new Map(parts.flatMap(part => part.root.children.map(branch => [branch.id, branch] as const)))
  const ordered = items(answer?.ramos).flatMap(asked => joined(asked, left, moved))
  const [first, ...rest] = parts
  rest.forEach(part => moved.set(part.root.id, first.root.id))
  return {
    name: said(answer?.nome) || first.name,
    form: formOf(answer?.forma) ?? first.form,
    root: { ...first.root, text: said(answer?.raiz) || first.root.text, children: combined([...ordered, ...left.values()], moved) },
  }
}

/** Links follow the nodes folded into others; links to nodes that are gone, to themselves or repeated go away. */
function linked(root: MapNode, moved: Map<string, string>): MapNode {
  const ids = new Set(all(root).map(node => node.id))
  const target = (id: string) => {
    let at = id
    for (let hop = 0; moved.has(at) && hop <= moved.size; hop++) at = moved.get(at)!
    return at
  }
  const tidy = (node: MapNode): MapNode => {
    const { links, ...rest } = node
    const kept = (links ?? [])
      .map(link => ({ ...link, to: target(link.to) }))
      .filter((link, index, list) => ids.has(link.to) && link.to !== node.id && list.findIndex(other => other.to === link.to && other.label === link.label) === index)
    return { ...rest, ...(kept.length ? { links: kept } : {}), children: node.children.map(tidy) }
  }
  return tidy(root)
}

/**
 * The map of the WHOLE note: a long one is read in parts, one map per part, and the parts are merged.
 * The AI picks the form and a free tree; ids are made here. `instruction`: the "Instrução extra para a IA".
 */
export async function generateMap(content: string, session: GenerationSession, instruction = ''): Promise<{ name: string; diagram: MapDiagram } | null> {
  const text = content.trim()
  if (!text) return null
  const parts: Part[] = []
  for (const piece of transcriptChunks(text)) {
    const part = partOf(extractJson(await session.chat(withInstruction(piece, instruction), PROMPTS.MINDMAP_PROMPT)))
    if (part) parts.push(part)
  }
  if (!parts.length) return null
  const moved = new Map<string, string>()
  const whole = parts.length > 1 ? await merged(parts, session, instruction, moved) : parts[0]
  return { name: whole.name, diagram: { form: whole.form, root: linked(whole.root, moved) } }
}

/** The old single map of a note (sidecar.mindmap) as a diagram. */
export function mapFromOld(old: MindNode): MapDiagram {
  const node = (item: MindNode): MapNode => ({ id: newId(), text: item.title, children: item.children.map(node) })
  return { form: 'radial', root: node(old) }
}
