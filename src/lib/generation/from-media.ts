// Generation straight from the media, as Gemini does: the recording's Opus track, remuxed to Ogg without
// re-encoding (the video never goes), in ONE call to the use's model, when it hears audio and the audio fits.
import type { AtaModelId, AtaPart } from '@/types/domain'
import { ATA_MODELS, chosenParts, modelDocument, PART_LABEL } from '@/lib/generation/ata'
import * as P from '@/lib/generation/ata-prompts'
import { linkMoments } from '@/lib/generation/meeting-material'
import { PART_PROMPTS } from '@/lib/generation/summary'
import { base64Of, decodeChannels16k, mixedDown, SAMPLE_RATE } from '@/lib/transcription/audio'
import { opusOgg } from '@/lib/transcription/opus'

// Google AI Studio takes ~20 MB a request and NVIDIA ~25 MB; base64 grows the audio by a third.
export const MAX_AUDIO_BYTES = 14_000_000

export type MediaParts = Record<string, unknown>[]

const OUVIR = 'O material é a gravação em áudio acima, no lugar da transcrição: ouça do começo ao fim e use tudo o que foi dito, com os nomes que as pessoas dizem. Os minutos [▸ mm:ss] são os do áudio.'

const TAREFAS = 'Modelo LEVANTAMENTO DE TAREFAS. Uma linha por pedido ou compromisso dito: "- [ ] **o que fazer** · dono (ou "sem dono") · prazo dito (ou "sem prazo")", e embaixo a prova [▸ mm:ss] Nome: "literal".'

const MP3_KBPS = 24

/** Mono 16 kHz MP3: OpenAI-style providers (DeepInfra) take only mp3 or wav as input_audio and refuse Ogg with a 422. */
export async function mp3Of(source: Blob): Promise<Blob> {
  const { Mp3Encoder } = await import('@breezystack/lamejs')
  const samples = mixedDown(await decodeChannels16k(source))
  const encoder = new Mp3Encoder(1, SAMPLE_RATE, MP3_KBPS)
  const block = new Int16Array(1152 * 32)
  const chunks: Uint8Array[] = []
  for (let start = 0; start < samples.length; start += block.length) {
    const size = Math.min(block.length, samples.length - start)
    for (let index = 0; index < size; index++) block[index] = Math.max(-32768, Math.min(32767, Math.round(samples[start + index] * 32767)))
    const out = encoder.encodeBuffer(block.subarray(0, size))
    if (out.length) chunks.push(new Uint8Array(out))
  }
  const tail = encoder.flush()
  if (tail.length) chunks.push(new Uint8Array(tail))
  return new Blob(chunks, { type: 'audio/mpeg' })
}

/** The user turn of the call: the light audio and what to do with it; null when there is no audio or it is over the limit. */
export async function mediaParts(source: Blob, provider: string, limit = MAX_AUDIO_BYTES): Promise<MediaParts | null> {
  const ogg = await opusOgg(source)
  // OpenRouter takes the Ogg as it is; the others get MP3 (the Ogg decodes much lighter than the whole video)
  const mp3 = provider !== 'openrouter'
  const audio = mp3 ? await mp3Of(ogg ?? source).catch(() => null) : ogg
  if (!audio || audio.size > limit) return null
  return [{ type: 'input_audio', input_audio: { data: await base64Of(audio), format: mp3 ? 'mp3' : 'ogg' } }, { type: 'text', text: OUVIR }]
}

/** The Ata from the audio: the chosen model's skeleton, or the checked parts in order, each under its "## " title. */
export function ataPrompt(model: AtaModelId | undefined, parts: AtaPart[]): string {
  if (model) return ATA_MODELS[model].prompt
  const asked = chosenParts(parts).map(part => `## ${PART_LABEL[part]}\n${part === 'tarefas' ? TAREFAS : PART_PROMPTS[part]}`)
  return `${P.BASE}\n\nEscreva estas partes, nesta ordem, cada uma abrindo com o título "## " dela (o título "# " de cada modelo vira "### "):\n\n${asked.join('\n\n')}`
}

/** No thinking or fences; no print slots (no frames here); the minutes of the parts become links that play the media. */
export function ataDocument(raw: string, model?: AtaModelId): string {
  if (model) return modelDocument(raw)
  const text = raw
    .replace(/<think>[\s\S]*?<\/think>/g, '')
    .replace(/^```(markdown|md)?\s*$/gm, '')
    .replace(/^[ \t]*\{\{[^}]*\}\}[ \t]*$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  return `${linkMoments(text)}\n`
}
