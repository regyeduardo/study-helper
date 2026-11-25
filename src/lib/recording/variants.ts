/**
 * The ways to record a meeting that were measured (spec 007, história 3, research R12; numbers in medidas-gravacao.md): the video
 * bitrate at 5 frames per second, the order of the formats, the key frame and the hint that the picture is a screen with text. Audio is
 * Opus at 32 kb/s, as before. CHOSEN is the one that passed the measure: the lightest whose video is whole and whose text still reads.
 */

export type VariantId = 'A' | 'B' | 'C' | 'D' | 'E' | 'F'

export interface RecordingVariant {
  /** O: the optimized recording, apart from the measured A to F. */
  id: VariantId | 'O'
  /** What it is, for the measure. */
  label: string
  /** Video bitrate at 5 and at 30 frames per second. */
  videoBitsPerSecond: { 5: number; 30: number }
  /** Formats in order of preference; the first the browser records wins. */
  videoMimes: string[]
  /** A key frame at least this often (ms), where the browser takes the option. */
  keyFrameIntervalMs?: number
  /** The hint for the encoder: a screen with text keeps its detail ('text' also turns on AV1's tools for screens). */
  contentHint?: 'detail' | 'text'
}

const VP9_FIRST = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm', 'video/mp4']
const AV1_FIRST = ['video/webm;codecs=av01,opus', 'video/webm;codecs=av1,opus', ...VP9_FIRST]

export const VARIANTS: Record<VariantId, RecordingVariant> = {
  A: { id: 'A', label: 'hoje: 600 kb/s', videoBitsPerSecond: { 5: 600_000, 30: 2_500_000 }, videoMimes: VP9_FIRST },
  B: { id: 'B', label: 'VP9 350 kb/s, quadro-chave a cada 5 s, detalhe', videoBitsPerSecond: { 5: 350_000, 30: 1_500_000 }, videoMimes: VP9_FIRST, keyFrameIntervalMs: 5000, contentHint: 'detail' },
  C: { id: 'C', label: 'VP9 250 kb/s, quadro-chave a cada 5 s, detalhe', videoBitsPerSecond: { 5: 250_000, 30: 1_200_000 }, videoMimes: VP9_FIRST, keyFrameIntervalMs: 5000, contentHint: 'detail' },
  D: { id: 'D', label: 'AV1 200 kb/s (onde o navegador grava AV1), detalhe', videoBitsPerSecond: { 5: 200_000, 30: 1_000_000 }, videoMimes: AV1_FIRST, keyFrameIntervalMs: 5000, contentHint: 'detail' },
  E: { id: 'E', label: 'VP9 300 kb/s, quadro-chave a cada 10 s, detalhe', videoBitsPerSecond: { 5: 300_000, 30: 1_300_000 }, videoMimes: VP9_FIRST, keyFrameIntervalMs: 10_000, contentHint: 'detail' },
  F: { id: 'F', label: 'VP9 300 kb/s, quadro-chave quando o navegador quiser, detalhe', videoBitsPerSecond: { 5: 300_000, 30: 1_300_000 }, videoMimes: VP9_FIRST, contentHint: 'detail' },
}

/** The variant the app records with (medidas-gravacao.md). */
export const CHOSEN: VariantId = 'F'

/**
 * The optimized recording, an option of "Gravar a tela" (spec 007, FR-023, research R17; numbers in medidas-gravacao.md): 30 frames per
 * second, but the canvas hands a frame only when the screen changed (ScreenCanvas), VP9 up to 250 kb/s with the hint of text and a key
 * frame every 30 s. Chrome otherwise puts one every 100 frames (3 s at 30 fps), which made slides 3 times heavier; every 2 min, jumping
 * inside a stretch of motion took more than 2 s. AV1 was not lighter in motion and older iPhones do not play it.
 */
export const OPTIMIZED: RecordingVariant & { onlyChanges: true } = {
  id: 'O',
  label: 'otimizada: VP9 até 250 kb/s, só quando a tela muda, quadro-chave a cada 30 s, texto',
  videoBitsPerSecond: { 5: 250_000, 30: 250_000 },
  videoMimes: VP9_FIRST,
  keyFrameIntervalMs: 30_000,
  contentHint: 'text',
  onlyChanges: true,
}

export const AUDIO_BITS_PER_SECOND = 32_000

/** The options of the MediaRecorder for a variant: the first format the browser records, the bitrates and the key frame. */
export function recorderOptions(variant: RecordingVariant, fps: 5 | 30 | null, supports: (mime: string) => boolean): MediaRecorderOptions & { videoKeyFrameIntervalDuration?: number } {
  const mime = fps ? variant.videoMimes.find(supports) : undefined
  return {
    ...(mime ? { mimeType: mime } : {}),
    audioBitsPerSecond: AUDIO_BITS_PER_SECOND,
    ...(fps ? { videoBitsPerSecond: variant.videoBitsPerSecond[fps] } : {}),
    ...(fps && variant.keyFrameIntervalMs ? { videoKeyFrameIntervalDuration: variant.keyFrameIntervalMs } : {}),
  }
}
