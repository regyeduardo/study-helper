import type { Word } from '@/lib/transcription/types'

const SAME = 2
const ALIKE = 1
const OTHER = -1
const GAP = -1
const SECONDS_PER_WORD = 0.35
const KEPT_RUN = 5
const RUN_PAUSE_SECONDS = 1.5

const DIAGONAL = 1
const UP = 2
const LEFT = 3

function plain(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')
}

function similarity(a: string, b: string): number {
  if (a === b) return 1
  if (!a || !b) return 0
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index)
  for (let i = 1; i <= a.length; i++) {
    const current = [i]
    for (let j = 1; j <= b.length; j++) current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1))
    previous = current
  }
  return 1 - previous[b.length] / Math.max(a.length, b.length)
}

function score(a: string, b: string): number {
  if (a === b) return SAME
  return similarity(a, b) >= 0.5 ? ALIKE : OTHER
}

function repeats(run: Word[]): boolean {
  const kinds = new Set(run.map(word => plain(word.text)))
  return kinds.size * 2 <= run.length
}

/**
 * Puts the words of a text-only transcription (better words, no times) on the timeline of a
 * timed one. Timed words nobody else heard are dropped, unless it is a long, varied stretch.
 */
export function alignWords(timed: Word[], text: string, from: number, to: number): Word[] {
  const said = text.split(/\s+/).filter(token => plain(token))
  if (!said.length) return timed
  const a = timed.map(word => plain(word.text))
  const b = said.map(plain)
  const rows = a.length + 1
  const columns = b.length + 1
  const best = new Int32Array(rows * columns)
  const step = new Uint8Array(rows * columns)
  for (let i = 1; i < rows; i++) (best[i * columns] = i * GAP), (step[i * columns] = UP)
  for (let j = 1; j < columns; j++) (best[j] = j * GAP), (step[j] = LEFT)
  for (let i = 1; i < rows; i++) {
    for (let j = 1; j < columns; j++) {
      const diagonal = best[(i - 1) * columns + j - 1] + score(a[i - 1], b[j - 1])
      const up = best[(i - 1) * columns + j] + GAP
      const left = best[i * columns + j - 1] + GAP
      const top = Math.max(diagonal, up, left)
      best[i * columns + j] = top
      step[i * columns + j] = top === diagonal ? DIAGONAL : top === up ? UP : LEFT
    }
  }
  const pairs: [number | null, number | null][] = []
  for (let i = a.length, j = b.length; i > 0 || j > 0; ) {
    const move = step[i * columns + j]
    if (move === DIAGONAL) pairs.push([--i, --j])
    else if (move === UP) pairs.push([--i, null])
    else pairs.push([null, --j])
  }
  pairs.reverse()

  const out: (Word | { text: string })[] = []
  let alone: Word[] = []
  const flush = () => {
    let stretch: Word[] = []
    const keep = () => {
      if (stretch.length >= KEPT_RUN && !repeats(stretch)) out.push(...stretch)
      stretch = []
    }
    for (const word of alone) {
      if (stretch.length && word.start - stretch[stretch.length - 1].end > RUN_PAUSE_SECONDS) keep()
      stretch.push(word)
    }
    keep()
    alone = []
  }
  for (const [i, j] of pairs) {
    if (j === null) {
      alone.push(timed[i!])
      continue
    }
    flush()
    out.push(i === null ? { text: said[j] } : { start: timed[i].start, end: timed[i].end, text: said[j] })
  }
  flush()

  const words: Word[] = []
  for (let index = 0; index < out.length; index++) {
    const item = out[index]
    if ('start' in item) {
      words.push(item)
      continue
    }
    const after = out.slice(index).find((next): next is Word => 'start' in next)
    const begin = words.length ? words[words.length - 1].end : from
    const limit = after ? after.start : to
    const waiting = out.slice(index, after ? out.indexOf(after) : out.length).length
    const length = Math.max(0, Math.min(SECONDS_PER_WORD, (limit - begin) / waiting))
    words.push({ start: begin, end: begin + length, text: item.text })
  }
  return words
}
