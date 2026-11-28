/**
 * T202 (research R30): the recording keeps the volume of each channel every 50 ms (the microphone on the left, the computer on the
 * right), so the server knows which words came from who recorded without decoding the audio (decoding 1h30 costs ~20 s of CPU).
 * One byte a window, on a decibel scale from -90 to 0 dBFS (0.35 dB a step): a ratio of loudness (the microphone twice the computer)
 * survives it. 1h30 is ~216 KB, the part `volume`.
 */

export const VOLUME_STEP = 0.05
const FLOOR_DB = -90

/** The part `volume` of a recording: the step (seconds) and one byte a window of each channel, in base64. */
export interface VolumePart {
  step: number
  microphone: string
  computer: string
}

/** The level of each window back from the part (RMS, 0 to 1): what `microphoneWords` and `computerWords` read instead of the audio. */
export interface ChannelVolumes {
  step: number
  microphone: Float32Array
  computer: Float32Array
}

export function levelByte(rms: number): number {
  if (!(rms > 0)) return 0
  const db = 20 * Math.log10(rms)
  return Math.max(0, Math.min(255, Math.round(((db - FLOOR_DB) / -FLOOR_DB) * 255)))
}

export function rmsOfByte(byte: number): number {
  if (byte <= 0) return 0
  return 10 ** (((byte / 255) * -FLOOR_DB + FLOOR_DB) / 20)
}

const toBase64 = (bytes: number[]): string => {
  let binary = ''
  for (let at = 0; at < bytes.length; at += 0x8000) binary += String.fromCharCode(...bytes.slice(at, at + 0x8000))
  return btoa(binary)
}

const fromBase64 = (text: string): Float32Array => {
  const binary = atob(text)
  const levels = new Float32Array(binary.length)
  for (let at = 0; at < binary.length; at++) levels[at] = rmsOfByte(binary.charCodeAt(at))
  return levels
}

/** The windows of a recording, in order (a paused recording adds nothing: the windows follow the recording's clock). */
export class VolumeEnvelope {
  private readonly microphone: number[] = []
  private readonly computer: number[] = []

  get count(): number {
    return this.microphone.length
  }

  push(microphoneRms: number, computerRms: number): void {
    this.microphone.push(levelByte(microphoneRms))
    this.computer.push(levelByte(computerRms))
  }

  result(): VolumePart {
    return { step: VOLUME_STEP, microphone: toBase64(this.microphone), computer: toBase64(this.computer) }
  }
}

export function volumesOf(part: VolumePart): ChannelVolumes {
  return { step: part.step, microphone: fromBase64(part.microphone), computer: fromBase64(part.computer) }
}

/** The loudness of a span (RMS), from the windows it touches, each by how much of it falls in the span. */
export function windowLoudness(levels: Float32Array, step: number, from: number, to: number): number {
  const first = Math.max(0, Math.floor(from / step))
  const last = Math.min(levels.length - 1, Math.ceil(to / step) - 1)
  let energy = 0
  let weight = 0
  for (let index = first; index <= last; index++) {
    const overlap = Math.min(to, (index + 1) * step) - Math.max(from, index * step)
    if (overlap <= 0) continue
    energy += levels[index] * levels[index] * overlap
    weight += overlap
  }
  return weight ? Math.sqrt(energy / weight) : 0
}

/**
 * The AudioWorklet that measures the volume of the two channels of the recording (0 the microphone, 1 the computer): it counts sample
 * by sample, so the windows stay exactly 50 ms of audio over 1h30 (a window of whole blocks of 128 would drift 72 s).
 */
export const VOLUME_TAP_SOURCE = `
class VolumeTap extends AudioWorkletProcessor {
  constructor(options) {
    super()
    this.size = options.processorOptions.size
    this.sums = [0, 0]
    this.count = 0
  }
  process(inputs) {
    const input = inputs[0]
    const left = input && input[0]
    if (!left) return true
    const right = input[1] || left
    for (let at = 0; at < left.length; at++) {
      this.sums[0] += left[at] * left[at]
      this.sums[1] += right[at] * right[at]
      if (++this.count === this.size) {
        this.port.postMessage([Math.sqrt(this.sums[0] / this.size), Math.sqrt(this.sums[1] / this.size)])
        this.sums = [0, 0]
        this.count = 0
      }
    }
    return true
  }
}
registerProcessor('study-helper-volume', VolumeTap)
`
