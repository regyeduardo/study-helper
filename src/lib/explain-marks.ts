// As explicações de uma nota, marcadas no texto dela: o primeiro lugar em que o trecho aparece fica forte,
// as repetições ficam fracas, e a cor segue a ordem em que os trechos aparecem.

export interface ExplainedQuote {
  quote: string
  id: string
  /** The explanation's name, shown when the mouse rests on the mark. */
  title?: string
  generating?: boolean
}

/** How many colors the marks take turns on: `--ex-<n>-strong`, `--ex-<n>-soft`, `--ex-<n>-weak`. */
export const EXPLAIN_COLORS = 6

const SKIP = 'pre, code, mark, a, .ex-loading'

interface Group {
  key: string
  pattern: RegExp
  ids: string[]
  titles: string[]
  generating: boolean
}

interface Hit {
  node: number
  start: number
  end: number
  group: Group
  /** Written just as the passage was selected (same case): where the explanation was most likely asked. */
  exact: boolean
}

/** The part of the passage looked for: its first paragraph, as one line (a section's explanation starts with its heading). */
function keyOf(quote: string): string {
  return (quote.trim().split(/\n\s*\n/)[0] ?? '').split(/\s+/).filter(Boolean).join(' ')
}

function patternOf(key: string): RegExp {
  return new RegExp(key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/ /g, '\\s+'), 'giu')
}

const overlaps = (a: Hit, b: Hit) => a.node === b.node && a.start < b.end && b.start < a.end
const before = (a: Hit, b: Hit) => a.node - b.node || a.start - b.start

function wrap(node: Text, start: number, end: number): HTMLElement {
  const middle = node.splitText(start)
  middle.splitText(end - start)
  const mark = document.createElement('mark')
  mark.textContent = middle.data
  middle.replaceWith(mark)
  return mark
}

/** Marks every explained passage in the text; one mark carries the ids of all the explanations made of the same passage. */
export function markExplanations(container: HTMLElement, quotes: ExplainedQuote[]): void {
  const groups = new Map<string, Group>()
  for (const quote of quotes) {
    const key = keyOf(quote.quote)
    if (key.length < 3) continue
    const id = key.toLocaleLowerCase('pt-BR')
    const group = groups.get(id) ?? { key, pattern: patternOf(key), ids: [], titles: [], generating: false }
    group.ids.push(quote.id)
    if (quote.title) group.titles.push(quote.title)
    group.generating ||= Boolean(quote.generating)
    groups.set(id, group)
  }
  if (!groups.size) return

  const nodes: Text[] = []
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT)
  while (walker.nextNode()) {
    const node = walker.currentNode as Text
    if (!node.parentElement?.closest(SKIP)) nodes.push(node)
  }
  const hits: Hit[] = []
  nodes.forEach((node, index) => {
    for (const group of groups.values())
      for (const match of node.data.matchAll(group.pattern)) if (match[0]) hits.push({ node: index, start: match.index, end: match.index + match[0].length, group, exact: match[0].split(/\s+/).join(' ') === group.key })
  })
  hits.sort(before)

  // The strong mark: where each passage first shows up as it was selected, in reading order, without stepping on another one.
  const chosen: Hit[] = []
  const strong = new Map<Group, Hit>()
  for (const group of new Set(hits.map(hit => hit.group))) {
    const free = hits.filter(hit => hit.group === group && !chosen.some(other => overlaps(hit, other)))
    const place = free.find(hit => hit.exact) ?? free[0]
    if (!place) continue
    strong.set(group, place)
    chosen.push(place)
  }
  const color = new Map([...strong.values()].sort(before).map((hit, index) => [hit.group, index % EXPLAIN_COLORS]))
  // The repetitions, the longest first when two would cross.
  for (const hit of [...hits].sort((a, b) => b.end - b.start - (a.end - a.start) || before(a, b))) {
    if (color.has(hit.group) && !chosen.some(other => overlaps(hit, other))) chosen.push(hit)
  }

  // From the end of each text node, so each split leaves the earlier positions where they were.
  for (const hit of chosen.sort((a, b) => before(b, a))) {
    const isStrong = strong.get(hit.group) === hit
    const tone = color.get(hit.group)!
    const mark = wrap(nodes[hit.node], hit.start, hit.end)
    mark.className = `ex-mark ${isStrong ? 'ex-strong' : 'ex-weak'}`
    mark.dataset.quote = 'true'
    mark.dataset.ids = hit.group.ids.join(',')
    mark.setAttribute('style', isStrong ? `--ex: var(--ex-${tone}-strong); --exbg: var(--ex-${tone}-soft)` : `--ex: var(--ex-${tone}-weak)`)
    mark.title = hit.group.ids.length > 1 ? `${hit.group.ids.length} explicações neste trecho` : (hit.group.titles[0] ?? 'Abrir a explicação')
    if (isStrong && hit.group.generating) {
      const loading = document.createElement('span')
      loading.className = 'ex-loading'
      loading.dataset.quote = 'true'
      loading.setAttribute('role', 'status')
      loading.textContent = 'gerando explicação…'
      mark.after(loading)
    }
  }
}
