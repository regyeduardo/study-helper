import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { MeetingRecorder, type RecordingResult } from '@/lib/recording/recorder'
import { makeSeekable } from '@/lib/recording/seekable'
import { installBlobShim } from '@/test/imports/blob-shim'
import { FakeMediaRecorder, installMediaEnvironment, type MediaEnvironment } from '@/test/recording/media-fakes'

const UNKNOWN_SIZE = [0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]
const EBML = [0x1a, 0x45, 0xdf, 0xa3]
const SEGMENT = [0x18, 0x53, 0x80, 0x67]
const SEEK_HEAD = [0x11, 0x4d, 0x9b, 0x74]
const INFO = [0x15, 0x49, 0xa9, 0x66]
const TRACKS = [0x16, 0x54, 0xae, 0x6b]
const CLUSTER = [0x1f, 0x43, 0xb6, 0x75]
const CUES = [0x1c, 0x53, 0xbb, 0x6b]

function element(id: number[], payload: number[]): number[] {
  return [...id, 0x80 | payload.length, ...payload]
}

/** `keys`: the offsets whose block is a keyframe (all of them by default, as in an audio track). */
function cluster(time: number, blockTimes: number[], keys?: number[]): number[] {
  const blocks = blockTimes.flatMap(offset => element([0xa3], [0x81, offset >> 8, offset & 0xff, !keys || keys.includes(offset) ? 0x80 : 0x00, 0xaa, 0xbb]))
  return [...CLUSTER, ...UNKNOWN_SIZE, ...element([0xe7], [time >> 8, time & 0xff]), ...blocks]
}

/** A screen recording of the browser (MediaRecorder): a keyframe at the start, then only frames that depend on the ones before; one more
 * keyframe in the third stretch, 2 s into it. */
function screenRecording(): number[] {
  const steps = Array.from({ length: 250 }, (_, index) => index * 20)
  return [
    ...element(EBML, element([0x42, 0x82], [...'webm'].map(letter => letter.charCodeAt(0)))),
    ...SEGMENT,
    ...UNKNOWN_SIZE,
    ...element(INFO, [...element([0x2a, 0xd7, 0xb1], [0x0f, 0x42, 0x40]), ...element([0x4d, 0x80], [0x43, 0x68])]),
    ...element(TRACKS, element([0xae], [...element([0xd7], [1]), ...element([0x83], [1])])),
    ...cluster(0, steps, [0]),
    ...cluster(5000, steps, []),
    ...cluster(10000, steps, [2000]),
  ]
}

function browserRecording(): number[] {
  const steps = Array.from({ length: 250 }, (_, index) => index * 20)
  return [
    ...element(
      EBML,
      element(
        [0x42, 0x82],
        [...'webm'].map(letter => letter.charCodeAt(0)),
      ),
    ),
    ...SEGMENT,
    ...UNKNOWN_SIZE,
    ...element(INFO, [...element([0x2a, 0xd7, 0xb1], [0x0f, 0x42, 0x40]), ...element([0x4d, 0x80], [0x43, 0x68])]),
    ...element(TRACKS, element([0xae], [...element([0xd7], [1]), ...element([0x83], [2])])),
    ...cluster(0, steps),
    ...cluster(5000, steps),
    ...cluster(10000, steps),
  ]
}

interface Found {
  id: string
  data: number
  end: number
}

function read(bytes: Uint8Array, at: number): Found {
  const idLength = Math.clz32(bytes[at]) - 23
  const sizeLength = Math.clz32(bytes[at + idLength]) - 23
  let size = bytes[at + idLength] & (0xff >> sizeLength)
  for (let index = 1; index < sizeLength; index++) size = size * 256 + bytes[at + idLength + index]
  const data = at + idLength + sizeLength
  return {
    id: [...bytes.subarray(at, at + idLength)].map(byte => byte.toString(16).padStart(2, '0')).join(''),
    data,
    end: data + size,
  }
}

function children(bytes: Uint8Array, from: number, to: number): Found[] {
  const found: Found[] = []
  for (let at = from; at < to;) {
    const child = read(bytes, at)
    found.push(child)
    at = child.end
  }
  return found
}

function number(bytes: Uint8Array, found: Found): number {
  return [...bytes.subarray(found.data, found.end)].reduce((value, byte) => value * 256 + byte, 0)
}

const hex = (id: number[]) => id.map(byte => byte.toString(16).padStart(2, '0')).join('')

