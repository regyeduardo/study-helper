import { env } from '@/lib/env'

const GROQ_URL = 'https://api.groq.com/openai/v1/audio/transcriptions'
const GROQ_MODEL = 'whisper-large-v3-turbo'

export interface TimedText {
  start: number
  end: number
  text: string
}

export class TranscriptionError extends Error {}

export async function transcribeWithGroqController(audio: Blob, apiKey: string, language: string, offset: number, signal?: AbortSignal): Promise<TimedText[]> {
  if (!apiKey) throw new TranscriptionError('Falta a chave da Groq nas Configurações (é grátis em console.groq.com).')
  const form = new FormData()
  form.append('file', audio, 'trecho.wav')
  form.append('model', GROQ_MODEL)
  form.append('response_format', 'verbose_json')
  if (language) form.append('language', language)
  for (let attempt = 0; ; attempt++) {
    let response: Response
    try {
      response = await fetch(GROQ_URL, { method: 'POST', headers: { Authorization: `Bearer ${apiKey}` }, body: form, signal })
    } catch {
      if (signal?.aborted) throw new TranscriptionError('Transcrição cancelada.')
      throw new TranscriptionError('A Groq não respondeu.')
    }
    if (response.status === 429 && attempt < 5) {
      const wait = Number(response.headers.get('retry-after') ?? '') || 2 ** attempt * 2
      await new Promise(resolve => setTimeout(resolve, wait * 1000))
      continue
    }
    if (response.status === 401) throw new TranscriptionError('A chave da Groq foi recusada.')
    if (!response.ok) throw new TranscriptionError(`A Groq recusou o áudio (${response.status}).`)
    const body = (await response.json()) as { text?: string; segments?: { start: number; end: number; text: string }[] }
    const segments = body.segments ?? []
    if (!segments.length) return body.text?.trim() ? [{ start: offset, end: offset, text: body.text.trim() }] : []
    return segments.map(segment => ({ start: segment.start + offset, end: segment.end + offset, text: segment.text.trim() }))
  }
}

async function callFreeWorker(path: string, token: string, init: RequestInit = {}): Promise<Response> {
  if (!env.transcriptionWorkerUrl) throw new TranscriptionError('Os minutos grátis não estão configurados neste app.')
  try {
    return await fetch(`${env.transcriptionWorkerUrl}${path}`, { ...init, headers: { Authorization: `Bearer ${token}` } })
  } catch {
    if (init.signal?.aborted) throw new TranscriptionError('Transcrição cancelada.')
    throw new TranscriptionError('O serviço de minutos grátis não respondeu.')
  }
}

export async function getFreeBalanceController(token: string): Promise<number> {
  const response = await callFreeWorker('/balance', token)
  if (response.status === 401) throw new TranscriptionError('O Google não confirmou o seu login; entre de novo para usar os minutos grátis.')
  if (!response.ok) throw new TranscriptionError(`Não consegui ver os minutos grátis de hoje (${response.status}).`)
  const body = (await response.json()) as { remaining_seconds?: number }
  return Number(body.remaining_seconds) || 0
}

export async function transcribeWithFreeController(audio: Blob, token: string, language: string, offset: number, signal?: AbortSignal): Promise<TimedText[]> {
  const form = new FormData()
  form.append('audio', audio, 'trecho.wav')
  if (language) form.append('language', language)
  const response = await callFreeWorker('/transcribe', token, { method: 'POST', body: form, signal })
  if (response.status === 401) throw new TranscriptionError('O Google não confirmou o seu login; entre de novo para usar os minutos grátis.')
  if (response.status === 429) throw new TranscriptionError('Acabaram os minutos grátis de hoje.')
  if (!response.ok) throw new TranscriptionError(`O serviço de minutos grátis recusou o áudio (${response.status}).`)
  const body = (await response.json()) as { text?: string; segments?: { start: number; end: number; text: string }[] }
  const segments = body.segments ?? []
  if (!segments.length) return body.text?.trim() ? [{ start: offset, end: offset, text: body.text.trim() }] : []
  return segments.map(segment => ({ start: segment.start + offset, end: segment.end + offset, text: segment.text.trim() }))
}
