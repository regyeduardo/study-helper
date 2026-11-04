import type { AiSettings } from '@/types/domain'
import { askOnceController } from '@/controllers/probe.controller'
import type { Media } from '@/lib/ai/config'
import { providerOf } from '@/lib/ai/providers'

/** "Testar": what the model did with a tiny sample. Kept only in memory, like everything read live. */
export type ProbeResult = { state: 'yes' } | { state: 'no' } | { state: 'fail'; message: string }

const ASK = 'Responda só: ok'
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII='

function base64(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

/** 0.2 s of silence, 16 kHz mono WAV. */
export function silentWav(): string {
  const samples = 3200
  const bytes = new Uint8Array(44 + samples * 2)
  const view = new DataView(bytes.buffer)
  const text = (at: number, value: string) => [...value].forEach((char, index) => view.setUint8(at + index, char.charCodeAt(0)))
  text(0, 'RIFF')
  view.setUint32(4, 36 + samples * 2, true)
  text(8, 'WAVEfmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, 16000, true)
  view.setUint32(28, 32000, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  text(36, 'data')
  view.setUint32(40, samples * 2, true)
  return base64(bytes)
}

export function tinyPdf(): string {
  const page = 'BT /F1 24 Tf 40 100 Td (Teste) Tj ET'
  const pdf = `%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>endobj\n4 0 obj<</Length ${page.length}>>stream\n${page}\nendstream endobj\n5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF`
  return btoa(pdf)
}

/** Half a second of a drawn canvas, recorded by the browser (WebM). */
export async function tinyVideo(): Promise<{ data: string; mime: string } | null> {
  if (typeof MediaRecorder === 'undefined' || typeof document === 'undefined') return null
  const canvas = document.createElement('canvas')
  canvas.width = 64
  canvas.height = 64
  const paint = canvas.getContext('2d')
  if (!paint || typeof canvas.captureStream !== 'function') return null
  const stream = canvas.captureStream(10)
  const recorder = new MediaRecorder(stream)
  const chunks: Blob[] = []
  recorder.ondataavailable = event => chunks.push(event.data)
  const stopped = new Promise<void>(resolve => (recorder.onstop = () => resolve()))
  recorder.start()
  for (let frame = 0; frame < 5; frame++) {
    paint.fillStyle = frame % 2 ? '#0969da' : '#1a7f37'
    paint.fillRect(0, 0, 64, 64)
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  recorder.stop()
  await stopped
  stream.getTracks().forEach(track => track.stop())
  const blob = new Blob(chunks, { type: recorder.mimeType || 'video/webm' })
  return { data: base64(new Uint8Array(await blob.arrayBuffer())), mime: blob.type.split(';')[0] || 'video/webm' }
}

async function sampleOf(target: AiSettings, media: Media): Promise<unknown | null> {
  const anthropic = providerOf(target.provider).format === 'anthropic'
  if (media === 'texto') return { type: 'text', text: ASK }
  if (media === 'imagem') return anthropic ? { type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG } } : { type: 'image_url', image_url: { url: `data:image/png;base64,${PNG}` } }
  if (media === 'pdf') return anthropic ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: tinyPdf() } } : { type: 'file', file: { filename: 'teste.pdf', file_data: `data:application/pdf;base64,${tinyPdf()}` } }
  if (anthropic) return null
  if (media === 'audio') return { type: 'input_audio', input_audio: { data: silentWav(), format: 'wav' } }
  const video = await tinyVideo()
  return video ? { type: 'video_url', video_url: { url: `data:${video.mime};base64,${video.data}` } } : undefined
}

function fromStatus(status: number): ProbeResult {
  if (status >= 200 && status < 300) return { state: 'yes' }
  if (status === 400 || status === 415 || status === 422) return { state: 'no' }
  if (status === 401 || status === 403) return { state: 'fail', message: `chave recusada (${status})` }
  return { state: 'fail', message: `o provedor devolveu erro (${status})` }
}

/** Sends a tiny sample of the media; the provider taking it means the model accepts it. */
export async function probeMedia(target: AiSettings, media: Media): Promise<ProbeResult> {
  const sample = await sampleOf(target, media)
  if (sample === null) return { state: 'no' }
  if (sample === undefined) return { state: 'fail', message: 'este navegador não monta o vídeo de teste' }
  try {
    const parts = media === 'texto' ? [sample] : [sample, { type: 'text', text: ASK }]
    return fromStatus((await askOnceController(target, parts, 16)).status)
  } catch {
    return { state: 'fail', message: 'o provedor não respondeu' }
  }
}

// The same job as Questões da web: a real exam question found now, not a date the model may guess
const WEB_ASK = 'Pesquise na web agora uma questão real de prova (ENEM, vestibular ou concurso) sobre fotossíntese e responda SOMENTE um JSON: {"url": "<endereço da página onde a questão está>"}. Se você não consegue pesquisar na web, responda {"url": null}.'

const pageOf = (url: string) => url.trim().replace(/[?#].*$/, '').replace(/\/+$/, '').toLowerCase()

/** A model searches the web when the page it cites is one its search read (the provider lists them); an invented or ignored page does not count. */
export async function probeWeb(target: AiSettings): Promise<ProbeResult> {
  try {
    // OpenRouter searches only with its web plugin turned on, for any model
    const reply = await askOnceController(target, [{ type: 'text', text: WEB_ASK }], 1000, target.provider === 'openrouter' ? { plugins: [{ id: 'web', max_results: 1 }] } : {})
    if (reply.status < 200 || reply.status >= 300) {
      const status = fromStatus(reply.status)
      return status.state === 'no' ? { state: 'fail', message: `o provedor devolveu erro (${reply.status})` } : status
    }
    const found = /\{[\s\S]*\}/.exec(reply.text)?.[0]
    let answer: { url?: unknown } = {}
    try {
      answer = found ? (JSON.parse(found) as typeof answer) : {}
    } catch {
      answer = {}
    }
    const read = new Set(reply.cited.map(pageOf))
    return typeof answer.url === 'string' && read.has(pageOf(answer.url)) ? { state: 'yes' } : { state: 'no' }
  } catch {
    return { state: 'fail', message: 'o provedor não respondeu' }
  }
}

