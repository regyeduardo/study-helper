import type { RecordingData, RecordingSpeaker, TranscriptBlock } from '@/types/domain'
import { AUDIBLE_LEVEL, loudness } from '@/lib/transcription/audio'
import type { SpeakerTurn, Word } from '@/lib/transcription/types'

export const MICROPHONE = 'mic'
/** The microphone voice when the name of who recorded is not known yet: never "Você". */
export const RECORDER = 'Quem gravou'
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

export function computerWords(channels: RecordingChannels): WordTest {
  if (!channels.computer.some(sample => Math.abs(sample) >= AUDIBLE_LEVEL)) return () => false
  return word => {
    const computer = loudness(channels.computer, word.start, word.end)
    return computer >= AUDIBLE_LEVEL && computer > loudness(channels.microphone, word.start, word.end)
  }
}

function microphoneSpeakers(words: Word[], turns: SpeakerTurn[], fromMicrophone: WordTest, fromComputer: WordTest): Set<string> {
  const count = new Map<string, { microphone: number; mine: number; theirs: number }>()
  for (const word of words) {
    const speaker = speakerOf(word, turns)
    const tally = count.get(speaker) ?? { microphone: 0, mine: 0, theirs: 0 }
    if (fromMicrophone(word)) tally.microphone++
    if (fromComputer(word)) tally.theirs++
    else tally.mine++
    count.set(speaker, tally)
  }
  return new Set([...count].filter(([, tally]) => tally.microphone > 0 && tally.mine > tally.theirs).map(([speaker]) => speaker))
}

export function speakersOf(blocks: TranscriptBlock[], recorder = ''): RecordingSpeaker[] {
  const ids = [...new Set(blocks.map(block => block.speaker).filter(Boolean))]
  return ids.map((id, index) => ({
    id,
    name: id === MICROPHONE ? recorder.trim() || RECORDER : `Falante ${index + 1}`,
    suggested: false,
  }))
}

const SPEECH_MARGIN_SECONDS = 0.3

export function wordsInSpeech(words: Word[], turns: SpeakerTurn[]): Word[] {
  if (!turns.length) return words
  return words.filter(word => {
    const middle = (word.start + word.end) / 2
    return turns.some(turn => middle >= turn.start - SPEECH_MARGIN_SECONDS && middle <= turn.end + SPEECH_MARGIN_SECONDS)
  })
}

const STRAY_WORDS = 4
const STRAY_SHARE = 0.3

/** A sentence stays with whoever said most of it: a few words given to someone else in the middle are a slip of the speaker detection. */
function sentenceSpeakers(words: Word[], speakers: string[]): string[] {
  const out = [...speakers]
  let start = 0
  for (let index = 0; index < words.length; index++) {
    if (!/[.!?…]$/.test(words[index].text.trim())) continue
    const count = new Map<string, number>()
    for (let at = start; at <= index; at++) count.set(speakers[at], (count.get(speakers[at]) ?? 0) + 1)
    const [main, most] = [...count].reduce((best, entry) => (entry[1] > best[1] ? entry : best))
    const stray = index + 1 - start - most
    if (stray <= STRAY_WORDS && stray <= (index + 1 - start) * STRAY_SHARE) for (let at = start; at <= index; at++) out[at] = main
    start = index + 1
  }
  return out
}

export function blocksFromWords(words: Word[], turns: SpeakerTurn[], fromMicrophone: WordTest = () => false, fromComputer: WordTest = () => false): TranscriptBlock[] {
  const yours = microphoneSpeakers(words, turns, fromMicrophone, fromComputer)
  const theirs = turns.filter(turn => !yours.has(turn.speaker))
  const sideOf = (word: Word): string => {
    if (fromMicrophone(word)) return MICROPHONE
    const speaker = speakerOf(word, turns)
    if (!yours.has(speaker)) return speaker
    if (!fromComputer(word)) return MICROPHONE
    return theirs.length ? speakerOf(word, theirs) : speaker
  }
  const spoken = words.filter(word => word.text.trim())
  const speakers = sentenceSpeakers(spoken, spoken.map(sideOf))
  const blocks: TranscriptBlock[] = []
  for (const [index, word] of spoken.entries()) {
    const text = word.text.trim()
    const speaker = speakers[index]
    const last = blocks[blocks.length - 1]
    const sameParagraph = last && !(/[.!?…]$/.test(last.text) && (word.start - last.end >= PARAGRAPH_PAUSE_SECONDS || last.end - last.start >= PARAGRAPH_SECONDS))
    if (last && last.speaker === speaker && sameParagraph) {
      last.text = `${last.text} ${text}`
      last.end = word.end
    } else blocks.push({ speaker, start: word.start, end: word.end, text })
  }
  return blocks
}

/** Notes transcribed before kept the microphone voice as "Você": shown with the name of who recorded. */
export function withRecorder(recording: RecordingData, recorder: string): RecordingData {
  const old = (speaker: RecordingSpeaker) => speaker.id === MICROPHONE && speaker.name === 'Você'
  if (!recording.speakers.some(old)) return recording
  return { ...recording, speakers: recording.speakers.map(speaker => (old(speaker) ? { ...speaker, name: recorder.trim() || RECORDER } : speaker)) }
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
