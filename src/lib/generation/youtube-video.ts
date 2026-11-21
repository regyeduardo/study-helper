// A YouTube link AS VIDEO for the writing model ("Só o vídeo" / "Transcrição + vídeo"): it watches the speech and the screen.
// Only Gemini watches a YouTube link (public videos only): by Google's own API, as file_data.file_uri
// (ai.google.dev/gemini-api/docs/video-understanding), or through OpenRouter, as a video_url part that it sends only to
// Google AI Studio (openrouter.ai/docs/features/multimodal/videos). Google's OpenAI-compatible door takes no video.
import type { AiConfig, AiProviderId } from '@/types/domain'
import { type MediaInfo, modelByUid, providerById } from '@/lib/ai/config'
import type { MediaParts } from '@/lib/generation/from-media'

const TELA = 'Use também o que aparece na tela (slides, código, diagramas, fórmulas, tabelas, textos e nomes escritos) como parte do conteúdo, com os termos como estão escritos.'

export const ASSISTIR = `O material é o vídeo do YouTube acima, no lugar da transcrição: assista do começo ao fim, ouça tudo o que foi dito e olhe a tela. ${TELA} Os minutos [▸ mm:ss] são os do vídeo.`

export const ASSISTIR_E_LER = `O material é o vídeo do YouTube acima e, abaixo dele, a transcrição desse vídeo: assista do começo ao fim e use os dois, os nomes e termos como a tela ou a transcrição os escrevem e o que a transcrição tiver errado como se ouve. ${TELA} Os minutos [▸ mm:ss] são os do vídeo.`

// Gemini models that are not a chat that sees video
const NOT_WATCHING = /embedding|tts|image|native-audio|live|aqa/i

/** The model watches a YouTube link: a Gemini on Google Gemini or on OpenRouter, unless its list (or "Testar") says it takes no video. */
export function watchesYoutube(provider: AiProviderId | undefined, model: string | undefined, media: MediaInfo | null): boolean {
  if (!provider || !model || media?.video === false || NOT_WATCHING.test(model)) return false
  if (provider === 'gemini') return /^(models\/)?gemini-/i.test(model)
  if (provider === 'openrouter') return /^google\/gemini-/i.test(model)
  return false
}

/** Why the model cannot watch a YouTube link, in plain words; null when it can. */
export function cannotWatch(config: AiConfig, uid: string | undefined, media: MediaInfo | null): string | null {
  const model = modelByUid(config, uid)
  if (!model) return 'Escolha um modelo que assista vídeo do YouTube (um Gemini).'
  if (watchesYoutube(providerById(config, model.pid)?.type, model.mid, media)) return null
  return `O ${model.name} não assiste vídeo do YouTube: só um Gemini assiste, pelo Google Gemini ou pelo OpenRouter.`
}

/** The user turn of the call: the link as video and what to do with it. */
export function youtubeParts(url: string): MediaParts {
  return [{ type: 'video_url', video_url: { url } }, { type: 'text', text: ASSISTIR }]
}
