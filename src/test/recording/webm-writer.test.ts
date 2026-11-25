import { beforeEach, describe, expect, it } from 'vitest'

import { makeSeekable } from '@/lib/recording/seekable'
import { type WebmPart, WebmWriter } from '@/lib/recording/webm-writer'
import { installBlobShim } from '@/test/imports/blob-shim'

// T174 (dono, 25/11: "Sim, implemente", research R18): a gravação otimizada codificada pelo WebCodecs monta o próprio WebM, VP9 e Opus,
// no lugar do MediaRecorder; o makeSeekable de sempre põe a duração e os Cues no fim

const OPUS_HEAD = new Uint8Array([0x4f, 0x70, 0x75, 0x73, 0x48, 0x65, 0x61, 0x64, 1, 2, 0x38, 0x01, 0x80, 0xbb, 0, 0, 0, 0, 0])

interface Node {
  id: string
  data: number
  end: number
}

const CLUSTER = '1f43b675'
const INSIDE_CLUSTER = new Set(['e7', 'a3'])

function read(bytes: Uint8Array, at: number, limit: number): Node {
  const idLength = Math.clz32(bytes[at]) - 23
  const sizeLength = Math.clz32(bytes[at + idLength]) - 23
  let size = bytes[at + idLength] & (0xff >> sizeLength)
  let unknown = size === 0xff >> sizeLength
  for (let index = 1; index < sizeLength; index++) {
    size = size * 256 + bytes[at + idLength + index]
    unknown &&= bytes[at + idLength + index] === 0xff
  }
  const data = at + idLength + sizeLength
  return { id: [...bytes.subarray(at, at + idLength)].map(byte => byte.toString(16).padStart(2, '0')).join(''), data, end: unknown ? limit : data + size }
}

function children(bytes: Uint8Array, node: Node): Node[] {
  const found: Node[] = []
  for (let at = node.data; at < node.end;) {
    const child = read(bytes, at, node.end)
    if (node.id === CLUSTER && !INSIDE_CLUSTER.has(child.id)) break
    found.push(child)
    at = child.end
  }
  return found
}

const number = (bytes: Uint8Array, node: Node) => [...bytes.subarray(node.data, node.end)].reduce((value, byte) => value * 256 + byte, 0)
const text = (bytes: Uint8Array, node: Node) => new TextDecoder().decode(bytes.subarray(node.data, node.end))

interface Block {
  track: number
  ms: number
  key: boolean
  size: number
}

/** The file as a list: the tracks and, for each Cluster, its time and blocks. */
function parse(bytes: Uint8Array) {
  const header = read(bytes, 0, bytes.length)
  const segment = read(bytes, header.end, bytes.length)
  const top: Node[] = []
  for (let at = segment.data; at < bytes.length;) {
    const child = read(bytes, at, bytes.length)
    if (child.id === CLUSTER) {
      const inside = children(bytes, child)
      child.end = inside.at(-1)!.end
    }
    top.push(child)
    at = child.end
  }
  const tracks = children(bytes, top.find(node => node.id === '1654ae6b')!).map(entry => {
    const fields = children(bytes, entry)
    const field = (id: string) => fields.find(item => item.id === id)
    const video = field('e0') && children(bytes, field('e0')!)
    const audio = field('e1') && children(bytes, field('e1')!)
    return {
      number: number(bytes, field('d7')!),
      type: number(bytes, field('83')!),
      codec: text(bytes, field('86')!),
      width: video ? number(bytes, video.find(item => item.id === 'b0')!) : undefined,
      height: video ? number(bytes, video.find(item => item.id === 'ba')!) : undefined,
      head: field('63a2') ? bytes.slice(field('63a2')!.data, field('63a2')!.end) : undefined,
      channels: audio ? number(bytes, audio.find(item => item.id === '9f')!) : undefined,
    }
  })
  const clusters = top
    .filter(node => node.id === CLUSTER)
    .map(cluster => {
      const inside = children(bytes, cluster)
      const time = number(bytes, inside.find(item => item.id === 'e7')!)
      const blocks: Block[] = inside
        .filter(item => item.id === 'a3')
        .map(block => ({ track: bytes[block.data] & 0x7f, ms: time + ((((bytes[block.data + 1] << 8) | bytes[block.data + 2]) << 16) >> 16), key: (bytes[block.data + 3] & 0x80) !== 0, size: block.end - block.data - 4 }))
      return { time, blocks }
    })
  return { docType: text(bytes, children(bytes, header).find(item => item.id === '4282')!), tracks, clusters, blocks: clusters.flatMap(cluster => cluster.blocks) }
}

