import { postAudioController, type ServiceName, TranscriptionError } from '@/controllers/transcription.controller'
import type { ProviderJob, ProviderResult, SpeakerTurn, Word } from '@/lib/transcription/types'

const ENDPOINT = '/audio/transcriptions'
const CUSTOM: ServiceName = { the: 'O provedor personalizado', of: 'do provedor personalizado' }

type Row = Record<string, unknown>

function rows(value: unknown): Row[] {
  return Array.isArray(value) ? value.filter((row): row is Row => typeof row === 'object' && row !== null) : []
}

function timed(row: Row, text: unknown, offset: number): Word | null {
  const start = Number(row.start)
  const end = Number(row.end)
  const clean = typeof text === 'string' ? text.trim() : ''
  if (!clean || !Number.isFinite(start)) return null
  return { start: start + offset, end: (Number.isFinite(end) ? end : start) + offset, text: clean }
}

export function timedWords(body: Row, offset: number): Word[] {
  const words = rows(body.words).map(row => timed(row, row.word ?? row.text, offset))
  const found = words.some(Boolean) ? words : rows(body.segments).map(row => timed(row, row.text, offset))
  const kept = found.filter((word): word is Word => word !== null)
  if (kept.length) return kept
  const text = typeof body.text === 'string' ? body.text.trim() : ''
  return text ? [{ start: offset, end: offset, text }] : []
}

export function turnsOf(value: unknown, offset = 0): SpeakerTurn[] {
  return rows(value)
    .filter(row => row.speaker !== undefined && row.speaker !== null && row.speaker !== '' && Number.isFinite(Number(row.start)))
    .map(row => ({ start: Number(row.start) + offset, end: (Number.isFinite(Number(row.end)) ? Number(row.end) : Number(row.start)) + offset, speaker: String(row.speaker) }))
}

function extraOptions(extra: string): [string, string][] {
  if (!extra.trim()) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(extra)
  } catch {
    parsed = null
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new TranscriptionError('As opções extras do provedor personalizado não são um JSON válido.')
  const plain = (value: unknown) => (typeof value === 'object' && value !== null ? JSON.stringify(value) : String(value))
  return Object.entries(parsed).flatMap(([key, value]): [string, string][] => (Array.isArray(value) ? value.map(item => [`${key}[]`, plain(item)]) : [[key, value === null ? '' : plain(value)]]))
}

function endpointOf(baseUrl: string): string {
  const base = baseUrl.trim().replace(/\/+$/, '')
  return base.endsWith(ENDPOINT) ? base : `${base}${ENDPOINT}`
}

export async function transcribeWithCustom(job: ProviderJob): Promise<ProviderResult> {
  if (!job.credential.baseUrl.trim()) throw new TranscriptionError('Falta o endereço do provedor personalizado nas Configurações.')
  if (!job.credential.model.trim()) throw new TranscriptionError('Falta o modelo do provedor personalizado nas Configurações.')
  const extra = extraOptions(job.credential.extra)
  const replaced = new Set(extra.map(([key]) => key.replace(/\[\]$/, '')))
  const words: Word[] = []
  const turns: SpeakerTurn[] = []
  for (const [index, part] of job.parts.entries()) {
    job.progress('Transcrevendo pelo provedor personalizado', index / job.parts.length)
    const form = new FormData()
    form.append('file', part, 'trecho.wav')
    form.append('model', job.credential.model.trim())
    if (job.language && !replaced.has('language')) form.append('language', job.language)
    if (!replaced.has('response_format')) form.append('response_format', 'verbose_json')
    for (const [key, value] of extra) if (value !== '') form.append(key, value)
    const body = await postAudioController(endpointOf(job.credential.baseUrl), job.credential.apiKey, form, CUSTOM, job.signal)
    const offset = index * job.partSeconds
    words.push(...timedWords(body, offset))
    const found = [body.speaker_segments, body.segments, body.words].map(list => turnsOf(list, offset)).find(list => list.length)
    turns.push(...(found ?? []))
  }
  return { words, turns }
}
