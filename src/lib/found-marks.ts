// O trecho achado pela busca, na nota aberta (FR-074): o termo marcado no parágrafo que tem todas as palavras.
import { fold, searchWords } from '@/lib/library-search'

const BLOCKS = 'p, li, h1, h2, h3, h4, h5, h6, td, th, blockquote, dd, dt, pre'

/** Takes the marks of an earlier search out. */
export function clearFound(container: HTMLElement): void {
  for (const mark of Array.from(container.querySelectorAll('mark[data-found]'))) {
    const parent = mark.parentNode
    if (!parent) continue
    parent.replaceChild(document.createTextNode(mark.textContent ?? ''), mark)
    parent.normalize()
  }
}

/** The innermost block with the most of the words, the first one when tied; null when none has any. */
function blockOf(container: HTMLElement, words: string[]): HTMLElement | null {
  let best: HTMLElement | null = null
  let most = 0
  for (const block of Array.from(container.querySelectorAll<HTMLElement>(BLOCKS))) {
    if (block.querySelector(BLOCKS)) continue
    const text = fold(block.textContent ?? '')
    const count = words.filter(word => text.includes(word)).length
    if (count === words.length) return block
    if (count > most) [best, most] = [block, count]
  }
  return best
}

function markIn(block: HTMLElement, words: string[]): void {
  const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT)
  const nodes: Text[] = []
  while (walker.nextNode()) nodes.push(walker.currentNode as Text)
  for (const node of nodes) {
    const folded = fold(node.data)
    const marked = new Array<boolean>(folded.length).fill(false)
    for (const word of words) for (let at = folded.indexOf(word); at >= 0; at = folded.indexOf(word, at + word.length)) marked.fill(true, at, at + word.length)
    // from the end, so each split leaves the earlier positions where they were
    for (let end = marked.length; end > 0; ) {
      if (!marked[end - 1]) {
        end--
        continue
      }
      let start = end - 1
      while (start > 0 && marked[start - 1]) start--
      const middle = node.splitText(start)
      middle.splitText(end - start)
      const mark = document.createElement('mark')
      mark.className = 'hl-found'
      mark.dataset.found = 'true'
      mark.textContent = middle.data
      middle.parentNode?.replaceChild(mark, middle)
      end = start
    }
  }
}

/** Marks the words of the search in the block that has them; returns that block, to scroll to, or null. */
export function markFound(container: HTMLElement, query: string): HTMLElement | null {
  clearFound(container)
  const words = searchWords(query)
  if (!words.length) return null
  const block = blockOf(container, words)
  if (block) markIn(block, words)
  return block
}