function write(build: (writer: WebmWriter) => void): Uint8Array {
  const parts: Uint8Array[] = []
  const writer = new WebmWriter(bytes => parts.push(bytes))
  build(writer)
  const out = new Uint8Array(parts.reduce((size, part) => size + part.length, 0))
  let at = 0
  for (const part of parts) {
    out.set(part, at)
    at += part.length
  }
  return out
}

const video = (ms: number, key = false, size = 10): WebmPart => ({ track: 'video', timestamp: ms * 1000, key, data: new Uint8Array(size).fill(7) })
const audio = (ms: number): WebmPart => ({ track: 'audio', timestamp: ms * 1000, key: true, data: new Uint8Array(3).fill(9) })

beforeEach(() => {
  installBlobShim()
})

describe('o WebM da gravação otimizada pelo WebCodecs', () => {
  it('começa com o cabeçalho WebM e as duas trilhas: VP9 com o tamanho do primeiro quadro, Opus com o OpusHead do codificador', () => {
    const file = parse(
      write(writer => {
        writer.video(1920, 1080)
        writer.audio(48000, 2, OPUS_HEAD)
        writer.add(video(0, true))
        writer.add(audio(0))
        writer.finish()
      }),
    )
    expect(file.docType).toBe('webm')
    expect(file.tracks).toEqual([
      { number: 1, type: 1, codec: 'V_VP9', width: 1920, height: 1080, head: undefined, channels: undefined },
      { number: 2, type: 2, codec: 'A_OPUS', width: undefined, height: undefined, head: OPUS_HEAD, channels: 2 },
    ])
  })

  it('cada quadro-chave do vídeo abre um Cluster, e os blocos saem na ordem do tempo, som e imagem misturados', () => {
    const file = parse(
      write(writer => {
        writer.video(1280, 720)
        writer.audio(48000, 2, OPUS_HEAD)
        writer.add(video(0, true))
        for (let ms = 0; ms < 2000; ms += 20) writer.add(audio(ms))
        writer.add(video(500))
        writer.add(video(1000, true))
        writer.add(video(1500))
        writer.add(video(2000))
        writer.finish()
      }),
    )
    expect(file.clusters.map(cluster => cluster.time)).toEqual([0, 1000])
    expect(file.clusters.map(cluster => cluster.blocks[0])).toEqual([
      { track: 1, ms: 0, key: true, size: 10 },
      { track: 1, ms: 1000, key: true, size: 10 },
    ])
    const times = file.blocks.map(block => block.ms)
    expect(times).toEqual([...times].sort((a, b) => a - b))
    expect(file.blocks.filter(block => block.track === 2)).toHaveLength(100)
    expect(file.blocks.filter(block => block.track === 1).map(block => block.ms)).toEqual([0, 500, 1000, 1500, 2000])
  })

  it('o som espera a imagem para sair na ordem; no fim sai tudo', () => {
    const parts: Uint8Array[] = []
    const writer = new WebmWriter(bytes => parts.push(bytes))
    writer.video(1280, 720)
    writer.audio(48000, 2, OPUS_HEAD)
    writer.add(video(0, true))
    writer.add(audio(0))
    writer.add(audio(20))
    writer.add(audio(40))
    const before = parts.length
    // the audio after the last frame waits: a frame at 30 ms may still come
    writer.add(video(30))
    expect(parts.length).toBeGreaterThan(before)
    writer.finish()
    const total = parts.reduce((size, part) => size + part.length, 0)
    const all = new Uint8Array(total)
    let at = 0
    for (const part of parts) {
      all.set(part, at)
      at += part.length
    }
    expect(parse(all).blocks.map(block => [block.track, block.ms])).toEqual([
      [1, 0],
      [2, 0],
      [2, 20],
      [1, 30],
      [2, 40],
    ])
  })

  it('o tamanho de cada bloco ocupa o mínimo de bytes: um bloco de som de 80 bytes gasta 1 byte de tamanho, não 8', () => {
    const bytes = write(writer => {
      writer.video(1280, 720)
      writer.audio(48000, 2, OPUS_HEAD)
      writer.add(video(0, true, 2000))
      writer.add({ ...audio(0), data: new Uint8Array(80) })
      writer.add({ ...audio(20), data: new Uint8Array(80) })
      writer.finish()
    })
    const blocks = [...bytes.keys()].filter(at => bytes[at] === 0xa3 && bytes[at + 2] === 0x82)
    // a SimpleBlock of sound: id, one byte of size (0x80 | 84), then track 2
    expect(blocks.map(at => bytes[at + 1])).toEqual([0x80 | 84, 0x80 | 84])
    expect(parse(bytes).blocks.map(block => block.size)).toEqual([2000, 80, 80])
  })

  it('o tempo de cada trilha sempre cresce: dois quadros no mesmo milissegundo ficam a 1 ms um do outro', () => {
    const file = parse(
      write(writer => {
        writer.video(1280, 720)
        writer.audio(48000, 2, OPUS_HEAD)
        writer.add({ ...video(0, true), timestamp: 55_600 })
        writer.add({ ...video(0), timestamp: 56_300 })
        writer.add(audio(60))
        writer.finish()
      }),
    )
    expect(file.blocks.filter(block => block.track === 1).map(block => block.ms)).toEqual([56, 57])
  })

  it('sem quadro-chave por mais de 32 s, abre outro Cluster (o tempo dentro do Cluster cabe em 16 bits)', () => {
    const file = parse(
      write(writer => {
        writer.video(1280, 720)
        writer.audio(48000, 2, OPUS_HEAD)
        writer.add(video(0, true))
        writer.add(video(20_000))
        writer.add(video(40_000))
        writer.add(audio(40_000))
        writer.finish()
      }),
    )
    expect(file.clusters.map(cluster => cluster.time)).toEqual([0, 40_000])
  })

  it('o makeSeekable aceita o arquivo e põe os Cues, e todo Cluster começa com um quadro-chave (pular cai onde a imagem decodifica)', async () => {
    const bytes = write(writer => {
      writer.video(1920, 1080)
      writer.audio(48000, 2, OPUS_HEAD)
      for (let ms = 0; ms <= 90_000; ms += 1000) writer.add(video(ms, ms % 30_000 === 0))
      for (let ms = 0; ms <= 90_000; ms += 20) writer.add(audio(ms))
      writer.finish()
    })
    const source = new Blob([bytes], { type: 'video/webm' })
    const seekable = await makeSeekable(source)
    expect(seekable).not.toBe(source)
    const fixed = new Uint8Array(await seekable.arrayBuffer())
    const segment = read(fixed, read(fixed, 0, fixed.length).end, fixed.length)
    const top: string[] = []
    let info: Node | undefined
    for (let at = segment.data; at < segment.end;) {
      const child = read(fixed, at, segment.end)
      top.push(child.id)
      if (child.id === '1549a966') info = child
      at = child.end
    }
    expect(top.filter(id => id === '1c53bb6b')).toHaveLength(1)
    expect(top.filter(id => id === CLUSTER)).toHaveLength(4)
    expect(children(fixed, info!).map(item => item.id)).toContain('4489')
    expect(parse(bytes).clusters.map(cluster => [cluster.time, cluster.blocks[0].track, cluster.blocks[0].key])).toEqual([
      [0, 1, true],
      [30_000, 1, true],
      [60_000, 1, true],
      [90_000, 1, true],
    ])
  })
})
