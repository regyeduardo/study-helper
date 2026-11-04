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
const CODEC_PRIVATE = 0x63a2
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

interface OpusFile {
  bytes: Uint8Array
  ebml: Element
  info: Element
  tracks: Element
  sound: { number: number; entry: Element }
  stretches: Stretch[]
}

function readOpus(bytes: Uint8Array): OpusFile | null {
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
  return { bytes, ebml, info, tracks, sound, stretches }
}

export async function lightParts(source: Blob, seconds: number): Promise<LightParts | null> {
  try {
    const opus = readOpus(new Uint8Array(await source.arrayBuffer()))
    if (!opus) return null
    const { bytes, ebml, info, sound, stretches } = opus
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

/** Samples (48 kHz) in one Opus packet, from its TOC byte (RFC 6716, 3.1). */
function opusSamples(packet: Uint8Array): number {
  const config = packet[0] >> 3
  const frame = config < 12 ? [480, 960, 1920, 2880][config & 3] : config < 16 ? [480, 960][config & 1] : [120, 240, 480, 960][config & 3]
  const code = packet[0] & 3
  return frame * (code === 0 ? 1 : code === 3 ? packet[1] & 0x3f : 2)
}

/** The Opus frame of a SimpleBlock or BlockGroup; null when laced (MediaRecorder does not lace). */
function frameOf(bytes: Uint8Array, element: Element): Uint8Array | null {
  const block = element.id === BLOCK_GROUP ? childrenOf(bytes, element).find(inner => inner.id === BLOCK) : element
  if (!block) return null
  const at = block.data + Math.clz32(bytes[block.data]) - 23
  return bytes[at + 2] & 0x06 ? null : bytes.subarray(at + 3, block.end)
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let index = 0; index < 256; index++) {
    let value = index << 24
    for (let bit = 0; bit < 8; bit++) value = value & 0x80000000 ? (value << 1) ^ 0x04c11db7 : value << 1
    table[index] = value >>> 0
  }
  return table
})()

const SERIAL = 0x45535444

function oggPage(packets: Uint8Array[], granule: number, sequence: number, flags: number): Uint8Array {
  const lacing: number[] = []
  for (const packet of packets) {
    for (let left = packet.length; ; left -= 255) {
      lacing.push(Math.min(left, 255))
      if (left < 255) break
    }
  }
  const page = new Uint8Array(27 + lacing.length + packets.reduce((sum, packet) => sum + packet.length, 0))
  const view = new DataView(page.buffer)
  page.set([0x4f, 0x67, 0x67, 0x53, 0, flags])
  view.setUint32(6, granule % 2 ** 32, true)
  view.setUint32(10, Math.floor(granule / 2 ** 32), true)
  view.setUint32(14, SERIAL, true)
  view.setUint32(18, sequence, true)
  page[26] = lacing.length
  page.set(lacing, 27)
  let at = 27 + lacing.length
  for (const packet of packets) {
    page.set(packet, at)
    at += packet.length
  }
  let crc = 0
  for (const byte of page) crc = ((crc << 8) ^ CRC_TABLE[((crc >>> 24) ^ byte) & 0xff]) >>> 0
  view.setUint32(22, crc, true)
  return page
}

const lacingOf = (packet: Uint8Array) => Math.floor(packet.length / 255) + 1

/** The whole Opus track of a WebM in an Ogg file, without re-encoding (the video never goes); null when it is not WebM Opus. */
export async function opusOgg(source: Blob): Promise<Blob | null> {
  try {
    const opus = readOpus(new Uint8Array(await source.arrayBuffer()))
    if (!opus) return null
    const { bytes, sound, stretches } = opus
    const head = childrenOf(bytes, sound.entry).find(field => field.id === CODEC_PRIVATE)
    if (!head) return null
    const packets: Uint8Array[] = []
    for (const block of stretches.flatMap(stretch => stretch.blocks)) {
      const element = readElement(block, 0, block.length)
      const frame = element && frameOf(block, element)
      if (!frame?.length) return null
      packets.push(frame)
    }
    const tags = new Uint8Array([...new TextEncoder().encode('OpusTags'), 6, 0, 0, 0, ...new TextEncoder().encode('Estudo'), 0, 0, 0, 0])
    const pages = [oggPage([bytes.slice(head.data, head.end)], 0, 0, 0x02), oggPage([tags], 0, 1, 0)]
    let granule = 0
    for (let start = 0; start < packets.length; ) {
      const page: Uint8Array[] = []
      let segments = 0
      while (start < packets.length && segments + lacingOf(packets[start]) <= 255) {
        segments += lacingOf(packets[start])
        granule += opusSamples(packets[start])
        page.push(packets[start++])
      }
      pages.push(oggPage(page, granule, pages.length, start === packets.length ? 0x04 : 0))
    }
    return new Blob(pages as BlobPart[], { type: 'audio/ogg' })
  } catch {
    return null
  }
}
