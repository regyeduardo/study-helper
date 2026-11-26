import { AUDIO_BITS_PER_SECOND, OPTIMIZED } from '@/lib/recording/variants'

/**
 * "Converter para o formato otimizado" (spec 007, T184, research R19; dono, 25/11): a video sent to the app becomes the format of the
 * optimized recording (T174) before anything keeps or reads it: VP9 up to 250 kb/s with a key frame every 30 s and Opus at 32 kb/s, in a
 * WebM. The picture keeps its size (owner's choice); a bigger one than 1080p gets the same bits per point, or a 4K would turn into a blur.
 * Mediabunny reads the file (MP4, MOV, WebM, MKV…) and does the work with the browser's WebCodecs; it loads only when a video converts.
 */

/** Above this, the option comes checked (owner's choice: 200 MB). */
export const OPTIMIZE_ABOVE_BYTES = 200 * 1024 * 1024

const FULL_HD = 1920 * 1080

export const optimizeByDefault = (sizeBytes: number): boolean => sizeBytes > OPTIMIZE_ABOVE_BYTES

/** The rate of the optimized recording up to 1080p; above it, the same bits per point. */
export function optimizedBitrate(width: number, height: number): number {
  return Math.round(OPTIMIZED.videoBitsPerSecond[30] * Math.max(1, (width * height) / FULL_HD))
}

/** The same name, in .webm. */
export function optimizedName(name: string): string {
  return `${name.replace(/\.[^./\\]{1,5}$/, '') || 'video'}.webm`
}

/** This browser converts at all (WebCodecs); whether it reads the file's own video is seen when it converts. */
export function canOptimize(): boolean {
  return ['VideoEncoder', 'VideoDecoder', 'AudioEncoder', 'AudioDecoder'].every(name => name in globalThis)
}

/** Why a video was not converted: it goes as it is. */
export class NotConvertible extends Error {}

const WHY: Record<string, string> = {
  undecodable_source_codec: 'este navegador não lê o vídeo deste arquivo',
  unknown_source_codec: 'o formato do vídeo deste arquivo não é conhecido',
  no_encodable_target_codec: 'este navegador não grava no formato otimizado',
}

/** The video in the optimized format, as a new file; NotConvertible (with the reason) when this browser cannot convert it. */
export async function convertVideo(file: File, onProgress: (fraction: number) => void, signal: AbortSignal): Promise<File> {
  if (!canOptimize()) throw new NotConvertible('este navegador não converte vídeo')
  const { ALL_FORMATS, BlobSource, BufferTarget, Conversion, Input, Output, WebMOutputFormat } = await import('mediabunny')
  const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS })
  const target = new BufferTarget()
  const output = new Output({ format: new WebMOutputFormat(), target })
  const conversion = await Conversion.init({
    input,
    output,
    tracks: 'primary',
    video: async track => ({
      codec: 'vp9',
      bitrate: optimizedBitrate(await track.getDisplayWidth(), await track.getDisplayHeight()),
      keyFrameInterval: (OPTIMIZED.keyFrameIntervalMs ?? 30_000) / 1000,
      forceTranscode: true,
    }),
    audio: { codec: 'opus', bitrate: AUDIO_BITS_PER_SECOND, forceTranscode: true },
  })
  // the picture has to come: a file of sound alone would take the place of the video
  const lostVideo = conversion.discardedTracks.find(item => item.track.isVideoTrack())
  if (!conversion.isValid || lostVideo || !conversion.utilizedTracks.some(track => track.isVideoTrack())) {
    throw new NotConvertible(WHY[lostVideo?.reason ?? ''] ?? 'o vídeo deste arquivo não pôde ser lido')
  }
  conversion.onProgress = progress => onProgress(progress)
  const stop = () => void conversion.cancel()
  signal.addEventListener('abort', stop, { once: true })
  try {
    await conversion.execute()
  } finally {
    signal.removeEventListener('abort', stop)
  }
  if (signal.aborted) throw new DOMException('Cancelado por você.', 'AbortError')
  if (!target.buffer) throw new Error('A conversão não devolveu o vídeo.')
  return new File([target.buffer], optimizedName(file.name), { type: 'video/webm' })
}
