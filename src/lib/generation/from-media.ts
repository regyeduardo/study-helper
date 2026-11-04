// Generation straight from the media, as Gemini does: the recording's Opus track, remuxed to Ogg without
// re-encoding (the video never goes), in ONE call to the use's model, when it hears audio and the audio fits.
import type { AtaModelId, AtaPart } from '@/types/domain'
import { ATA_MODELS, chosenParts, modelDocument, PART_LABEL } from '@/lib/generation/ata'
import * as P from '@/lib/generation/ata-prompts'
import { linkMoments } from '@/lib/generation/meeting-material'
import { PART_PROMPTS } from '@/lib/generation/summary'
import { base64Of } from '@/lib/transcription/audio'
import { opusOgg } from '@/lib/transcription/opus'

// Google AI Studio takes ~20 MB a request and NVIDIA ~25 MB; base64 grows the audio by a third.
export const MAX_AUDIO_BYTES = 14_000_000

export type MediaParts = Record<string, unknown>[]

const OUVIR = 'O material é a gravação em áudio acima, no lugar da transcrição: ouça do começo ao fim e use tudo o que foi dito, com os nomes que as pessoas dizem. Os minutos [▸ mm:ss] são os do áudio.'

const TAREFAS = 'Modelo LEVANTAMENTO DE TAREFAS. Uma linha por pedido ou compromisso dito: "- [ ] **o que fazer** · dono (ou "sem dono") · prazo dito (ou "sem prazo")", e embaixo a prova [▸ mm:ss] Nome: "literal".'

/** The user turn of the call: the light audio and what to do with it; null when it is not WebM Opus or is over the limit. */
export async function mediaParts(source: Blob, limit = MAX_AUDIO_BYTES): Promise<MediaParts | null> {
  const audio = await opusOgg(source)
  if (!audio || audio.size > limit) return null
  return [{ type: 'input_audio', input_audio: { data: await base64Of(audio), format: 'ogg' } }, { type: 'text', text: OUVIR }]
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
