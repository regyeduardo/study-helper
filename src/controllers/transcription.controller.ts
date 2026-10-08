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

export interface ServiceName {
  the: string
  of: string
}

const AUDIO_ATTEMPTS = 6
const SERVER_ERRORS = [500, 502, 503, 504]

const pause = (seconds: number) => new Promise(resolve => setTimeout(resolve, seconds * 1000))

export async function postAudioController(url: string, apiKey: string, form: FormData, service: ServiceName, signal?: AbortSignal): Promise<Record<string, unknown>> {
  for (let attempt = 0; ; attempt++) {
    const last = attempt === AUDIO_ATTEMPTS - 1
    let response: Response
    try {
      response = await fetch(url, { method: 'POST', headers: { Authorization: `Bearer ${apiKey}` }, body: form, signal })
    } catch {
      if (signal?.aborted) throw new TranscriptionError('Transcrição cancelada.')
      if (last) throw new TranscriptionError(`${service.the} não respondeu depois de ${AUDIO_ATTEMPTS} tentativas. Confira a internet e tente de novo.`)
      await pause(2 ** attempt * 2)
      continue
    }
    if (response.status === 429 && !last) {
      await pause(Number(response.headers.get('retry-after') ?? '') || 2 ** attempt * 2)
      continue
    }
    if (SERVER_ERRORS.includes(response.status)) {
      if (last) throw new TranscriptionError(`${service.the} está com erro no servidor (${response.status}). Tente de novo em alguns minutos.`)
      await pause(2 ** attempt * 2)
      continue
    }
    if (response.status === 401 || response.status === 403) throw new TranscriptionError(`A chave ${service.of} foi recusada.`)
    if (!response.ok) throw new TranscriptionError(`${service.the} recusou o áudio (${response.status}).`)
    return (await response.json()) as Record<string, unknown>
  }
}

const GEMINI_API = 'https://generativelanguage.googleapis.com/v1beta/models'

export async function geminiAudioController(model: string, apiKey: string, audioBase64: string, mime: string, instruction: string, signal?: AbortSignal): Promise<string> {
  let response: Response
  try {
    response = await fetch(`${GEMINI_API}/${model}:generateContent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify({ contents: [{ parts: [{ inline_data: { mime_type: mime, data: audioBase64 } }, { text: instruction }] }], generationConfig: { responseMimeType: 'application/json', temperature: 0 } }),
      signal,
    })
  } catch {
    if (signal?.aborted) throw new TranscriptionError('Transcrição cancelada.')
    throw new TranscriptionError('O Gemini não respondeu.')
  }
  if (response.status === 400 || response.status === 401 || response.status === 403) throw new TranscriptionError('A chave do Gemini foi recusada.')
  if (response.status === 429) throw new TranscriptionError('O Gemini pediu pra esperar: a cota desta chave acabou por agora.')
  if (!response.ok) throw new TranscriptionError(`O Gemini recusou o áudio (${response.status}).`)
  const body = (await response.json()) as { candidates?: { content?: { parts?: { text?: string }[] } }[] }
  return (body.candidates?.[0]?.content?.parts ?? []).map(part => part.text ?? '').join('')
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