function inspect(bytes: Uint8Array) {
  const header = read(bytes, 0)
  const segment = read(bytes, header.end)
  const top: Found[] = []
  for (let at = segment.data; ;) {
    const child = read(bytes, at)
    if (child.id === hex(CLUSTER)) break
    top.push(child)
    at = child.end
  }
  const part = (id: number[]) => top.find(item => item.id === hex(id))!
  const info = children(bytes, part(INFO).data, part(INFO).end)
  const duration = info.find(item => item.id === '4489')
  const cues = children(bytes, part(CUES).data, part(CUES).end).map(point => {
    const fields = children(bytes, point.data, point.end)
    const positions = children(bytes, fields[1].data, fields[1].end)
    return {
      time: number(bytes, fields[0]),
      position: number(
        bytes,
        positions.find(item => item.id === 'f1')!,
      ),
    }
  })
  const seeks = children(bytes, part(SEEK_HEAD).data, part(SEEK_HEAD).end).map(seek => {
    const fields = children(bytes, seek.data, seek.end)
    return {
      id: [...bytes.subarray(fields[0].data, fields[0].end)].map(byte => byte.toString(16).padStart(2, '0')).join(''),
      position: number(bytes, fields[1]),
    }
  })
  return {
    segment,
    cues,
    seeks,
    cuesAt: read(bytes, segment.data + seeks.find(seek => seek.id === hex(CUES))!.position).id,
    durationMs: duration ? new DataView(bytes.buffer, bytes.byteOffset + duration.data, 8).getFloat64(0) : null,
  }
}

function jumpTo(bytes: Uint8Array, seconds: number): number {
  const { segment, cues } = inspect(bytes)
  const cue = cues.filter(item => item.time <= seconds * 1000).at(-1)!
  const landed = read(bytes, segment.data + cue.position)
  expect(landed.id).toBe(hex(CLUSTER))
  return number(bytes, read(bytes, landed.data))
}

async function bytesOf(blob: Blob): Promise<Uint8Array> {
  return new Uint8Array(await blob.arrayBuffer())
}

let env: MediaEnvironment

