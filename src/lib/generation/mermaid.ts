export const DIAGRAM_TYPES = ['flowchart', 'sequence', 'class', 'state', 'pie', 'gantt', 'mindmap'] as const

export type DiagramType = (typeof DIAGRAM_TYPES)[number]

type Data = Record<string, unknown>

const FLOWCHART_SHAPES: Record<string, [string, string]> = {
  rounded: ['(', ')'],
  stadium: ['([', '])'],
  diam: ['{', '}'],
  circle: ['((', '))'],
  cyl: ['[(', ')]'],
  hex: ['{{', '}}'],
  parallelogram: ['[/', '/]'],
}

const LINK_STYLES: Record<string, string> = { dotted: '-.->', thick: '==>', invisible: '~~~' }

const SEQUENCE_ARROWS: Record<string, string> = { solid: '->>', dashed: '-->>', dotted: '-x', async: '->)' }

const CLASS_RELATIONS: Record<string, string> = {
  inheritance: '--|>',
  composition: '--*',
  aggregation: '--o',
  association: '-->',
}

export class DiagramError extends Error {}

function text(value: unknown): string {
  if (value === null || value === undefined) return ''
  return String(value)
}

function list(value: unknown): Data[] {
  return Array.isArray(value) ? (value as Data[]) : []
}

function cleanLabel(value: unknown): string {
  return text(value).replaceAll('(', ' ').replaceAll(')', ' ').replaceAll('"', "'").trim()
}

export function extractJson(raw: string): Data | null {
  let stripped = raw.trim()
  if (stripped.startsWith('```')) {
    stripped = stripped.replace(/^```[a-zA-Z]*\n?/, '').replace(/```$/, '').trim()
  }
  const start = stripped.indexOf('{')
  if (start < 0) return null
  let depth = 0
  for (let index = start; index < stripped.length; index++) {
    const char = stripped[index]
    if (char === '{') depth++
    else if (char === '}') {
      depth--
      if (depth === 0) {
        try {
          return JSON.parse(stripped.slice(start, index + 1)) as Data
        } catch {
          return null
        }
      }
    }
  }
  return null
}

function flowchartNode(node: Data): string {
  const id = text(node.id).trim()
  if (!id) throw new DiagramError('nó de flowchart sem id')
  const [open, close] = FLOWCHART_SHAPES[text(node.shape).toLowerCase()] ?? ['[', ']']
  return `${id}${open}"${cleanLabel(node.text || id)}"${close}`
}

function flowchartLink(link: Data, prefix = ''): string {
  const source = `${prefix}${text(link.from).trim()}`
  const target = `${prefix}${text(link.to).trim()}`
  if (!source.trim() || !target.trim()) throw new DiagramError('ligação de flowchart sem origem ou destino')
  const arrow = text(link.head).toLowerCase() === 'none' ? '---' : (LINK_STYLES[text(link.shape).toLowerCase()] ?? '-->')
  if (link.text && arrow !== '~~~') return `${source} ${arrow}|${cleanLabel(link.text)}| ${target}`
  return `${source} ${arrow} ${target}`
}

function flowchartSubgraph(subgraph: Data, parentPrefix: string): string[] {
  const id = text(subgraph.id).trim()
  if (!id) throw new DiagramError('subgraph sem id')
  const prefix = `${parentPrefix}${id}_`
  const lines = [`subgraph ${id}[${cleanLabel(subgraph.title || id)}]`]
  for (const node of list(subgraph.nodes)) {
    if (typeof node !== 'object' || node === null) throw new DiagramError('nó de subgraph precisa ser um objeto')
    lines.push(flowchartNode({ ...node, id: `${prefix}${text(node.id)}` }))
  }
  for (const link of list(subgraph.links)) lines.push(flowchartLink(link, prefix))
  for (const child of list(subgraph.children)) lines.push(...flowchartSubgraph(child, prefix))
  lines.push('end')
  return lines
}

function flowchart(data: Data): string {
  const nodes = list(data.nodes)
  if (!nodes.length) throw new DiagramError('flowchart sem nós')
  let direction = text(data.direction || 'TD').toUpperCase()
  if (!['TD', 'TB', 'LR', 'RL', 'BT'].includes(direction)) direction = 'TD'
  const lines = [`flowchart ${direction}`]
  lines.push(...nodes.map(flowchartNode))
  lines.push(...list(data.links).map(link => flowchartLink(link)))
  for (const subgraph of list(data.subgraphs)) lines.push(...flowchartSubgraph(subgraph, ''))
  return lines.join('\n')
}

function sequence(data: Data): string {
  const actors = list(data.actors)
  if (!actors.length) throw new DiagramError('sequence sem atores')
  const lines = ['sequenceDiagram']
  if (data.autonumber) lines.push('    autonumber')
  for (const actor of actors) {
    const id = text(actor.id).trim()
    if (!id) throw new DiagramError('ator de sequence sem id')
    const keyword = text(actor.type).toLowerCase() === 'actor' ? 'actor' : 'participant'
    const name = actor.name
    lines.push(name && name !== id ? `    ${keyword} ${id} as ${cleanLabel(name)}` : `    ${keyword} ${id}`)
  }
  for (const message of list(data.messages)) {
    const source = text(message.from).trim()
    const target = text(message.to).trim()
    if (!source || !target) throw new DiagramError('mensagem de sequence sem origem ou destino')
    const arrow = SEQUENCE_ARROWS[text(message.type).toLowerCase()] ?? '->>'
    lines.push(`    ${source}${arrow}${target}: ${cleanLabel(message.text)}`)
  }
  return lines.join('\n')
}

