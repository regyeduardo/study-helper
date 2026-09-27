const YOUTUBE_URL = /^(https?:\/\/)?(www\.|m\.)?(youtube\.com\/(watch\?v=|embed\/|v\/|shorts\/|live\/)|youtu\.be\/)([a-zA-Z0-9_-]{11})([&?]\S*)?$/
const WEB_URL = /^https?:\/\/[^\s/$.?#].[^\s]*$/
const JINA_READER = 'https://r.jina.ai/'
const YOUTUBE_TRANSCRIPT = 'https://youtube-transcript.ai/transcript/'
const GEMINI_API = 'https://generativelanguage.googleapis.com/v1beta/models'
const GEMINI_VIDEO_MODEL = 'gemini-flash-latest'

export class SourceError extends Error {}

export interface FetchedSource {
  title: string
  content: string
}

export function youtubeId(url: string): string | null {
  return YOUTUBE_URL.exec(url.trim())?.[5] ?? null
}

export function isWebUrl(url: string): boolean {
  return WEB_URL.test(url.trim())
}

export function cleanTranscript(raw: string): string {
  const seen = new Set<string>()
  const kept: string[] = []
  for (const line of raw.split('\n')) {
    const text = line.trim()
    if (!text) continue
    const key = text.toLowerCase().split(/\s+/).join(' ')
    if (seen.has(key)) continue
    seen.add(key)
    kept.push(text)
  }
  return kept.join('\n').trim()
}

export async function fetchWebPageController(url: string, signal?: AbortSignal): Promise<FetchedSource> {
  let response: Response
  try {
    response = await fetch(`${JINA_READER}${url.trim()}`, { headers: { Accept: 'text/plain' }, signal })
  } catch {
    throw new SourceError('Não consegui ler o site agora (o leitor Jina não respondeu).')
  }
  if (response.status === 429) throw new SourceError('O leitor de sites (Jina) pediu pra esperar: o limite grátis por minuto acabou.')
  if (!response.ok) throw new SourceError(`O site não pôde ser lido (${response.status}).`)
  const body = await response.text()
  const title = /^Title:\s*(.+)$/m.exec(body)?.[1]?.trim() || url
  const marker = body.indexOf('Markdown Content:')
  const content = (marker >= 0 ? body.slice(marker + 'Markdown Content:'.length) : body).trim()
  if (!content) throw new SourceError('O site não tem texto que dê pra ler.')
  return { title, content }
}

async function youtubeTitle(url: string, signal?: AbortSignal): Promise<string> {
  for (const endpoint of [
    `https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(url)}`,
    `https://noembed.com/embed?url=${encodeURIComponent(url)}`,
  ]) {
    try {
      const response = await fetch(endpoint, { signal })
      if (response.ok) {
        const body = (await response.json()) as { title?: string }
        if (body.title) return body.title
      }
    } catch {
      continue
    }
  }
  return 'Vídeo do YouTube'
}

export async function fetchYoutubeTranscriptController(url: string, language: string, signal?: AbortSignal): Promise<FetchedSource> {
  const id = youtubeId(url)
  if (!id) throw new SourceError('Esse link não parece ser de um vídeo do YouTube.')
  const query = language ? `?lang=${encodeURIComponent(language)}` : ''
  let response: Response
  try {
    response = await fetch(`${YOUTUBE_TRANSCRIPT}${id}.txt${query}`, { signal })
  } catch {
    throw new SourceError('O youtube-transcript.ai não respondeu. Tente de novo ou use o Gemini nas Configurações.')
  }
  if (response.status === 404) throw new SourceError('Esse vídeo não tem legenda que dê pra ler pelo youtube-transcript.ai.')
  if (response.status === 429) throw new SourceError('O youtube-transcript.ai pediu pra esperar (uso justo). Tente em alguns minutos ou use o Gemini.')
  if (!response.ok) throw new SourceError(`O youtube-transcript.ai recusou (${response.status}).`)
  const content = cleanTranscript(await response.text())
  if (!content) throw new SourceError('A legenda veio vazia.')
  return { title: await youtubeTitle(url, signal), content }
}

export async function fetchYoutubeWithGeminiController(url: string, apiKey: string, signal?: AbortSignal): Promise<FetchedSource> {
  if (!youtubeId(url)) throw new SourceError('Esse link não parece ser de um vídeo do YouTube.')
  if (!apiKey) throw new SourceError('Falta a chave do Gemini nas Configurações (é grátis no Google AI Studio).')
  let response: Response
  try {
    response = await fetch(`${GEMINI_API}/${GEMINI_VIDEO_MODEL}:generateContent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify({
        contents: [
          {
            parts: [
              { file_data: { file_uri: url } },
              { text: 'Transcreva a fala deste vídeo por inteiro, palavra por palavra, no idioma falado. Devolva só o texto da transcrição, sem comentários.' },
            ],
          },
        ],
      }),
      signal,
    })
  } catch {
    throw new SourceError('O Gemini não respondeu.')
  }
  if (response.status === 429) throw new SourceError('O Gemini recusou por limite do plano grátis (8 h de vídeo por dia).')
  if (!response.ok) throw new SourceError(`O Gemini recusou o vídeo (${response.status}). Só vídeo público funciona.`)
  const body = (await response.json()) as { candidates?: { content?: { parts?: { text?: string }[] } }[] }
  const content = (body.candidates?.[0]?.content?.parts ?? []).map(part => part.text ?? '').join('').trim()
  if (!content) throw new SourceError('O Gemini não devolveu a transcrição.')
  return { title: await youtubeTitle(url, signal), content }
}
