/**
 * The audio of a recording at 16 kHz, decoded in pieces (T192, dono 27/11: "Corrija tudo… quero 0 problemas"). decodeAudioData decodes the
 * whole media at once at its own rate before resampling: for a 90 min stereo recording it took the Chromium of the server from 352 MB to
 * 4.460 MB (measured with --disable-gpu on 2 cores), more than the 3,8 GB of the whole server. Here WebCodecs decodes packet by packet
 * (Mediabunny reads the file in ranges), the channels are mixed the way Web Audio mixes them, and the same filter of before takes each one
 * to 16 kHz as it comes: what stays is the 16 kHz audio itself. Where WebCodecs cannot decode the audio, null: the caller goes the old way.
 */

const TARGET = 16000
/**
 * The filter of before: what decodeAudioData resampled with (Blink's SincResampler): 32 taps of a sinc cut at 0,9 of the lower Nyquist, in a
 * Blackman window (alpha 0,16). Flat to 4 kHz, -1,9 dB at 6 kHz, -11 dB at 8 kHz, -35 dB at 10 kHz (48 to 16 kHz). Kept the same, so the
 * transcription hears what it heard; measured on speech in Chromium, the two ways match within 57 to 60 dB below 5 kHz.
 */
const KERNEL = 32
const HALF = KERNEL / 2
const SCALE = 0.9

export interface Resampler {
  /** The output samples that the input so far makes certain. */
  push(input: Float32Array): Float32Array
  /** The rest, as if silence followed. */
  end(): Float32Array
}

const gcd = (a: number, b: number): number => (b ? gcd(b, a % b) : a)
const blackman = (x: number) => 0.42 - 0.5 * Math.cos(2 * Math.PI * x) + 0.08 * Math.cos(4 * Math.PI * x)

/**
 * From `from` Hz to `to` Hz. Output n sits at input position n·from/to and weighs the 32 input samples around it (silence before the
 * start and after the end). One kernel per distinct position between two samples (just one from 48 to 16 kHz); the result does not
 * depend on how the input is cut into pieces.
 */
export function resampler(from: number, to: number): Resampler {
  if (from === to) return { push: input => input.slice(), end: () => new Float32Array(0) }
  const scale = SCALE * Math.min(1, to / from)
  const step = gcd(from, to)
  const phases = to / step
  const kernel = new Float32Array(phases * KERNEL)
  for (let phase = 0; phase < phases; phase++) {
    const fraction = (phase * step) / to
    for (let j = 0; j < KERNEL; j++) {
      const t = fraction + HALF - 1 - j
      kernel[phase * KERNEL + j] = blackman(0.5 + t / KERNEL) * (t === 0 ? scale : Math.sin(scale * Math.PI * t) / (Math.PI * t))
    }
  }

  let buffer = new Float32Array(0)
  // absolute index of buffer[0], input received, next output
  let offset = 0
  let received = 0
  let next = 0
  const produce = (final: boolean): Float32Array => {
    const last = final ? Math.ceil((received * to) / from) : Math.max(next, Math.floor(((received - HALF) * to) / from) + 1)
    const out = new Float32Array(Math.max(0, last - next))
    let count = 0
    while (next < last) {
      const position = next * from
      const base = Math.floor(position / to)
      if (!final && base + HALF >= received) break
      const row = ((position % to) / step) * KERNEL
      const first = base - HALF + 1
      const at = first - offset
      let sum = 0
      if (first >= 0 && first + KERNEL <= received) {
        for (let j = 0; j < KERNEL; j++) sum += kernel[row + j] * buffer[at + j]
      } else {
        // the start and the end of the recording: silence outside it
        for (let j = 0; j < KERNEL; j++) {
          const k = first + j
          if (k >= 0 && k < received) sum += kernel[row + j] * buffer[at + j]
        }
      }
      out[count++] = sum
      next++
    }
    const keep = Math.max(0, Math.floor((next * from) / to) - HALF + 1)
    if (keep > offset) {
      buffer = buffer.slice(Math.min(buffer.length, keep - offset))
      offset = keep
    }
    return count === out.length ? out : out.slice(0, count)
  }
  return {
    push(input) {
      const joined = new Float32Array(buffer.length + input.length)
      joined.set(buffer)
      joined.set(input, buffer.length)
      buffer = joined
      received += input.length
      return produce(false)
    },
    end: () => produce(true),
  }
}

