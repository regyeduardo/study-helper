import type { RecordingData, TranscriptBlock } from '@/types/domain'
import { Cancelled } from '@/controllers/ai.controller'
import { extractJson } from '@/lib/generation/mermaid'
import { CHUNK_CHARS } from '@/lib/generation/minutes'
import { PROMPTS } from '@/lib/generation/prompts.data'
import type { GenerationSession } from '@/lib/generation/session'
import { speakerName } from '@/lib/transcription/export'
import { termsHint } from '@/lib/transcription/types'

const HEARD_WORDS_LIMIT = 6
const ADDED_WORDS_LIMIT = 2

export interface Correction {
  speech: number
  heard: string
  meant: string
}

function wordsOf(value: string): string[] {
  return value.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []
}

function onlyRemoves(heard: string[], meant: string[]): boolean {
  let at = 0
  for (const word of heard) if (word === meant[at]) at++
  return at === meant.length && meant.length < heard.length
}

export function correctionsIn(raw: string): Correction[] {
  const list = extractJson(raw)?.correcoes
  if (!Array.isArray(list)) return []
  return list
    .filter((item): item is Record<string, unknown> => typeof item === 'object' && item !== null)
    .map(item => ({ speech: Number(item.fala), heard: typeof item.de === 'string' ? item.de : '', meant: typeof item.para === 'string' ? item.para : '' }))
}

function accepted(correction: Correction, block: TranscriptBlock | undefined): boolean {
  if (!block || !correction.heard || !correction.meant.trim() || !block.text.includes(correction.heard)) return false
  const heard = wordsOf(correction.heard)
  const meant = wordsOf(correction.meant)
  return heard.length <= HEARD_WORDS_LIMIT && meant.length <= heard.length + ADDED_WORDS_LIMIT && !onlyRemoves(heard, meant)
}

export function batches(lines: string[]): string[][] {
  const out: string[][] = [[]]
  let size = 0
  for (const line of lines) {
    if (size + line.length > CHUNK_CHARS && out[out.length - 1].length) {
      out.push([])
      size = 0
    }
    out[out.length - 1].push(line)
    size += line.length
  }
  return out
}

interface Reassignment {
  speech: number
  who: string
}

function reassignmentsIn(raw: string): Reassignment[] {
  const list = extractJson(raw)?.falantes
  if (!Array.isArray(list)) return []
  return list
    .filter((item): item is Record<string, unknown> => typeof item === 'object' && item !== null)
    .map(item => ({ speech: Number(item.fala), who: typeof item.quem === 'string' ? item.quem.trim() : '' }))
    .filter(item => item.who)
}

export async function redoTranscript(recording: RecordingData, instruction: string, session: GenerationSession, terms = ''): Promise<RecordingData> {
  if (!recording.blocks.length || !instruction.trim()) return recording
  const hint = termsHint(terms)
  const context =
    `O que está errado, segundo quem gravou: ${instruction.trim()}\n\n` +
    (hint ? `${hint}\n\n` : '') +
    (recording.speakers.length ? `Participantes: ${recording.speakers.map(speaker => speaker.name).join(', ')}\n\n` : '') +
    (recording.frames?.length ? `Escrito na tela durante a reunião: ${recording.frames.map(frame => frame.text).join(' | ')}\n\n` : '')
  const lines = recording.blocks.map((block, index) => `${index + 1} | ${block.speaker ? `${speakerName(recording, block.speaker)}: ` : ''}${block.text}`)
  const corrections: Correction[] = []
  const reassignments: Reassignment[] = []
  for (const batch of batches(lines)) {
    const answer = await session.chat(context + batch.join('\n'), PROMPTS.TRANSCRIPT_REDO_PROMPT)
    corrections.push(...correctionsIn(answer))
    reassignments.push(...reassignmentsIn(answer))
  }
  const blocks = [...recording.blocks]
  for (const correction of corrections) {
    const block = blocks[correction.speech - 1]
    if (!block || !correction.heard || !correction.meant.trim() || !block.text.includes(correction.heard)) continue
    blocks[correction.speech - 1] = { ...block, text: block.text.replace(correction.heard, () => correction.meant), original: block.original ?? block.text }
  }
  const speakers = [...recording.speakers]
  for (const { speech, who } of reassignments) {
    const block = blocks[speech - 1]
    if (!block) continue
    let speaker = speakers.find(item => item.name.toLowerCase() === who.toLowerCase())
    if (!speaker) {
      speaker = { id: `named_${speakers.length}`, name: who, suggested: false }
      speakers.push(speaker)
    }
    blocks[speech - 1] = { ...block, speaker: speaker.id }
  }
  return { ...recording, blocks, speakers }
}

export async function reviewTranscript(recording: RecordingData, session: GenerationSession, terms = ''): Promise<RecordingData> {
  if (!recording.blocks.length) return recording
  const hint = termsHint(terms)
  const people = (hint ? `${hint}\n\n` : '') + (recording.speakers.length ? `Participantes: ${recording.speakers.map(speaker => speaker.name).join(', ')}\n\n` : '')
  const screen = recording.frames?.length ? `Escrito na tela durante a reunião: ${recording.frames.map(frame => frame.text).join(' | ')}\n\n` : ''
  const lines = recording.blocks.map((block, index) => `${index + 1} | ${block.speaker ? `${speakerName(recording, block.speaker)}: ` : ''}${block.text}`)
  const corrections: Correction[] = []
  try {
    for (const batch of batches(lines)) corrections.push(...correctionsIn(await session.chat(people + screen + batch.join('\n'), PROMPTS.TRANSCRIPT_REVIEW_PROMPT)))
  } catch (error) {
    if (error instanceof Cancelled) throw error
    return recording
  }
  return withCorrections(recording, corrections)
}

export function withCorrections(recording: RecordingData, corrections: Correction[]): RecordingData {
  const blocks = [...recording.blocks]
  for (const correction of corrections) {
    const block = blocks[correction.speech - 1]
    if (!accepted(correction, block)) continue
    blocks[correction.speech - 1] = { ...block, text: block.text.replace(correction.heard, () => correction.meant), original: block.original ?? block.text }
  }
  return blocks.some((block, index) => block !== recording.blocks[index]) ? { ...recording, blocks } : recording
}
