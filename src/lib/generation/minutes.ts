import type { RecordingData } from '@/types/domain'
import { extractJson } from '@/lib/generation/mermaid'
import type { Emit } from '@/lib/generation/pipeline'
import { PROMPTS } from '@/lib/generation/prompts.data'
import type { GenerationSession } from '@/lib/generation/session'
import { clockTime, speechLine } from '@/lib/transcription/export'

export const CHUNK_CHARS = 12000
const CHUNK_OVERLAP = 800

type Item = Record<string, unknown>

export function transcriptChunks(transcript: string): string[] {
  if (transcript.length <= CHUNK_CHARS) return [transcript]
  const pieces: string[] = []
  let start = 0
  while (start < transcript.length) {
    const end = Math.min(start + CHUNK_CHARS, transcript.length)
    pieces.push(transcript.slice(start, end))
    if (end === transcript.length) break
    start = end - CHUNK_OVERLAP
  }
  return pieces
}

function list(value: unknown): Item[] {
  return Array.isArray(value) ? value.filter((item): item is Item => typeof item === 'object' && item !== null) : []
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function stripQuotes(value: string): string {
  return value.trim().replace(/^"+|"+$/g, '')
}

const QUOTE_HEAD_WORDS = 5

function plain(value: string): string {
  return value
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
}

function momentOf(item: Item, recording?: RecordingData): number | null {
  const citation = plain(stripQuotes(text(item.citacao)))
  if (!recording || !citation) return null
  const head = citation.split(' ').slice(0, QUOTE_HEAD_WORDS).join(' ')
  const timed = recording.blocks.filter(block => clockTime(block.start) === text(item.hora).trim())
  const holding = (wanted: string) => (block: RecordingData['blocks'][number]) => plain(block.text).includes(wanted)
  const found = timed.find(holding(citation)) ?? recording.blocks.find(holding(citation)) ?? recording.blocks.find(holding(head)) ?? timed[0]
  if (!found) return null
  const body = plain(found.text)
  const at = body.includes(citation) ? body.indexOf(citation) : body.indexOf(head)
  return at > 0 && found.end > found.start ? found.start + ((found.end - found.start) * at) / body.length : found.start
}

function momentLink(item: Item, recording?: RecordingData): string {
  const moment = momentOf(item, recording)
  return moment === null ? '' : ` [▸ ${clockTime(moment)}](#t=${Math.floor(moment)})`
}

export function renderMinutes(minutes: Record<string, unknown>, recording?: RecordingData): string {
  const parts = [`# ${text(minutes.assunto).trim() || 'Reunião'}`, '']
  for (const theme of list(minutes.temas)) {
    const points = list(theme.pontos).filter(point => text(point.texto).trim())
    if (!points.length) continue
    parts.push(`### ${text(theme.tema).trim() || 'Outros pontos'}`, ...points.map(point => `- ${text(point.texto).trim()}${momentLink(point, recording)}`), '')
  }
  const steps = list(minutes.passos).filter(step => text(step.texto).trim())
  if (steps.length) parts.push('**Próximos passos**', ...steps.map(step => `- [ ] ${text(step.texto).trim()} — ${text(step.quem).trim() || 'sem dono'} · ${text(step.quando).trim() || 'sem prazo'}${momentLink(step, recording)}`), '')
  return parts.join('\n').trim() + '\n'
}

function pad(value: number): string {
  return String(value).padStart(2, '0')
}

export function minutesFileName(subject: string, when: Date = new Date()): string {
  const stamp = `${when.getFullYear()}-${pad(when.getMonth() + 1)}-${pad(when.getDate())} ${pad(when.getHours())}-${pad(when.getMinutes())}`
  return `${stamp} - ${subject.trim() || 'Reunião'}`
}

type Signal = { at: number; kind: 'mark' | 'note' | 'screen'; text: string }

function markLine(mark: Signal): string {
  if (mark.kind === 'screen') return `>> TELA [${clockTime(mark.at)}]: ${mark.text}\n`
  return mark.kind === 'mark' ? `>> MOMENTO MARCADO [${clockTime(mark.at)}]\n` : `>> ANOTAÇÃO [${clockTime(mark.at)}]: ${mark.text}\n`
}

function markedTranscript(recording: RecordingData): string {
  const marks: Signal[] = [...recording.marks, ...(recording.frames ?? []).map(frame => ({ at: frame.at, kind: 'screen' as const, text: frame.text }))].sort((a, b) => a.at - b.at)
  const lines: string[] = []
  for (const [index, block] of recording.blocks.entries()) {
    if (index === 0) while (marks.length && marks[0].at < block.start) lines.push(markLine(marks.shift()!))
    lines.push(speechLine(recording, block))
    const next = recording.blocks[index + 1]
    while (marks.length && (!next || marks[0].at < next.start)) lines.push(markLine(marks.shift()!))
  }
  return lines.join('')
}

export async function buildMinutes(transcript: string, session: GenerationSession, emit: Emit = () => {}, recording?: RecordingData): Promise<{ markdown: string; subject: string }> {
  const pieces: Item[] = []
  for (const piece of transcriptChunks(recording ? markedTranscript(recording) : transcript)) {
    const written = extractJson(await session.chat(piece, PROMPTS.MINUTES_EXTRACT_PROMPT))
    if (written) pieces.push(written)
  }
  const joined = { assunto: text(pieces[0]?.assunto), temas: pieces.flatMap(piece => list(piece.temas)), passos: pieces.flatMap(piece => list(piece.passos)) }
  const minutes = pieces.length > 1 ? (extractJson(await session.chat(JSON.stringify({ partes: pieces }), PROMPTS.MINUTES_VERIFY_PROMPT)) ?? joined) : joined
  const markdown = renderMinutes(minutes, recording)
  const subject = text(minutes.assunto).trim() || 'Reunião'
  emit({ type: 'phase1_complete', markdown })
  emit({ type: 'lesson_complete', markdown })
  return { markdown, subject }
}
