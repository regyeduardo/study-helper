import type { Settings, SourceMeta } from '@/types/domain'
import {
  fetchWebPageController,
  fetchYoutubeTranscriptController,
  fetchYoutubeWithGeminiController,
  isWebUrl,
  SourceError,
  youtubeId,
} from '@/controllers/sources.controller'
import { docxText } from '@/lib/imports/docx'
import { pdfText } from '@/lib/imports/pdf'
import { decodeText, detectKind, subtitleToText } from '@/lib/generation/uploads'
import { transcribe, type TranscriptionOutcome } from '@/lib/transcription'
import type { Progress } from '@/lib/transcription/types'

export type ContentInput =
  | { kind: 'link'; url: string }
  | { kind: 'file'; file: File }
  | { kind: 'recording'; file: File }
  | { kind: 'text'; text: string }
  | { kind: 'topic'; topic: string }

export interface ResolvedInput {
  content: string
  title: string
  description: string
  origin: SourceMeta
  transcription: TranscriptionOutcome | null
}

const TITLE_CHARS = 60

function mediaDuration(file: File): Promise<number | undefined> {
  return new Promise(resolve => {
    const element = document.createElement(file.type.startsWith('video') ? 'video' : 'audio')
    const url = URL.createObjectURL(file)
    element.preload = 'metadata'
    element.onloadedmetadata = () => {
      URL.revokeObjectURL(url)
      resolve(Number.isFinite(element.duration) ? element.duration : undefined)
    }
    element.onerror = () => {
      URL.revokeObjectURL(url)
      resolve(undefined)
    }
    element.src = url
  })
}

async function readUpload(file: File, settings: Settings, progress: Progress, signal?: AbortSignal): Promise<{ text: string; transcription: TranscriptionOutcome | null }> {
  const bytes = new Uint8Array(await file.arrayBuffer())
  const kind = detectKind(file.name, bytes)
  if (kind === 'pdf') return { text: await pdfText(bytes.buffer), transcription: null }
  if (kind === 'docx') return { text: await docxText(bytes.buffer), transcription: null }
  if (kind === 'doc_legacy') throw new SourceError('Formato .doc antigo não é suportado — salve como .docx e envie de novo.')
  if (kind === 'subtitle') return { text: subtitleToText(decodeText(bytes)), transcription: null }
  if (kind === 'media') {
    const transcription = await transcribe(file, settings.transcription, progress, signal)
    return { text: transcription.text, transcription }
  }
  return { text: decodeText(bytes).trim(), transcription: null }
}

export async function resolveInput(input: ContentInput, settings: Settings, prompt: string, progress: Progress, signal?: AbortSignal): Promise<ResolvedInput> {
  if (input.kind === 'topic') {
    const topic = input.topic.trim()
    return { content: topic, title: topic.slice(0, TITLE_CHARS), description: topic, origin: { input: 'topic', name: topic, storage: 'none' }, transcription: null }
  }

  if (input.kind === 'text') {
    const text = input.text.trim()
    const firstLine = text.split('\n')[0].replace(/^#+\s*/, '').trim()
    const body = prompt ? `${text}\n\n${prompt}` : text
    return {
      content: `# Conteúdo\n\n${body}`,
      title: firstLine.slice(0, TITLE_CHARS) || 'Texto colado',
      description: 'texto colado',
      origin: { input: 'text', name: 'texto colado', sizeBytes: new Blob([text]).size, mime: 'text/plain', storage: 'none' },
      transcription: null,
    }
  }

  if (input.kind === 'link') {
    const url = input.url.trim()
    if (youtubeId(url)) {
      progress('Lendo a legenda do vídeo')
      const fetched =
        settings.youtube.reader === 'gemini'
          ? await fetchYoutubeWithGeminiController(url, settings.youtube.geminiApiKey, signal)
          : await fetchYoutubeTranscriptController(url, settings.transcription.language, signal)
      return {
        content: `# ${fetched.title}\n\n${fetched.content}`,
        title: fetched.title,
        description: url,
        origin: { input: 'youtube', name: fetched.title, url, storage: 'none' },
        transcription: null,
      }
    }
    if (!isWebUrl(url)) throw new SourceError('Esse endereço não parece um link de site (precisa começar com http:// ou https://).')
    progress('Lendo a página')
    const fetched = await fetchWebPageController(url, signal)
    return {
      content: `# ${fetched.title}\n\n${fetched.content}`,
      title: fetched.title,
      description: url,
      origin: { input: 'url', name: fetched.title, url, storage: 'none' },
      transcription: null,
    }
  }

  const file = input.file
  progress(input.kind === 'recording' ? 'Transcrevendo a gravação' : 'Lendo o arquivo')
  const { text, transcription } = await readUpload(file, settings, progress, signal)
  const body = prompt ? `${text}\n\n${prompt}` : text
  return {
    content: `# Conteúdo\n\n${body}`,
    title: file.name,
    description: file.name,
    origin: {
      input: input.kind === 'recording' ? 'recording' : 'file',
      name: file.name,
      sizeBytes: file.size,
      mime: file.type || 'application/octet-stream',
      durationSeconds: transcription?.durationSeconds ?? (file.type.startsWith('audio') || file.type.startsWith('video') ? await mediaDuration(file) : undefined),
      storage: 'none',
    },
    transcription,
  }
}