/**
 * At most `limit` channels, mixed as Web Audio's "speakers" mixing does (what the OfflineAudioContext of before did): stereo and mono stay;
 * stereo to mono is the mean; quad and 5.1 (L, R, C, LFE, SL, SR) as in the spec, without the LFE; any other layout keeps its first channels.
 */
export function downmix(planes: Float32Array[], limit: number): Float32Array[] {
  const count = planes.length
  if (count <= limit) return planes
  const length = planes[0].length
  const mix = (weights: number[]): Float32Array => {
    const out = new Float32Array(length)
    weights.forEach((weight, channel) => {
      if (!weight) return
      const plane = planes[channel]
      for (let index = 0; index < length; index++) out[index] += weight * plane[index]
    })
    return out
  }
  const half = Math.SQRT1_2
  if (limit === 1) {
    if (count === 2) return [mix([0.5, 0.5])]
    if (count === 4) return [mix([0.25, 0.25, 0.25, 0.25])]
    if (count === 6) return [mix([half, half, 1, 0, 0.5, 0.5])]
  }
  if (limit === 2) {
    if (count === 4) return [mix([0.5, 0, 0.5, 0]), mix([0, 0.5, 0, 0.5])]
    if (count === 6) return [mix([1, 0, half, 0, half, 0]), mix([0, 1, half, 0, 0, half])]
  }
  return planes.slice(0, limit)
}

/** The 16 kHz channels (at most `limit`) of the audio of `blob`, decoded in pieces; null where WebCodecs cannot do it here. */
export async function streamDecode16k(blob: Blob, limit: number): Promise<Float32Array[] | null> {
  if (typeof AudioDecoder === 'undefined' || !AudioDecoder) return null
  try {
    const { ALL_FORMATS, AudioSampleSink, BlobSource, Input } = await import('mediabunny')
    const input = new Input({ source: new BlobSource(blob), formats: ALL_FORMATS })
    try {
      const track = await input.getPrimaryAudioTrack()
      if (!track || !(await track.canDecode())) return null
      const duration = await track.computeDuration()
      let outputs: Float32Array[] = []
      let steps: Resampler[] = []
      let rate = 0
      let written = 0
      const write = (pieces: Float32Array[]) => {
        const length = pieces[0]?.length ?? 0
        if (!length) return
        if (written + length > outputs[0].length) outputs = outputs.map(old => {
          const grown = new Float32Array(Math.ceil((written + length) * 1.25))
          grown.set(old.subarray(0, written))
          return grown
        })
        pieces.forEach((piece, channel) => outputs[channel].set(piece, written))
        written += length
      }
      for await (const sample of new AudioSampleSink(track).samples()) {
        try {
          if (!rate) {
            rate = sample.sampleRate
            const channels = Math.min(sample.numberOfChannels, limit) || 1
            outputs = Array.from({ length: channels }, () => new Float32Array(Math.ceil((Math.max(0, duration) + 1) * TARGET)))
            steps = Array.from({ length: channels }, () => resampler(rate, TARGET))
          }
          // the decoder changed its rate or its channels in the middle: the old way, which handles it
          if (sample.sampleRate !== rate || (Math.min(sample.numberOfChannels, limit) || 1) !== steps.length) return null
          // what comes before the start (the codec's own delay) is not audio of the recording
          const skip = sample.timestamp < 0 ? Math.min(sample.numberOfFrames, Math.round(-sample.timestamp * rate)) : 0
          const frames = sample.numberOfFrames - skip
          if (frames <= 0) continue
          const planes = Array.from({ length: sample.numberOfChannels }, (_, planeIndex) => {
            const plane = new Float32Array(frames)
            sample.copyTo(plane, { planeIndex, format: 'f32-planar', frameOffset: skip, frameCount: frames })
            return plane
          })
          write(downmix(planes, limit).map((plane, channel) => steps[channel].push(plane)))
        } finally {
          sample.close()
        }
      }
      if (!rate) return null
      write(steps.map(step => step.end()))
      return outputs.map(output => output.subarray(0, written))
    } finally {
      input.dispose()
    }
  } catch {
    return null
  }
}
