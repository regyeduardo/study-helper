/** "▸" and the time stay on one line: a minute link never breaks between them. */
const NO_BREAK = ' '

const SECTION = /^##\s/
const PLAIN_LINE = /^(?![\s#>*+\-|<!`]|\d+[.)]\s)\S/

/** The header of a model Ata (date and duration, then the participants) is written on two lines of one paragraph; before the first section each line gets its own. */
function breakHeader(markdown: string): string {
  const lines = markdown.split('\n')
  const first = lines.findIndex(line => SECTION.test(line))
  const header = first < 0 ? lines.length : first
  return lines.map((line, at) => (at + 1 < header && PLAIN_LINE.test(line) && PLAIN_LINE.test(lines[at + 1]) ? `${line}  ` : line)).join('\n')
}

/**
 * The Ata as the reader shows it. The Ata models write the minute as plain "[mm:ss]" (the method's own form), which
 * would be text that does nothing: it becomes the same play link as the "[▸ mm:ss](#t=…)" of the standard Ata. The
 * link keeps "▸" and the time together, and the arrow of "Descartado na reunião" goes with the minute after it.
 * Nothing is saved: old Atas read the same way.
 */
export function forReading(markdown: string): string {
  return breakHeader(markdown)
    .replace(/\[(\d{1,3}):(\d{2})\](?!\()/g, (_all, minutes: string, seconds: string) => `[▸ ${minutes.padStart(2, '0')}:${seconds}](#t=${Number(minutes) * 60 + Number(seconds)})`)
    .replace(/\[▸ (\d{1,3}:\d{2})\]\(#t=/g, `[▸${NO_BREAK}$1](#t=`)
    .replace(/→ \[▸/g, `→${NO_BREAK}[▸`)
}
