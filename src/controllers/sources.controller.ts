const YOUTUBE_URL = /^(https?:\/\/)?(www\.|m\.)?(youtube\.com\/(watch\?v=|embed\/|v\/|shorts\/|live\/)|youtu\.be\/)([a-zA-Z0-9_-]{11})([&?]\S*)?$/
const WEB_URL = /^https?:\/\/[^\s/$.?#].[^\s]*$/
const JINA_READER = 'https://r.jina.ai/'
const YOUTUBE_TRANSCRIPT = 'https://youtube-transcript.ai/transcript/'
const GEMINI_API = 'https://generativelanguage.googleapis.com/v1beta/models'
const GEMINI_VIDEO_MODEL = 'gemini-flash-latest'

const JINA_HEADERS = {
  Accept: 'text/plain',
  'X-Respond-With': 'markdown',
  'X-Retain-Images': 'none',
  'X-Remove-Selector': 'header, footer, nav, aside, [role=navigation], [role=banner], [role=contentinfo], .noprint',
}

export class SourceError extends Error {}

interface CaptionTrack {
  code: string
  language: string
  auto: boolean
}

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
    response = await fetch(`${JINA_READER}${url.trim()}`, { headers: JINA_HEADERS, signal })
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

function baseLanguage(code: string): string {
  return code.replace(/^a-/, '').split('-')[0].toLowerCase()
}

function captionTracks(body: string): { current: CaptionTrack | null; all: CaptionTrack[] } {
  const header = /^Language:\s*([\w-]+)(\s*\(auto-generated\))?/m.exec(body)
  const current = header ? { code: header[1], language: header[1], auto: Boolean(header[2]) } : null
  const others = [...(/^Other available languages:\s*(.+)$/m.exec(body)?.[1] ?? '').matchAll(/([\w-]+)\s*\(([\w-]+)\)(\s*\[auto\])?/g)].map(match => ({
    code: match[1],
    language: match[2],
    auto: Boolean(match[3]) || match[1].startsWith('a-'),
  }))
  return { current, all: current ? [current, ...others] : others }
}

function bestTrack(body: string, language: string): CaptionTrack | null {
  const { current, all } = captionTracks(body)
  const spoken = language ? baseLanguage(language) : baseLanguage(all.find(track => track.auto)?.language ?? current?.language ?? '')
  const matching = all.filter(track => baseLanguage(track.language) === spoken)
  return matching.find(track => !track.auto) ?? matching[0] ?? null
}

function transcriptBody(body: string): string {
  const marker = body.indexOf('## Transcript')
  return marker >= 0 ? body.slice(marker + '## Transcript'.length) : body
}

export function collapseRepeats(line: string): string {
  const words = line.split(/\s+/).filter(Boolean)
  const kept: string[] = []
  for (const word of words) {
    kept.push(word)
    for (let size = Math.min(12, Math.floor(kept.length / 2)); size >= 3; size--) {
      const tail = kept.slice(-size).join(' ').toLowerCase()
      const before = kept.slice(-2 * size, -size).join(' ').toLowerCase()
      if (tail === before) {
        kept.splice(-size, size)
        break
      }
    }
  }
  return kept.join(' ')
}

async function fetchCaption(id: string, language: string, signal?: AbortSignal): Promise<string> {
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
  return response.text()
}

export async function fetchYoutubeTranscriptController(url: string, language: string, signal?: AbortSignal): Promise<FetchedSource> {
  const id = youtubeId(url)
  if (!id) throw new SourceError('Esse link não parece ser de um vídeo do YouTube.')
  let body = await fetchCaption(id, language, signal)
  const best = bestTrack(body, language)
  const current = captionTracks(body).current
  if (best && (best.code !== current?.code || best.auto !== current?.auto)) body = await fetchCaption(id, best.code, signal)
  const auto = captionTracks(body).current?.auto ?? false
  const content = cleanTranscript(auto ? transcriptBody(body).split('\n').map(collapseRepeats).join('\n') : transcriptBody(body))
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
