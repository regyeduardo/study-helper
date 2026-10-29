export const SAMPLE_RATE = 16000
const SILENCE_THRESHOLD_DB = -40
const SILENCE_KEPT_SECONDS = 1
const FRAME_SECONDS = 0.02

async function render16k(blob: Blob, channelLimit: number): Promise<Float32Array[]> {
  const bytes = await blob.arrayBuffer()
  const context = new OfflineAudioContext(1, 1, SAMPLE_RATE)
  const decoded = await context.decodeAudioData(bytes)
  const channels = Math.min(decoded.numberOfChannels, channelLimit) || 1
  const length = Math.ceil(decoded.duration * SAMPLE_RATE)
  const offline = new OfflineAudioContext(channels, Math.max(length, 1), SAMPLE_RATE)
  const source = offline.createBufferSource()
  source.buffer = decoded
  source.connect(offline.destination)
  source.start()
  const rendered = await offline.startRendering()
  return Array.from({ length: channels }, (_, index) => rendered.getChannelData(index).slice())
}

export async function decodeToMono16k(blob: Blob): Promise<Float32Array> {
  return (await render16k(blob, 1))[0]
}

export async function decodeChannels16k(blob: Blob): Promise<Float32Array[]> {
  return render16k(blob, 2)
}

export function mixedDown(channels: Float32Array[]): Float32Array {
  if (channels.length === 1) return channels[0]
  const mixed = new Float32Array(channels[0].length)
  for (let index = 0; index < mixed.length; index++) mixed[index] = (channels[0][index] + channels[1][index]) / 2
  return mixed
}

export const AUDIBLE_LEVEL = 10 ** (SILENCE_THRESHOLD_DB / 20)

const LEVEL_WINDOW_SECONDS = 0.4
const TARGET_LEVEL = 0.1
const MAX_GAIN = 40
const HIGH_PASS_HZ = 80

function voiceLevel(samples: Float32Array): number {
  const size = Math.round(LEVEL_WINDOW_SECONDS * SAMPLE_RATE)
  let energy = 0
  let count = 0
  for (let start = 0; start < samples.length; start += size) {
    const end = Math.min(start + size, samples.length)
    let window = 0
    for (let index = start; index < end; index++) window += samples[index] * samples[index]
    if (Math.sqrt(window / Math.max(1, end - start)) < AUDIBLE_LEVEL) continue
    energy += window
    count += end - start
  }
  return count ? Math.sqrt(energy / count) : 0
}

function leveled(samples: Float32Array): Float32Array {
  const level = voiceLevel(samples)
  const gain = level ? Math.min(MAX_GAIN, TARGET_LEVEL / level) : 1
  const keep = 1 / (1 + (2 * Math.PI * HIGH_PASS_HZ) / SAMPLE_RATE)
  const out = new Float32Array(samples.length)
  let previousIn = 0
  let previousOut = 0
  for (let index = 0; index < samples.length; index++) {
    previousOut = keep * (previousOut + samples[index] - previousIn)
    previousIn = samples[index]
    out[index] = previousOut * gain
  }
  return out
}

/** Each side (microphone, computer) at the same voice level before mixing, so a quiet microphone is still heard. */
export function balancedMix(channels: Float32Array[]): Float32Array {
  const sides = channels.map(leveled)
  const mixed = new Float32Array(sides[0].length)
  for (let index = 0; index < mixed.length; index++) {
    let sum = 0
    for (const side of sides) sum += side[index] ?? 0
    mixed[index] = Math.tanh(sum)
  }
  return mixed
}

export function loudness(samples: Float32Array, fromSeconds: number, toSeconds: number): number {
  const slice = samples.subarray(Math.max(0, Math.round(fromSeconds * SAMPLE_RATE)), Math.max(0, Math.round(toSeconds * SAMPLE_RATE)))
  let energy = 0
  for (let index = 0; index < slice.length; index++) energy += slice[index] * slice[index]
  return Math.sqrt(energy / Math.max(slice.length, 1))
}

export function durationOf(samples: Float32Array): number {
  return samples.length / SAMPLE_RATE
}

export function withoutSilence(samples: Float32Array): Float32Array {
  const frame = Math.round(FRAME_SECONDS * SAMPLE_RATE)
  const keptQuiet = Math.round(SILENCE_KEPT_SECONDS / FRAME_SECONDS)
  const pieces: Float32Array[] = []
  let quietFrames = 0
  for (let start = 0; start < samples.length; start += frame) {
    const slice = samples.subarray(start, Math.min(start + frame, samples.length))
    let energy = 0
    for (let index = 0; index < slice.length; index++) energy += slice[index] * slice[index]
    const loud = Math.sqrt(energy / Math.max(slice.length, 1)) >= AUDIBLE_LEVEL
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

const WAV_HEADER_BYTES = 44

export async function base64Of(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer())
  let binary = ''
  for (let at = 0; at < bytes.length; at += 0x8000) binary += String.fromCharCode(...bytes.subarray(at, at + 0x8000))
  return btoa(binary)
}

export async function wavClip(wav: Blob, fromSeconds: number, toSeconds: number): Promise<Blob> {
  const bytes = new Uint8Array(await wav.arrayBuffer())
  const view = new DataView(bytes.buffer)
  const sampleRate = view.getUint32(24, true)
  const from = WAV_HEADER_BYTES + Math.round(fromSeconds * sampleRate) * 2
  const data = bytes.slice(Math.min(from, bytes.length), Math.min(WAV_HEADER_BYTES + Math.round(toSeconds * sampleRate) * 2, bytes.length))
  const header = bytes.slice(0, WAV_HEADER_BYTES)
  const sizes = new DataView(header.buffer)
  sizes.setUint32(4, 36 + data.length, true)
  sizes.setUint32(40, data.length, true)
  return new Blob([header, data], { type: 'audio/wav' })
}