function classDiagram(data: Data): string {
  const classes = list(data.classes)
  if (!classes.length) throw new DiagramError('class diagram sem classes')
  let direction = text(data.direction || 'TB').toUpperCase()
  if (!['TB', 'LR', 'RL', 'BT'].includes(direction)) direction = 'TB'
  const lines = ['classDiagram', `direction ${direction}`]
  for (const item of classes) {
    const name = text(item.name).trim()
    if (!name) throw new DiagramError('classe sem nome')
    const body: string[] = []
    for (const member of list(item.members)) {
      const visibility = text(member.visibility) || '+'
      body.push(`    ${visibility}${text(member.type)} ${text(member.name)}`.trimEnd())
    }
    for (const method of list(item.methods)) {
      const visibility = text(method.visibility) || '+'
      const params = list(method.parameters)
        .map(param => `${text(param.type)} ${text(param.name)}`.trim())
        .join(', ')
      const returnType = text(method.return_type)
      body.push(`    ${visibility}${text(method.name)}(${params})${returnType ? ` ${returnType}` : ''}`)
    }
    if (body.length) lines.push(`class ${name} {`, ...body, '}')
    else lines.push(`class ${name}`)
  }
  for (const relation of list(data.relations)) {
    const source = text(relation.from).trim()
    const target = text(relation.to).trim()
    if (!source || !target) throw new DiagramError('relação de classe sem origem ou destino')
    const arrow = CLASS_RELATIONS[text(relation.type).toLowerCase()] ?? '-->'
    lines.push(relation.label ? `${source} ${arrow} ${target} : ${cleanLabel(relation.label)}` : `${source} ${arrow} ${target}`)
  }
  return lines.join('\n')
}

function stateDiagram(data: Data): string {
  const states = list(data.states)
  if (!states.length) throw new DiagramError('state diagram sem estados')
  const lines = ['stateDiagram-v2']
  const known = new Set<string>()
  for (const state of states) {
    const id = text(state.id).trim()
    if (!id) throw new DiagramError('estado sem id')
    known.add(id)
    lines.push(state.description ? `    ${id} : ${cleanLabel(state.description)}` : `    ${id}`)
  }
  for (const transition of list(data.transitions)) {
    const source = text(transition.from).trim()
    const target = text(transition.to).trim()
    if (!known.has(source) || !known.has(target)) continue
    lines.push(transition.description ? `    ${source} --> ${target} : ${cleanLabel(transition.description)}` : `    ${source} --> ${target}`)
  }
  return lines.join('\n')
}

function pie(data: Data): string {
  const entries = list(data.data)
  if (!entries.length) throw new DiagramError('pie sem dados')
  const lines = data.title ? [`pie title ${cleanLabel(data.title)}`] : ['pie']
  for (const entry of entries) {
    if (typeof entry.value !== 'number') throw new DiagramError('valor de pie precisa ser numérico')
    lines.push(`    "${cleanLabel(entry.label)}" : ${entry.value}`)
  }
  return lines.join('\n')
}

function gantt(data: Data): string {
  const sections = list(data.sections)
  if (!sections.length) throw new DiagramError('gantt sem seções')
  const lines = ['gantt']
  if (data.title) lines.push(`    title ${cleanLabel(data.title)}`)
  lines.push(`    dateFormat ${text(data.dateLine) || 'YYYY-MM-DD'}`)
  for (const section of sections) {
    lines.push(`    section ${cleanLabel(section.name)}`)
    for (const task of list(section.tasks)) {
      const status = text(task.status).toLowerCase()
      const prefix = ['done', 'active', 'crit', 'milestone'].includes(status) ? `${status}, ` : ''
      const start = text(task.start)
      const end = text(task.end) || '1d'
      const description = cleanLabel(task.desc)
      lines.push(task.id ? `    ${description} : ${prefix}${text(task.id)}, ${start}, ${end}` : `    ${description} : ${prefix}${start}, ${end}`)
    }
  }
  return lines.join('\n')
}

function mindmap(data: Data): string {
  const root = text(data.root).trim()
  if (!root) throw new DiagramError('mindmap sem raiz')
  const lines = ['mindmap', `\troot((${cleanLabel(root)}))`]
  for (const node of list(data.nodes)) {
    const level = node.level
    if (typeof level !== 'number' || !Number.isInteger(level) || level < 1) throw new DiagramError('nó de mindmap precisa de level inteiro >= 1')
    lines.push('\t'.repeat(level + 1) + cleanLabel(node.text))
  }
  return lines.join('\n')
}

const GENERATORS: Record<DiagramType, (data: Data) => string> = {
  flowchart,
  sequence,
  class: classDiagram,
  state: stateDiagram,
  pie,
  gantt,
  mindmap,
}

export function generateDiagram(type: string, data: unknown): string {
  const generator = GENERATORS[text(type).toLowerCase() as DiagramType]
  if (!generator) throw new DiagramError(`tipo de diagrama não suportado: ${type}`)
  if (typeof data !== 'object' || data === null || Array.isArray(data)) throw new DiagramError('dados do diagrama precisam ser um objeto JSON')
  return generator(data as Data)
}
