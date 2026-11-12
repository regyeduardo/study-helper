import { clockTime } from '@/lib/transcription/export'

/** "▸" and the time stay on one line. */
const NO_BREAK = ' '
const MOMENT = /\[(?:(\d{1,2}):)?(\d{1,3}):(\d{2})\](?!\()/g
const FENCE = /^\s*(```|~~~)/

/**
 * A reply of the Tutor or of the Chat cites a moment of the media as "[01:40]" or "[1:02:03]": it becomes the same
 * play link as the Ata's ("[▸ 01:40](#t=100)"). A link already made, an impossible time and code blocks stay as they are.
 */
export function momentLinks(markdown: string): string {
  let code = false
  return markdown
    .split('\n')
    .map(line => {
      if (FENCE.test(line)) {
        code = !code
        return line
      }
      if (code) return line
      return line.replace(MOMENT, (all, hours: string | undefined, minutes: string, seconds: string) => {
        if (Number(seconds) > 59 || (hours !== undefined && Number(minutes) > 59)) return all
        const at = Number(hours ?? 0) * 3600 + Number(minutes) * 60 + Number(seconds)
        return `[▸${NO_BREAK}${clockTime(at)}](#t=${at})`
      })
    })
    .join('\n')
}
