import type { RecordingData, RecordingSpeaker, TranscriptBlock } from '@/types/domain'
import { AUDIBLE_LEVEL, loudness } from '@/lib/transcription/audio'
import type { SpeakerTurn, Word } from '@/lib/transcription/types'

export const MICROPHONE = 'mic'
const MICROPHONE_NAME = 'Você'
const MICROPHONE_DOMINANCE = 2
const PARAGRAPH_PAUSE_SECONDS = 2
const PARAGRAPH_SECONDS = 30

export interface RecordingChannels {
  microphone: Float32Array
  computer: Float32Array
}

export type WordTest = (word: Word) => boolean

function distance(word: Word, turn: SpeakerTurn): number {
  return Math.max(turn.start - word.end, word.start - turn.end, 0)
}

function speakerOf(word: Word, turns: SpeakerTurn[]): string {
  let best = ''
  let most = 0
  for (const turn of turns) {
    const overlap = Math.min(word.end, turn.end) - Math.max(word.start, turn.start)
    if (overlap > most) {
      best = turn.speaker
      most = overlap
    }
  }
  if (best || !turns.length) return best
  return turns.reduce((nearest, turn) => (distance(word, turn) < distance(word, nearest) ? turn : nearest)).speaker
}

export function microphoneWords(channels: RecordingChannels): WordTest {
  if (!channels.computer.some(sample => Math.abs(sample) >= AUDIBLE_LEVEL)) return () => false
  return word => {
    const microphone = loudness(channels.microphone, word.start, word.end)
    return microphone >= AUDIBLE_LEVEL && microphone > loudness(channels.computer, word.start, word.end) * MICROPHONE_DOMINANCE
  }
}

export function speakersOf(blocks: TranscriptBlock[]): RecordingSpeaker[] {
  const ids = [...new Set(blocks.map(block => block.speaker).filter(Boolean))]
  return ids.map((id, index) => ({
    id,
    name: id === MICROPHONE ? MICROPHONE_NAME : `Falante ${index + 1}`,
    suggested: false,
  }))
}

export function blocksFromWords(words: Word[], turns: SpeakerTurn[], fromMicrophone: WordTest = () => false): TranscriptBlock[] {
  const blocks: TranscriptBlock[] = []
  for (const word of words) {
    const text = word.text.trim()
    if (!text) continue
    const speaker = fromMicrophone(word) ? MICROPHONE : speakerOf(word, turns)
    const last = blocks[blocks.length - 1]
    const sameParagraph = last && !(/[.!?…]$/.test(last.text) && (word.start - last.end >= PARAGRAPH_PAUSE_SECONDS || last.end - last.start >= PARAGRAPH_SECONDS))
    if (last && last.speaker === speaker && sameParagraph) {
      last.text = `${last.text} ${text}`
      last.end = word.end
    } else blocks.push({ speaker, start: word.start, end: word.end, text })
  }
  return blocks
}

export function renameSpeaker(recording: RecordingData, id: string, name: string): RecordingData {
  return { ...recording, speakers: recording.speakers.map(speaker => (speaker.id === id ? { ...speaker, name, suggested: false } : speaker)) }
}

export function renameInText(text: string, from: string, to: string): string {
  const literal = from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const name = new RegExp(`(?<![\\p{L}\\p{N}])${literal}(?![\\p{L}\\p{N}])`, 'gu')
  return text
    .split('\n')
    .map(line => (/^\s*>/.test(line) ? line : line.replace(name, () => to)))
    .join('\n')
}
