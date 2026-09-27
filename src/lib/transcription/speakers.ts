import type { Segment, SpeakerTurn } from '@/lib/transcription/types'

function speakerOf(start: number, end: number, turns: SpeakerTurn[]): string {
  const time = new Map<string, number>()
  for (const turn of turns) {
    const overlap = Math.min(end, turn.end) - Math.max(start, turn.start)
    if (overlap > 0) time.set(turn.speaker, (time.get(turn.speaker) ?? 0) + overlap)
  }
  let best = ''
  let most = 0
  for (const [speaker, seconds] of time) {
    if (seconds > most) {
      best = speaker
      most = seconds
    }
  }
  return best
}

export function withSpeakers(segments: Segment[], turns: SpeakerTurn[]): string {
  const texts = segments.map(segment => segment.text).filter(Boolean)
  if (!turns.length) return texts.join(' ').trim()
  const lines: string[] = []
  let current = ''
  for (const segment of segments) {
    if (!segment.text) continue
    const speaker = speakerOf(segment.start, segment.end, turns) || current || 'Falante ?'
    if (speaker === current) lines[lines.length - 1] = `${lines[lines.length - 1]} ${segment.text}`
    else {
      lines.push(`${speaker}: ${segment.text}`)
      current = speaker
    }
  }
  return lines.join('\n').trim()
}
