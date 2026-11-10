// Draws a map as Mermaid. The AI only gives the tree; the app writes the syntax, so it never arrives broken.
import type { MapDiagram, MapForm, MapNode } from '@/types/domain'

/** CSS class of the highlighted nodes: the UI animates it. */
export const HIGHLIGHT_CLASS = 'pisca'
/** Mermaid's timeline has no classes, so a highlighted item carries this in its text. */
const TIMELINE_HIGHLIGHT = '✨'

/**
 * Characters that are syntax in some of the diagrams become entity codes ("#58;"): Mermaid swaps them
 * before parsing and draws the character back, so quotes, brackets and colons stay in the text.
 */
const SYNTAX = /[#"`<>|:%]/g
/** A timeline line starting with one of these words would be read as the keyword. */
const TIMELINE_KEYWORD = /^(title|section|timeline|acctitle|accdescr)\b/i

type Lit = Set<string>

function escaped(text: string): string {
  return text.replace(/\s+/g, ' ').trim().replace(SYNTAX, char => `#${char.charCodeAt(0)};`) || '…'
}

function label(node: MapNode): string {
  return escaped(node.mark ? `${node.mark} ${node.text}` : node.text)
}

function all(node: MapNode): MapNode[] {
  return [node, ...node.children.flatMap(all)]
}

/** Mermaid names (m0, m1…) in reading order: the app's ids may hold anything. */
function names(root: MapNode): { of: Map<MapNode, string>; byId: Map<string, string> } {
  const of = new Map<MapNode, string>()
  const byId = new Map<string, string>()
  for (const node of all(root)) {
    const name = `m${of.size}`
    of.set(node, name)
    if (!byId.has(node.id)) byId.set(node.id, name)
  }
  return { of, byId }
}

function classLines(root: MapNode, of: Map<MapNode, string>, lit: Lit): string[] {
  const named = all(root)
    .filter(node => lit.has(node.id))
    .map(node => of.get(node))
  return named.length ? [`  class ${named.join(',')} ${HIGHLIGHT_CLASS}`] : []
}

function box(node: MapNode, root: MapNode): string {
  return node === root ? `(["${label(node)}"])` : `["${label(node)}"]`
}

function radial(root: MapNode, lit: Lit): string[] {
  const lines = ['mindmap']
  let count = 0
  const draw = (node: MapNode, depth: number) => {
    const pad = '  '.repeat(depth + 1)
    const name = `m${count++}`
    lines.push(depth ? `${pad}${name}("${label(node)}")` : `${pad}${name}(("${label(node)}"))`)
    if (lit.has(node.id)) lines.push(`${pad}:::${HIGHLIGHT_CLASS}`)
    node.children.forEach(child => draw(child, depth + 1))
  }
  draw(root, 0)
  return lines
}

function tree(root: MapNode, lit: Lit): string[] {
  const { of } = names(root)
  const nodes = all(root)
  return [
    'flowchart LR',
    ...nodes.map(node => `  ${of.get(node)}${box(node, root)}`),
    ...nodes.flatMap(node => node.children.map(child => `  ${of.get(node)} --> ${of.get(child)}`)),
    ...classLines(root, of, lit),
  ]
}

function flow(root: MapNode, lit: Lit): string[] {
  const { of, byId } = names(root)
  const boxed = (node: MapNode) => node !== root && Boolean(node.group) && node.children.length > 0
  // Every node is declared inside its group's subgraph before any arrow, so an arrow never pulls it out.
  const declare = (node: MapNode, pad: string): string[] =>
    boxed(node)
      ? [`${pad}subgraph ${of.get(node)}["${label(node)}"]`, ...node.children.flatMap(child => declare(child, `${pad}  `)), `${pad}end`]
      : [`${pad}${of.get(node)}${box(node, root)}`, ...node.children.flatMap(child => declare(child, pad))]
  const nodes = all(root)
  const arrows = nodes.filter(node => !boxed(node)).flatMap(node => node.children.map(child => `  ${of.get(node)} --> ${of.get(child)}`))
  const links = nodes.flatMap(node =>
    (node.links ?? []).flatMap(link => {
      const target = byId.get(link.to)
      if (!target || target === of.get(node)) return []
      return [`  ${of.get(node)} -.->${link.label?.trim() ? `|"${escaped(link.label)}"|` : ''} ${target}`]
    }),
  )
  return ['flowchart LR', ...declare(root, '  '), ...arrows, ...links, ...classLines(root, of, lit)]
}

function timeline(root: MapNode, lit: Lit): string[] {
  const said = (node: MapNode) => (lit.has(node.id) ? `${TIMELINE_HIGHLIGHT} ` : '') + label(node)
  const period = (node: MapNode) => {
    const text = said(node)
    return TIMELINE_KEYWORD.test(text) ? `#${text.codePointAt(0)};${text.slice(1)}` : text
  }
  const below = (node: MapNode): MapNode[] => node.children.flatMap(child => [child, ...below(child)])
  const moment = (node: MapNode, pad: string) => [`${pad}${period(node)}`, ...below(node).map(event => `${pad}  : ${said(event)}`)]
  const sectioned = root.children.length > 0 && root.children.every(child => child.group)
  const body = sectioned ? root.children.flatMap(section => [`  section ${said(section)}`, ...section.children.flatMap(node => moment(node, '    '))]) : root.children.flatMap(node => moment(node, '  '))
  return ['timeline', `  title ${said(root)}`, ...body]
}

const DRAWERS: Record<MapForm, (root: MapNode, lit: Lit) => string[]> = { radial, arvore: tree, fluxo: flow, 'linha-do-tempo': timeline }

/** The map as Mermaid code; `highlight` holds the ids of the nodes that should blink. */
export function mapToMermaid(diagram: MapDiagram, highlight: string[] = []): string {
  return (DRAWERS[diagram.form] ?? radial)(diagram.root, new Set(highlight)).join('\n')
}
