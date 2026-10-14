import { afterEach, describe, expect, it, vi } from 'vitest'

import { lightParts } from '@/lib/transcription/opus'
import { transcribeWithCustom } from '@/lib/transcription/providers/custom'
import { transcribeWithDeepInfra } from '@/lib/transcription/providers/deepinfra'
import type { ProviderJob } from '@/lib/transcription/types'
import { installBlobShim } from '@/test/imports/blob-shim'

const UNKNOWN_SIZE = [0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]
const EBML = [0x1a, 0x45, 0xdf, 0xa3]
const SEGMENT = [0x18, 0x53, 0x80, 0x67]
const INFO = [0x15, 0x49, 0xa9, 0x66]
const TRACKS = [0x16, 0x54, 0xae, 0x6b]
const CLUSTER = [0x1f, 0x43, 0xb6, 0x75]
const CUES = [0x1c, 0x53, 0xbb, 0x6b]
const AUDIO = 1
const VIDEO = 2

const text = (value: string) => [...value].map(letter => letter.charCodeAt(0))

function element(id: number[], payload: number[]): number[] {
  return [...id, 0x80 | payload.length, ...payload]
}

function big(id: number[], payload: number[]): number[] {
  return [...id, 0x01, 0, 0, 0, 0, payload.length >> 16, (payload.length >> 8) & 0xff, payload.length & 0xff, ...payload]
}

function block(track: number, offset: number): number[] {
  return element([0xa3], [0x80 | track, offset >> 8, offset & 0xff, 0x80, track === AUDIO ? 0xaa : 0xee, 0xbb])
}

function cluster(time: number): number[] {
  const blocks = [0, 1000, 2000, 3000, 4000].flatMap(offset => [...block(AUDIO, offset), ...block(VIDEO, offset)])
  return [...CLUSTER, ...UNKNOWN_SIZE, ...element([0xe7], [time >> 8, time & 0xff]), ...blocks]
}

function track(number: number, type: number, codec: string): number[] {
  return element([0xae], [...element([0xd7], [number]), ...element([0x83], [type]), ...element([0x86], text(codec))])
}

function browserVideo(): number[] {
  return [
    ...element(EBML, element([0x42, 0x82], text('webm'))),
    ...SEGMENT,
    ...UNKNOWN_SIZE,
    ...element(INFO, [...element([0x2a, 0xd7, 0xb1], [0x0f, 0x42, 0x40]), ...element([0x44, 0x89], [0x40, 0xc3, 0x88, 0, 0, 0, 0, 0])]),
    ...big(TRACKS, [...track(AUDIO, 2, 'A_OPUS'), ...track(VIDEO, 1, 'V_VP8')]),
    ...element(CUES, []),
    ...cluster(0),
    ...cluster(5000),
    ...cluster(10000),
  ]
}

interface Found {
  id: string
  data: number
  end: number
}

const hex = (id: number[]) => id.map(byte => byte.toString(16).padStart(2, '0')).join('')

function read(bytes: Uint8Array, at: number): Found {
  const idLength = Math.clz32(bytes[at]) - 23
  const sizeLength = Math.clz32(bytes[at + idLength]) - 23
  let size = bytes[at + idLength] & (0xff >> sizeLength)
  for (let index = 1; index < sizeLength; index++) size = size * 256 + bytes[at + idLength + index]
  const data = at + idLength + sizeLength
  return { id: hex([...bytes.subarray(at, at + idLength)]), data, end: data + size }
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

const number = (bytes: Uint8Array, found: Found) => [...bytes.subarray(found.data, found.end)].reduce((value, byte) => value * 256 + byte, 0)

async function inspect(part: Blob) {
  const bytes = new Uint8Array(await part.arrayBuffer())
  const header = read(bytes, 0)
  const segment = read(bytes, header.end)
  const top = children(bytes, segment.data, segment.end)
  const tracks = top.find(item => item.id === hex(TRACKS))!
  const info = top.find(item => item.id === hex(INFO))!
  return {
    header: hex([...bytes.subarray(0, 4)]),
    ends: segment.end === bytes.length,
    tracks: children(bytes, tracks.data, tracks.end).map(entry => number(bytes, children(bytes, entry.data, entry.end).find(field => field.id === 'd7')!)),
    duration: children(bytes, info.data, info.end).some(field => field.id === '4489'),
    clusters: top
      .filter(item => item.id === hex(CLUSTER))
      .map(item => {
        const inside = children(bytes, item.data, item.end)
        return { time: number(bytes, inside[0]), blocks: inside.slice(1).map(found => bytes[found.data] & 0x7f) }
      }),
  }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('light audio: the original WebM cut in parts, with the sound only', () => {
  it('cuts at the stretch that passes the part length, keeps only the sound track and restarts the time of each part', async () => {
    installBlobShim()
    const cut = await lightParts(new Blob([new Uint8Array(browserVideo())], { type: 'video/webm;codecs=vp8,opus' }), 6)
    expect(cut?.starts).toEqual([0, 10])
    expect(cut?.parts.map(part => part.type)).toEqual(['audio/webm', 'audio/webm'])
    const first = await inspect(cut!.parts[0])
    expect(first).toEqual({ header: hex(EBML), ends: true, tracks: [AUDIO], duration: false, clusters: [{ time: 0, blocks: [1, 1, 1, 1, 1] }, { time: 5000, blocks: [1, 1, 1, 1, 1] }] })
    const second = await inspect(cut!.parts[1])
    expect(second.clusters).toEqual([{ time: 0, blocks: [1, 1, 1, 1, 1] }])
    expect(cut!.parts.reduce((sum, part) => sum + part.size, 0)).toBeLessThan(browserVideo().length)
  })

  it('a file that is not a WebM with Opus is left for the WAV way', async () => {
    installBlobShim()
    expect(await lightParts(new Blob(['ID3 mp3 qualquer'], { type: 'audio/mpeg' }), 300)).toBeNull()
  })

  it('the providers name the part by its format and put each word at the real start of its part', async () => {
    const sent: string[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: { body: FormData }) => {
        if (!String(url).endsWith('/audio/transcriptions')) return new Response(JSON.stringify({ speaker_segments: [] }))
        sent.push((init.body.get('file') as File).name)
        return new Response(JSON.stringify({ words: [{ word: 'oi', start: 1, end: 2 }] }))
      }),
    )
    const job: ProviderJob = {
      audio: new Blob(['x']),
      parts: [new Blob(['a'], { type: 'audio/webm' }), new Blob(['b'], { type: 'audio/webm' })],
      partStarts: [0, 297.5],
      partSeconds: 300,
      language: 'pt',
      credential: { apiKey: 'chave', baseUrl: 'https://exemplo.test/v1', model: 'modelo', extra: '' },
      progress: vi.fn(),
    }
    expect((await transcribeWithDeepInfra(job)).words.map(word => word.start)).toEqual([1, 298.5])
    expect((await transcribeWithCustom(job)).words.map(word => word.start)).toEqual([1, 298.5])
    expect(new Set(sent)).toEqual(new Set(['trecho.webm']))
  })
})
