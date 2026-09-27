import type { InferenceSession } from 'onnxruntime-web'

import { SAMPLE_RATE } from '@/lib/transcription/audio'
import type { Progress, SpeakerTurn } from '@/lib/transcription/types'

const SEGMENTATION_URL = 'https://huggingface.co/csukuangfj/sherpa-onnx-pyannote-segmentation-3-0/resolve/main/model.onnx'
const EMBEDDING_URL = 'https://huggingface.co/csukuangfj/speaker-embedding-models/resolve/main/wespeaker_en_voxceleb_CAM%2B%2B.onnx'
const MODEL_CACHE = 'study-helper-models'

const CLUSTERING_THRESHOLD = 0.9
const MIN_SPEECH_SECONDS = 0.3
const MIN_SILENCE_SECONDS = 0.5
const WINDOW_SECONDS = 10
const STEP_SECONDS = 2.5
const LOCAL_SPEAKERS = 3
const POWERSET: number[][] = [[], [0], [1], [2], [0, 1], [0, 2], [1, 2]]

const FBANK_BINS = 80
const FRAME_LENGTH = 400
const FRAME_SHIFT = 160
const FFT_SIZE = 512

interface Sessions {
  ort: typeof import('onnxruntime-web')
  segmentation: InferenceSession
  embedding: InferenceSession
}

let loading: Promise<Sessions> | null = null

async function modelBytes(url: string): Promise<Uint8Array> {
  try {
    const cache = await caches.open(MODEL_CACHE)
    const hit = await cache.match(url)
    if (hit) return new Uint8Array(await hit.arrayBuffer())
    const response = await fetch(url)
    if (!response.ok) throw new Error(`modelo não baixou (${response.status})`)
    await cache.put(url, response.clone())
    return new Uint8Array(await response.arrayBuffer())
  } catch (error) {
    if (typeof caches === 'undefined') {
      const response = await fetch(url)
      return new Uint8Array(await response.arrayBuffer())
    }
    throw error
  }
}

async function sessions(progress: Progress): Promise<Sessions> {
  if (!loading) {
    loading = (async () => {
      progress('Baixando o separador de vozes (só na primeira vez)')
      const ort = await import('onnxruntime-web')
      const [segmentationBytes, embeddingBytes] = await Promise.all([modelBytes(SEGMENTATION_URL), modelBytes(EMBEDDING_URL)])
      const options = { executionProviders: ['wasm'] }
      return {
        ort,
        segmentation: await ort.InferenceSession.create(segmentationBytes, options),
        embedding: await ort.InferenceSession.create(embeddingBytes, options),
      }
    })()
    loading.catch(() => (loading = null))
  }
  return loading
}

function melScale(frequency: number): number {
  return 1127 * Math.log(1 + frequency / 700)
}

let melBank: Float32Array[] | null = null

function melFilters(): Float32Array[] {
  if (melBank) return melBank
  const bins = FFT_SIZE / 2
  const low = melScale(20)
  const high = melScale(SAMPLE_RATE / 2)
  const delta = (high - low) / (FBANK_BINS + 1)
  melBank = Array.from({ length: FBANK_BINS }, (_, bin) => {
    const left = low + bin * delta
    const center = low + (bin + 1) * delta
    const right = low + (bin + 2) * delta
    const weights = new Float32Array(bins)
    for (let index = 0; index < bins; index++) {
      const mel = melScale((SAMPLE_RATE * index) / FFT_SIZE)
      if (mel > left && mel < right) weights[index] = mel <= center ? (mel - left) / (center - left) : (right - mel) / (right - center)
    }
    return weights
  })
  return melBank
}

function powerSpectrum(frame: Float32Array): Float32Array {
  const real = new Float32Array(FFT_SIZE)
  const imaginary = new Float32Array(FFT_SIZE)
  real.set(frame)
  for (let index = 1, swap = 0; index < FFT_SIZE; index++) {
    let bit = FFT_SIZE >> 1
    for (; swap & bit; bit >>= 1) swap ^= bit
    swap ^= bit
    if (index < swap) {
      ;[real[index], real[swap]] = [real[swap], real[index]]
    }
  }
  for (let size = 2; size <= FFT_SIZE; size *= 2) {
    const angle = (-2 * Math.PI) / size
    for (let start = 0; start < FFT_SIZE; start += size) {
      for (let offset = 0; offset < size / 2; offset++) {
        const cos = Math.cos(angle * offset)
        const sin = Math.sin(angle * offset)
        const even = start + offset
        const odd = even + size / 2
        const oddReal = real[odd] * cos - imaginary[odd] * sin
        const oddImaginary = real[odd] * sin + imaginary[odd] * cos
        real[odd] = real[even] - oddReal
        imaginary[odd] = imaginary[even] - oddImaginary
        real[even] += oddReal
        imaginary[even] += oddImaginary
      }
    }
  }
  const power = new Float32Array(FFT_SIZE / 2)
  for (let index = 0; index < power.length; index++) power[index] = real[index] ** 2 + imaginary[index] ** 2
  return power
}

