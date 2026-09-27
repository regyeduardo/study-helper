export const SAMPLE_RATE = 16000
const SILENCE_THRESHOLD_DB = -40
const SILENCE_KEPT_SECONDS = 1
const FRAME_SECONDS = 0.02

export async function decodeToMono16k(blob: Blob): Promise<Float32Array> {
  const bytes = await blob.arrayBuffer()
  const context = new OfflineAudioContext(1, 1, SAMPLE_RATE)
  const decoded = await context.decodeAudioData(bytes)
  const length = Math.ceil(decoded.duration * SAMPLE_RATE)
  const offline = new OfflineAudioContext(1, Math.max(length, 1), SAMPLE_RATE)
  const source = offline.createBufferSource()
  source.buffer = decoded
  source.connect(offline.destination)
  source.start()
  const rendered = await offline.startRendering()
  return rendered.getChannelData(0).slice()
}

export function durationOf(samples: Float32Array): number {
  return samples.length / SAMPLE_RATE
}

export function withoutSilence(samples: Float32Array): Float32Array {
  const frame = Math.round(FRAME_SECONDS * SAMPLE_RATE)
  const threshold = 10 ** (SILENCE_THRESHOLD_DB / 20)
  const keptQuiet = Math.round(SILENCE_KEPT_SECONDS / FRAME_SECONDS)
  const pieces: Float32Array[] = []
  let quietFrames = 0
  for (let start = 0; start < samples.length; start += frame) {
    const slice = samples.subarray(start, Math.min(start + frame, samples.length))
    let energy = 0
    for (let index = 0; index < slice.length; index++) energy += slice[index] * slice[index]
    const loud = Math.sqrt(energy / Math.max(slice.length, 1)) >= threshold
    quietFrames = loud ? 0 : quietFrames + 1
    if (loud || quietFrames <= keptQuiet) pieces.push(slice)
  }
  const total = pieces.reduce((sum, piece) => sum + piece.length, 0)
  if (!total) return samples
  const out = new Float32Array(total)
  let offset = 0
  for (const piece of pieces) {
    out.set(piece, offset)
    offset += piece.length
  }
  return out
}

export function encodeWav(samples: Float32Array, sampleRate = SAMPLE_RATE): Blob {
  const buffer = new ArrayBuffer(44 + samples.length * 2)
  const view = new DataView(buffer)
  const write = (offset: number, text: string) => [...text].forEach((char, index) => view.setUint8(offset + index, char.charCodeAt(0)))
  write(0, 'RIFF')
  view.setUint32(4, 36 + samples.length * 2, true)
  write(8, 'WAVE')
  write(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * 2, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  write(36, 'data')
  view.setUint32(40, samples.length * 2, true)
  for (let index = 0; index < samples.length; index++) {
    const value = Math.max(-1, Math.min(1, samples[index]))
    view.setInt16(44 + index * 2, value < 0 ? value * 0x8000 : value * 0x7fff, true)
  }
  return new Blob([buffer], { type: 'audio/wav' })
}

export function splitSamples(samples: Float32Array, seconds: number): Float32Array[] {
  const size = Math.round(seconds * SAMPLE_RATE)
  const parts: Float32Array[] = []
  for (let start = 0; start < samples.length; start += size) parts.push(samples.subarray(start, Math.min(start + size, samples.length)))
  return parts
}