beforeEach(() => {
  installBlobShim()
  env = installMediaEnvironment()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

// T180 (25/11): a Ata da Natália parou no servidor com PIPELINE_ERROR_DECODE. O índice apontava cada trecho como lugar de pulo, mas
// num vídeo do MediaRecorder só o começo tem quadro-chave: o pulo caía num quadro que depende dos anteriores e a decodificação quebrava.
/** The track of the test recording made a video track (same size: one byte changes). */
function asVideo(bytes: Uint8Array): Uint8Array {
  const out = bytes.slice()
  for (let at = 0; at < out.length - 2; at++) if (out[at] === 0x83 && out[at + 1] === 0x81 && out[at + 2] === 2) out[at + 2] = 1
  return out
}

/** Only the first block (and the one 2 s into the stretch at 10 s) stay keyframes, as in a screen recording of the browser. */
function dropKeys(bytes: Uint8Array): Uint8Array {
  const out = bytes.slice()
  const header = read(out, 0)
  const segment = read(out, header.end)
  for (let at = segment.data; at < segment.end; ) {
    const child = read(out, at)
    if (child.id === hex(CLUSTER)) {
      let time = 0
      for (const inner of children(out, child.data, child.end)) {
        if (inner.id === 'e7') time = number(out, inner)
        if (inner.id !== 'a3') continue
        const offset = (out[inner.data + 1] << 8) | out[inner.data + 2]
        const key = (time === 0 && offset === 0) || (time === 10000 && offset === 2000)
        out[inner.data + 3] = key ? 0x80 : 0x00
      }
    }
    at = child.end
  }
  return out
}

describe('makeSeekable num vídeo', () => {
  it('o índice só aponta onde o vídeo pode começar: os quadros-chave, no tempo deles', async () => {
    const bytes = await bytesOf(await makeSeekable(new Blob([new Uint8Array(screenRecording())], { type: 'video/webm' })))
    expect(inspect(bytes).cues.map(cue => cue.time)).toEqual([0, 12000])
    // a jump to 7.5 s starts from the keyframe at 0; to 13 s, from the one at 12 s
    expect(jumpTo(bytes, 7.5)).toBe(0)
    expect(jumpTo(bytes, 13)).toBe(10000)
  })

  it('refaz o índice errado de uma gravação de antes (a que já tem índice)', async () => {
    // the index of before: every stretch is a place to jump; then only the start (and 2 s into the third) really is a keyframe
    const indexed = await bytesOf(await makeSeekable(new Blob([new Uint8Array(browserRecording())], { type: 'video/webm' })))
    expect(inspect(indexed).cues.map(cue => cue.time)).toEqual([0, 5000, 10000])
    const old = dropKeys(asVideo(indexed))
    const again = await bytesOf(await makeSeekable(new Blob([old], { type: 'video/webm' }), { redo: true }))
    expect(inspect(again).cues.map(cue => cue.time)).toEqual([0, 12000])
    expect(inspect(again).durationMs).toBe(15000)
    // without "redo", a file that has an index is left as it is
    expect((await bytesOf(await makeSeekable(new Blob([old], { type: 'video/webm' })))).length).toBe(old.length)
  })
})

describe('makeSeekable', () => {
  it('gives the browser recording a finite duration and an index of where each stretch starts', async () => {
    const source = new Blob([new Uint8Array(browserRecording())], {
      type: 'audio/webm;codecs=opus',
    })
    const fixed = await makeSeekable(source)
    expect(fixed.type).toBe('audio/webm;codecs=opus')
    const bytes = await bytesOf(fixed)
    const seen = inspect(bytes)
    expect(seen.durationMs).toBe(15000)
    expect(seen.segment.end).toBe(bytes.length)
    expect(seen.cues.map(cue => cue.time)).toEqual([0, 5000, 10000])
    expect(seen.cuesAt).toBe(hex(CUES))
  })

  it('a jump to the middle lands on the stretch that holds that moment', async () => {
    const bytes = await bytesOf(await makeSeekable(new Blob([new Uint8Array(browserRecording())], { type: 'audio/webm' })))
    expect(jumpTo(bytes, 7.5)).toBe(5000)
    expect(jumpTo(bytes, 12)).toBe(10000)
    expect(jumpTo(bytes, 1)).toBe(0)
  })

  it('keeps every recorded stretch byte for byte, only the size of each stretch is written', async () => {
    const original = new Uint8Array(browserRecording())
    const bytes = await bytesOf(await makeSeekable(new Blob([original], { type: 'audio/webm' })))
    const firstCluster = original.findIndex((_, at) => CLUSTER.every((byte, offset) => original[at + offset] === byte))
    const withoutSizes = (stretch: Uint8Array) => {
      const copy = [...stretch]
      for (let at = 0; at < copy.length; at++) if (CLUSTER.every((byte, offset) => copy[at + offset] === byte)) copy.fill(0, at + 4, at + 12)
      return copy
    }
    expect(withoutSizes(bytes.subarray(bytes.length - (original.length - firstCluster)))).toEqual(withoutSizes(original.subarray(firstCluster)))
  })

  it('no stretch keeps an unknown size inside the segment of known size', async () => {
    const original = new Uint8Array(browserRecording())
    const bytes = await bytesOf(await makeSeekable(new Blob([original], { type: 'audio/webm' })))
    const { segment, cues } = inspect(bytes)
    const stretches = children(bytes, segment.data + cues[0].position, segment.end)
    expect(stretches.map(stretch => stretch.id)).toEqual([hex(CLUSTER), hex(CLUSTER), hex(CLUSTER)])
    expect(stretches.at(-1)!.end).toBe(bytes.length)
    expect(stretches.map(stretch => number(bytes, read(bytes, stretch.data)))).toEqual([0, 5000, 10000])
  })

  it('leaves alone a file that is not a WebM recording', async () => {
    const other = new Blob(['ftypisom'], { type: 'audio/mp4' })
    expect(await makeSeekable(other)).toBe(other)
  })
})

describe('MeetingRecorder', () => {
  it('finishes with a file that already accepts a jump', async () => {
    const onFinished = vi.fn()
    const recorder = new MeetingRecorder({
      onTick: vi.fn(),
      onFinished,
      onCancelled: vi.fn(),
      onError: vi.fn(),
    })
    await recorder.start('microphone')
    const recording = new Uint8Array(browserRecording())
    const fake = FakeMediaRecorder.instances.at(-1)!
    fake.ondataavailable?.({ data: new Blob([recording.subarray(0, 900)]) })
    fake.ondataavailable?.({ data: new Blob([recording.subarray(900)]) })
    recorder.finish()
    await vi.waitFor(() => expect(onFinished).toHaveBeenCalledTimes(1))
    const result = onFinished.mock.calls[0][0] as RecordingResult
    const bytes = await bytesOf(result.file)
    expect(inspect(bytes).durationMs).toBe(15000)
    expect(jumpTo(bytes, 7.5)).toBe(5000)
    expect([...env.directory.files.keys()]).toEqual([result.storedName])
    expect([...(await bytesOf(await env.directory.files.get(result.storedName)!.getFile()))]).toEqual([...bytes])
  })
})