export function fbank(samples: Float32Array): { data: Float32Array; frames: number } {
  const frames = samples.length < FRAME_LENGTH ? 0 : 1 + Math.floor((samples.length - FRAME_LENGTH) / FRAME_SHIFT)
  const window = Float32Array.from({ length: FRAME_LENGTH }, (_, index) => Math.pow(0.5 - 0.5 * Math.cos((2 * Math.PI * index) / (FRAME_LENGTH - 1)), 0.85))
  const filters = melFilters()
  const data = new Float32Array(frames * FBANK_BINS)
  for (let frameIndex = 0; frameIndex < frames; frameIndex++) {
    const frame = new Float32Array(FRAME_LENGTH)
    let mean = 0
    for (let index = 0; index < FRAME_LENGTH; index++) {
      frame[index] = samples[frameIndex * FRAME_SHIFT + index] * 32768
      mean += frame[index]
    }
    mean /= FRAME_LENGTH
    for (let index = FRAME_LENGTH - 1; index >= 0; index--) {
      const centered = frame[index] - mean
      const previous = index > 0 ? frame[index - 1] - mean : centered
      frame[index] = (centered - 0.97 * previous) * window[index]
    }
    const power = powerSpectrum(frame)
    for (let bin = 0; bin < FBANK_BINS; bin++) {
      let energy = 0
      const weights = filters[bin]
      for (let index = 0; index < power.length; index++) energy += weights[index] * power[index]
      data[frameIndex * FBANK_BINS + bin] = Math.log(Math.max(energy, 1.1920929e-7))
    }
  }
  for (let bin = 0; bin < FBANK_BINS; bin++) {
    let sum = 0
    for (let frameIndex = 0; frameIndex < frames; frameIndex++) sum += data[frameIndex * FBANK_BINS + bin]
    const mean = frames ? sum / frames : 0
    for (let frameIndex = 0; frameIndex < frames; frameIndex++) data[frameIndex * FBANK_BINS + bin] -= mean
  }
  return { data, frames }
}

interface LocalSpeaker {
  window: number
  local: number
  activity: Float32Array
  embedding: Float32Array
}

function normalize(vector: Float32Array): Float32Array {
  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0)) || 1
  return vector.map(value => value / norm)
}

function cosineDistance(left: Float32Array, right: Float32Array): number {
  let dot = 0
  for (let index = 0; index < left.length; index++) dot += left[index] * right[index]
  return 1 - dot
}

export function clusterEmbeddings(embeddings: Float32Array[], threshold = CLUSTERING_THRESHOLD): number[] {
  const clusters = embeddings.map((embedding, index) => ({ members: [index], centroid: embedding }))
  while (clusters.length > 1) {
    let best = Infinity
    let pair: [number, number] = [0, 0]
    for (let left = 0; left < clusters.length; left++) {
      for (let right = left + 1; right < clusters.length; right++) {
        const distance = cosineDistance(clusters[left].centroid, clusters[right].centroid)
        if (distance < best) {
          best = distance
          pair = [left, right]
        }
      }
    }
    if (best > threshold) break
    const [left, right] = pair
    const members = [...clusters[left].members, ...clusters[right].members]
    const centroid = new Float32Array(embeddings[0].length)
    for (const member of members) embeddings[member].forEach((value, index) => (centroid[index] += value / members.length))
    clusters[left] = { members, centroid: normalize(centroid) }
    clusters.splice(right, 1)
  }
  const labels = new Array<number>(embeddings.length)
  clusters
    .sort((left, right) => Math.min(...left.members) - Math.min(...right.members))
    .forEach((cluster, label) => cluster.members.forEach(member => (labels[member] = label)))
  return labels
}

async function embed(session: Sessions, samples: Float32Array): Promise<Float32Array | null> {
  const { data, frames } = fbank(samples)
  if (frames < 10) return null
  const input = new session.ort.Tensor('float32', data, [1, frames, FBANK_BINS])
  const output = await session.embedding.run({ [session.embedding.inputNames[0]]: input })
  return normalize(Float32Array.from(output[session.embedding.outputNames[0]].data as Float32Array))
}

