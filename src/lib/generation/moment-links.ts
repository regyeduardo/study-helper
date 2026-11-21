import { clockTime } from '@/lib/transcription/export'

/** "▸" and the time stay on one line. */
const NO_BREAK = ' '
/** "01:40", "1:02:03": hours (up to 2 digits) and minutes (up to 3) as the transcript writes them. */
const TIME = String.raw`(?:\d{1,2}:)?\d{1,3}:\d{2}`
const DASH = String.raw`[ \t]*[\u2013\u2014-][ \t]*`
/** A time, or a range of two; brackets around it are taken too. Not part of a longer number ("3.01:40", "12:123"). */
const SPAN = new RegExp(String.raw`(\[)?(?<![\d:.])(${TIME})(?:(${DASH})(${TIME}))?(?![\d:])(\])?`, 'g')
/** What is never read as a time: code in the line, a link already made or an image, a tag or <autolink>, an address. */
const LEFT_ALONE = /`[^`\n]*`|!?\[[^\]\n]*\]\([^)\n]*\)|<[a-zA-Z/][^>\n]*>|(?:https?:\/\/|www\.)[^\s<>)\]]+/g
const FENCE = /^\s{0,3}(`{3,}|~{3,})/
const PARSE = /^(?:(\d{1,2}):)?(\d{1,3}):(\d{2})$/

export type MomentPiece = string | { at: number }

/** The second of "01:40" / "1:02:03"; null for an impossible time ("01:75") or one past the end of the media (`limit`, in seconds). */
function secondOf(time: string, limit?: number): number | null {
  const found = PARSE.exec(time)
  if (!found) return null
  const [, hours, minutes, seconds] = found
  if (Number(seconds) > 59 || (hours !== undefined && Number(minutes) > 59)) return null
  const at = Number(hours ?? 0) * 3600 + Number(minutes) * 60 + Number(seconds)
  return limit !== undefined && at > Math.ceil(limit) ? null : at
}

/** Text between two moments; it joins the text beside it. */
function push(pieces: MomentPiece[], piece: MomentPiece): void {
  const last = pieces.at(-1)
  if (typeof piece === 'string') {
    if (!piece) return
    if (typeof last === 'string') pieces[pieces.length - 1] = last + piece
    else pieces.push(piece)
  } else pieces.push(piece)
}

function readPlain(text: string, limit: number | undefined, pieces: MomentPiece[]): void {
  let from = 0
  for (const found of text.matchAll(SPAN)) {
    const [all, open, first, dash, second, close] = found
    const start = found.index
    const one = secondOf(first, limit)
    const two = second ? secondOf(second, limit) : null
    // nothing there to link: it stays as it was written
    if (one === null && two === null) continue
    push(pieces, text.slice(from, start))
    // "[01:40]" is the link itself; around a time that stays text, or a range cut short, the brackets stay
    const whole = Boolean(open && close) && one !== null && (!second || two !== null)
    push(pieces, open && !whole ? '[' : '')
    push(pieces, one === null ? first : { at: one })
    if (second) {
      push(pieces, dash)
      push(pieces, two === null ? second : { at: two })
    }
    push(pieces, close && !whole ? ']' : '')
    from = start + all.length
  }
  push(pieces, text.slice(from))
}

/** A line or a text, cut into plain text and the moments in it that can be played. */
export function momentPieces(text: string, limit?: number): MomentPiece[] {
  const pieces: MomentPiece[] = []
  let from = 0
  for (const kept of text.matchAll(LEFT_ALONE)) {
    readPlain(text.slice(from, kept.index), limit, pieces)
    push(pieces, kept[0])
    from = kept.index + kept[0].length
  }
  readPlain(text.slice(from), limit, pieces)
  return pieces
}

const playLink = (at: number) => `[▸${NO_BREAK}${clockTime(at)}](#t=${at})`

/**
 * A reply of the Tutor or of the Chat cites a moment of the media: "[01:40]", "em 01:40", "aos 1:02:03", "(12:05)" or a range
 * "01:40–02:10". Each one becomes the same play link as the Ata's ("[▸ 01:40](#t=100)"). A link already made, an impossible time,
 * a time past the end of the media (`limit`, in seconds) and code (a block or in the line) stay as they are.
 */
export function momentLinks(markdown: string, limit?: number): string {
  let fence: string | null = null
  return markdown
    .split('\n')
    .map(line => {
      const marker = FENCE.exec(line)?.[1]
      if (fence === null && marker) {
        fence = marker
        return line
      }
      if (fence !== null) {
        if (marker && marker[0] === fence[0] && marker.length >= fence.length && line.trim() === marker) fence = null
        return line
      }
      return momentPieces(line, limit)
        .map(piece => (typeof piece === 'string' ? piece : playLink(piece.at)))
        .join('')
    })
    .join('\n')
}
