/**
 * The WebM of the optimized recording encoded with WebCodecs (spec 007, research R18, T174): VP9 and Opus, the blocks of both tracks in
 * time order, a Cluster at each video key frame (jumping to a Cue lands where the picture decodes) and before the time inside a Cluster
 * passes its 16 bits. The sizes of the Segment and of the Clusters stay unknown, as the browser's recorder leaves them: makeSeekable
 * sets them, with the Duration and the Cues, when the recording ends.
 */

export interface WebmPart {
  track: 'video' | 'audio'
  /** Microseconds from the start of the recording. */
  timestamp: number
  key: boolean
  data: Uint8Array
}

type Track = WebmPart['track']

const TRACK_NUMBER: Record<Track, number> = { video: 1, audio: 2 }
const MAX_CLUSTER_MS = 32_000
const UNKNOWN_SIZE = [0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]
/** Opus asks the player to start decoding this long before a jump (the Matroska spec's 80 ms). */
const OPUS_SEEK_PRE_ROLL_NS = 80_000_000

function bigEndian(value: number, length: number): number[] {
  const out = new Array<number>(length)
  for (let index = length - 1; index >= 0; index--) {
    out[index] = value % 256
    value = Math.floor(value / 256)
  }
  return out
}

function idBytes(id: number): number[] {
  return bigEndian(id, id > 0xffffff ? 4 : id > 0xffff ? 3 : id > 0xff ? 2 : 1)
}

/** An EBML size in the fewest bytes: a block of sound (about 80 bytes) costs 1, not 8 (3000 blocks a minute). */
function sizeBytes(value: number): number[] {
  let length = 1
  while (value >= 2 ** (7 * length) - 1) length++
  const out = bigEndian(value, length)
  out[0] |= 0x80 >> (length - 1)
  return out
}

function element(id: number, payload: ArrayLike<number>): Uint8Array {
  const head = [...idBytes(id), ...sizeBytes(payload.length)]
  const out = new Uint8Array(head.length + payload.length)
  out.set(head)
  out.set(payload, head.length)
  return out
}

function joined(parts: ArrayLike<number>[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((size, part) => size + part.length, 0))
  let at = 0
  for (const part of parts) {
    out.set(part, at)
    at += part.length
  }
  return out
}

function uint(id: number, value: number): Uint8Array {
  let length = 1
  while (value >= 256 ** length) length++
  return element(id, bigEndian(value, length))
}

function text(id: number, value: string): Uint8Array {
  return element(id, new TextEncoder().encode(value))
}

function float(id: number, value: number): Uint8Array {
  const view = new DataView(new ArrayBuffer(8))
  view.setFloat64(0, value)
  return element(id, new Uint8Array(view.buffer))
}

/** The OpusHead of RFC 7845, for an encoder that does not hand its own. */
function opusHead(channels: number, sampleRate: number): Uint8Array {
  const head = new Uint8Array(19)
  head.set(new TextEncoder().encode('OpusHead'))
  const view = new DataView(head.buffer)
  view.setUint8(8, 1)
  view.setUint8(9, channels)
  view.setUint16(10, 312, true)
  view.setUint32(12, sampleRate, true)
  return head
}

export class WebmWriter {
  private videoSize: { width: number; height: number } | null = null
  private audioFormat: { sampleRate: number; channels: number; head: Uint8Array } | null = null
  private started = false
  private finished = false
  private clusterMs: number | null = null
  private readonly lastMs: Record<Track, number> = { video: -Infinity, audio: -Infinity }
  private readonly waiting: Record<Track, WebmPart[]> = { video: [], audio: [] }

  constructor(private readonly write: (bytes: Uint8Array) => void) {}

  /** The size of the first frame (the track's; a later key frame may carry another, as with the browser's recorder). */
  video(width: number, height: number): void {
    this.videoSize ??= { width, height }
    this.flush()
  }

  /** head: the OpusHead the encoder hands with its first chunk. */
  audio(sampleRate: number, channels: number, head?: Uint8Array): void {
    this.audioFormat ??= { sampleRate, channels, head: head ?? opusHead(channels, sampleRate) }
    this.flush()
  }

  add(part: WebmPart): void {
    this.waiting[part.track].push(part)
    this.flush()
  }

  /** Writes what still waits: no more parts come. */
  finish(): void {
    this.finished = true
    this.flush()
  }

  private flush(): void {
    if (!this.started) {
      if (!(this.videoSize && this.audioFormat) && !(this.finished && (this.videoSize || this.audioFormat))) return
      this.write(this.header())
      this.started = true
    }
    for (;;) {
      const video = this.waiting.video[0]
      const audio = this.waiting.audio[0]
      // a part goes out once the other track has one as late or later: nothing earlier can come after it
      const next = video && audio ? (video.timestamp <= audio.timestamp ? video : audio) : this.finished ? (video ?? audio) : undefined
      if (!next) return
      this.waiting[next.track].shift()
      this.block(next)
    }
  }

  private header(): Uint8Array {
    const video = this.videoSize
    const audio = this.audioFormat
    const entries: Uint8Array[] = []
    if (video) entries.push(element(0xae, joined([uint(0xd7, TRACK_NUMBER.video), uint(0x73c5, TRACK_NUMBER.video), uint(0x83, 1), text(0x86, 'V_VP9'), element(0xe0, joined([uint(0xb0, video.width), uint(0xba, video.height)]))])))
    if (audio) {
      const preSkip = audio.head.length >= 12 ? audio.head[10] | (audio.head[11] << 8) : 0
      entries.push(
        element(
          0xae,
          joined([
            uint(0xd7, TRACK_NUMBER.audio),
            uint(0x73c5, TRACK_NUMBER.audio),
            uint(0x83, 2),
            text(0x86, 'A_OPUS'),
            element(0x63a2, audio.head),
            uint(0x56aa, Math.round((preSkip / 48_000) * 1e9)),
            uint(0x56bb, OPUS_SEEK_PRE_ROLL_NS),
            element(0xe1, joined([float(0xb5, audio.sampleRate), uint(0x9f, audio.channels)])),
          ]),
        ),
      )
    }
    return joined([
      element(0x1a45dfa3, joined([uint(0x4286, 1), uint(0x42f7, 1), uint(0x42f2, 4), uint(0x42f3, 8), text(0x4282, 'webm'), uint(0x4287, 4), uint(0x4285, 2)])),
      [...idBytes(0x18538067), ...UNKNOWN_SIZE],
      element(0x1549a966, joined([uint(0x2ad7b1, 1_000_000), text(0x4d80, 'Study Helper'), text(0x5741, 'Study Helper')])),
      element(0x1654ae6b, joined(entries)),
    ])
  }

  private block(part: WebmPart): void {
    const ms = Math.max(Math.round(part.timestamp / 1000), this.lastMs[part.track] + 1)
    this.lastMs[part.track] = ms
    if (this.clusterMs === null || (part.track === 'video' && part.key) || ms - this.clusterMs > MAX_CLUSTER_MS) {
      this.clusterMs = ms
      this.write(joined([[...idBytes(0x1f43b675), ...UNKNOWN_SIZE], uint(0xe7, ms)]))
    }
    const relative = ms - this.clusterMs
    this.write(element(0xa3, joined([[0x80 | TRACK_NUMBER[part.track], (relative >> 8) & 0xff, relative & 0xff, part.key ? 0x80 : 0], part.data])))
  }
}
