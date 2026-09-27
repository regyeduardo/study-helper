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