export async function speakerTurns(samples: Float32Array, progress: Progress): Promise<SpeakerTurn[]> {
  const session = await sessions(progress)
  const windowSize = WINDOW_SECONDS * SAMPLE_RATE
  const step = STEP_SECONDS * SAMPLE_RATE
  const starts: number[] = []
  for (let start = 0; start === 0 || start + windowSize - step < samples.length; start += step) starts.push(start)

  const locals: LocalSpeaker[] = []
  let frameSeconds = 0
  for (const [windowIndex, start] of starts.entries()) {
    progress('Separando quem fala', windowIndex / starts.length)
    const chunk = new Float32Array(windowSize)
    chunk.set(samples.subarray(start, Math.min(start + windowSize, samples.length)))
    const input = new session.ort.Tensor('float32', chunk, [1, 1, windowSize])
    const output = await session.segmentation.run({ [session.segmentation.inputNames[0]]: input })
    const scores = output[session.segmentation.outputNames[0]]
    const [, frames, classes] = scores.dims as number[]
    frameSeconds = WINDOW_SECONDS / frames
    const values = scores.data as Float32Array
    const activity = Array.from({ length: LOCAL_SPEAKERS }, () => new Float32Array(frames))
    for (let frame = 0; frame < frames; frame++) {
      let best = 0
      for (let klass = 1; klass < classes; klass++) if (values[frame * classes + klass] > values[frame * classes + best]) best = klass
      for (const speaker of POWERSET[best]) activity[speaker][frame] = 1
    }
    for (let local = 0; local < LOCAL_SPEAKERS; local++) {
      const active = activity[local].reduce((sum, value) => sum + value, 0) * frameSeconds
      if (active < MIN_SPEECH_SECONDS) continue
      const pieces: Float32Array[] = []
      for (let frame = 0; frame < frames; frame++) {
        if (!activity[local][frame]) continue
        const from = Math.round(frame * frameSeconds * SAMPLE_RATE)
        pieces.push(chunk.subarray(from, Math.min(from + Math.ceil(frameSeconds * SAMPLE_RATE), windowSize)))
      }
      const joined = new Float32Array(pieces.reduce((sum, piece) => sum + piece.length, 0))
      let offset = 0
      for (const piece of pieces) {
        joined.set(piece, offset)
        offset += piece.length
      }
      const embedding = await embed(session, joined)
      if (embedding) locals.push({ window: windowIndex, local, activity: activity[local], embedding })
    }
  }
  if (!locals.length) return []

  const labels = clusterEmbeddings(locals.map(item => item.embedding))
  const speakers = Math.max(...labels) + 1
  const totalFrames = Math.ceil(samples.length / SAMPLE_RATE / frameSeconds)
  const score = Array.from({ length: speakers }, () => new Float32Array(totalFrames))
  const coverage = new Float32Array(totalFrames)
  for (const start of starts) {
    const first = Math.round(start / SAMPLE_RATE / frameSeconds)
    const frames = Math.round(WINDOW_SECONDS / frameSeconds)
    for (let frame = 0; frame < frames && first + frame < totalFrames; frame++) coverage[first + frame]++
  }
  locals.forEach((item, index) => {
    const first = Math.round(starts[item.window] / SAMPLE_RATE / frameSeconds)
    item.activity.forEach((value, frame) => {
      if (first + frame < totalFrames) score[labels[index]][first + frame] += value
    })
  })

  const turns: SpeakerTurn[] = []
  for (let speaker = 0; speaker < speakers; speaker++) {
    let open: number | null = null
    for (let frame = 0; frame <= totalFrames; frame++) {
      const active = frame < totalFrames && coverage[frame] > 0 && score[speaker][frame] / coverage[frame] >= 0.5
      if (active && open === null) open = frame
      if (!active && open !== null) {
        turns.push({ start: open * frameSeconds, end: frame * frameSeconds, speaker: `Falante ${speaker + 1}` })
        open = null
      }
    }
  }
  return mergeTurns(turns)
}

function mergeTurns(turns: SpeakerTurn[]): SpeakerTurn[] {
  const bySpeaker = new Map<string, SpeakerTurn[]>()
  for (const turn of turns.sort((left, right) => left.start - right.start)) {
    const list = bySpeaker.get(turn.speaker) ?? []
    const last = list[list.length - 1]
    if (last && turn.start - last.end < MIN_SILENCE_SECONDS) last.end = Math.max(last.end, turn.end)
    else list.push({ ...turn })
    bySpeaker.set(turn.speaker, list)
  }
  return [...bySpeaker.values()]
    .flat()
    .filter(turn => turn.end - turn.start >= MIN_SPEECH_SECONDS)
    .sort((left, right) => left.start - right.start)
}
