const EBML = 0x1a45dfa3
const SEGMENT = 0x18538067
const INFO = 0x1549a966
const TIMECODE_SCALE = 0x2ad7b1
const DURATION = 0x4489
const TRACKS = 0x1654ae6b
const TRACK_ENTRY = 0xae
const TRACK_NUMBER = 0xd7
const TRACK_TYPE = 0x83
const CODEC_ID = 0x86
const CLUSTER = 0x1f43b675
const TIMECODE = 0xe7
const SIMPLE_BLOCK = 0xa3
const BLOCK_GROUP = 0xa0
const BLOCK = 0xa1
const INSIDE_CLUSTER = new Set([TIMECODE, SIMPLE_BLOCK, BLOCK_GROUP, 0xa7, 0xab, 0xbf, 0xec])
const AUDIO = 2
const OPUS = 'A_OPUS'
const DEFAULT_SCALE = 1_000_000

interface Element {
  id: number
  start: number
  data: number
  end: number
}

interface Stretch {
  time: number
  blocks: Uint8Array[]
}

export interface LightParts {
  parts: Blob[]
  starts: number[]
}

function readElement(bytes: Uint8Array, at: number, limit: number): Element | null {
  if (at >= limit) return null
  const idLength = Math.clz32(bytes[at]) - 23
  const sizeAt = at + idLength
  if (idLength > 4 || sizeAt >= limit) return null
  const sizeLength = Math.clz32(bytes[sizeAt]) - 23
  const data = sizeAt + sizeLength
  if (sizeLength > 8 || data > limit) return null
  let id = 0
  for (let index = 0; index < idLength; index++) id = id * 256 + bytes[at + index]
  const mask = 0xff >> sizeLength
  let size = bytes[sizeAt] & mask
  let unknown = size === mask
  for (let index = 1; index < sizeLength; index++) {
    size = size * 256 + bytes[sizeAt + index]
    unknown &&= bytes[sizeAt + index] === 0xff
  }
  return { id, start: at, data, end: unknown ? limit : Math.min(data + size, limit) }
}

function childrenOf(bytes: Uint8Array, parent: Element): Element[] {
  const found: Element[] = []
  for (let child = readElement(bytes, parent.data, parent.end); child; child = readElement(bytes, child.end, parent.end)) found.push(child)
  return found
}

function numberIn(bytes: Uint8Array, element: Element): number {
  let value = 0
  for (let at = element.data; at < element.end; at++) value = value * 256 + bytes[at]
  return value
}

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

function header(id: number, size: number): Uint8Array {
  return new Uint8Array([...idBytes(id), 0x01, ...bigEndian(size, 7)])
}

function blockTrack(bytes: Uint8Array, block: Element): number {
  return bytes[block.data] & 0x7f
}

function audioTrack(bytes: Uint8Array, tracks: Element): { number: number; entry: Element } | null {
  for (const entry of childrenOf(bytes, tracks).filter(item => item.id === TRACK_ENTRY)) {
    const fields = childrenOf(bytes, entry)
    const field = (id: number) => fields.find(item => item.id === id)
    const codec = field(CODEC_ID)
    const type = field(TRACK_TYPE)
    if (type && numberIn(bytes, type) === AUDIO && codec && new TextDecoder().decode(bytes.subarray(codec.data, codec.end)) === OPUS) {
      const number = field(TRACK_NUMBER)
      return { number: number ? numberIn(bytes, number) : 1, entry }
    }
  }
  return null
}

function stretchBytes(stretch: Stretch, from: number): Uint8Array[] {
  const time = new Uint8Array([TIMECODE, 0x88, ...bigEndian(stretch.time - from, 8)])
  const size = time.length + stretch.blocks.reduce((sum, block) => sum + block.length, 0)
  return [header(CLUSTER, size), time, ...stretch.blocks]
}

export async function lightParts(source: Blob, seconds: number): Promise<LightParts | null> {
  try {
    const bytes = new Uint8Array(await source.arrayBuffer())
    const ebml = readElement(bytes, 0, bytes.length)
    const segment = ebml?.id === EBML ? readElement(bytes, ebml.end, bytes.length) : null
    if (!ebml || segment?.id !== SEGMENT) return null
    let info: Element | undefined
    let tracks: Element | undefined
    const stretches: Stretch[] = []
    let sound: { number: number; entry: Element } | null = null
    for (let element = readElement(bytes, segment.data, segment.end); element;) {
      if (element.id === INFO) info = element
      if (element.id === TRACKS) {
        tracks = element
        sound = audioTrack(bytes, element)
      }
      if (element.id !== CLUSTER) {
        element = readElement(bytes, element.end, segment.end)
        continue
      }
      if (!sound) return null
      const stretch: Stretch = { time: 0, blocks: [] }
      let at = element.data
      for (let child = readElement(bytes, at, element.end); child && INSIDE_CLUSTER.has(child.id); child = readElement(bytes, at, element.end)) {
        if (child.id === TIMECODE) stretch.time = numberIn(bytes, child)
        else if (child.id === SIMPLE_BLOCK && blockTrack(bytes, child) === sound.number) stretch.blocks.push(bytes.subarray(child.start, child.end))
        else if (child.id === BLOCK_GROUP && childrenOf(bytes, child).some(inner => inner.id === BLOCK && blockTrack(bytes, inner) === sound!.number)) stretch.blocks.push(bytes.subarray(child.start, child.end))
        at = child.end
      }
      if (stretch.blocks.length) stretches.push(stretch)
      element = readElement(bytes, at, segment.end)
    }
    if (!info || !tracks || !sound || !stretches.length) return null

    const infoFields = childrenOf(bytes, info)
    const scaleField = infoFields.find(field => field.id === TIMECODE_SCALE)
    const toSeconds = (scaleField ? numberIn(bytes, scaleField) : DEFAULT_SCALE) / 1e9
    const infoBody = infoFields.filter(field => field.id !== DURATION).map(field => bytes.subarray(field.start, field.end))
    const infoSize = infoBody.reduce((sum, field) => sum + field.length, 0)
    const entry = bytes.subarray(sound.entry.start, sound.entry.end)
    const head = [bytes.subarray(0, ebml.end)]
    const top = [header(INFO, infoSize), ...infoBody, header(TRACKS, entry.length), entry]

    const groups: Stretch[][] = []
    for (const stretch of stretches) {
      const group = groups[groups.length - 1]
      if (group && (stretch.time - group[0].time) * toSeconds < seconds) group.push(stretch)
      else groups.push([stretch])
    }
    const parts = groups.map(group => {
      const body = [...top, ...group.flatMap(stretch => stretchBytes(stretch, group[0].time))]
      const size = body.reduce((sum, piece) => sum + piece.length, 0)
      return new Blob([...head, header(SEGMENT, size), ...body] as BlobPart[], { type: 'audio/webm' })
    })
    return { parts, starts: groups.map(group => group[0].time * toSeconds) }
  } catch {
    return null
  }
}
