const EBML = 0x1a45dfa3
const SEGMENT = 0x18538067
const SEEK_HEAD = 0x114d9b74
const SEEK = 0x4dbb
const SEEK_ID = 0x53ab
const SEEK_POSITION = 0x53ac
const INFO = 0x1549a966
const TIMECODE_SCALE = 0x2ad7b1
const DURATION = 0x4489
const TRACKS = 0x1654ae6b
const TRACK_ENTRY = 0xae
const TRACK_NUMBER = 0xd7
const TRACK_TYPE = 0x83
const CLUSTER = 0x1f43b675
const TIMECODE = 0xe7
const SIMPLE_BLOCK = 0xa3
const BLOCK_GROUP = 0xa0
const BLOCK = 0xa1
const CUES = 0x1c53bb6b
const CUE_POINT = 0xbb
const CUE_TIME = 0xb3
const CUE_TRACK_POSITIONS = 0xb7
const CUE_TRACK = 0xf7
const CUE_CLUSTER_POSITION = 0xf1
const VOID = 0xec
const INSIDE_CLUSTER = new Set([TIMECODE, SIMPLE_BLOCK, BLOCK_GROUP, 0xa7, 0xab, 0xbf, VOID])
const VIDEO = 1

interface Element {
  id: number
  start: number
  data: number
  end: number
}

interface ClusterStart {
  offset: number
  time: number
}

interface SizePatch {
  at: number
  bytes: number[]
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
  return {
    id,
    start: at,
    data,
    end: unknown ? limit : Math.min(data + size, limit),
  }
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

function blockTime(bytes: Uint8Array, block: Element, clusterTime: number): number {
  const at = block.data + Math.clz32(bytes[block.data]) - 23
  return clusterTime + ((((bytes[at] << 8) | bytes[at + 1]) << 16) >> 16)
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

function build(id: number, payload: ArrayLike<number>): number[] {
  return [...idBytes(id), 0x01, ...bigEndian(payload.length, 7), ...Array.from(payload)]
}

function float64(value: number): number[] {
  const view = new DataView(new ArrayBuffer(8))
  view.setFloat64(0, value)
  return [...new Uint8Array(view.buffer)]
}

function cueTrack(bytes: Uint8Array, tracks: Element | undefined): number {
  if (!tracks) return 1
  const entries = childrenOf(bytes, tracks)
    .filter(entry => entry.id === TRACK_ENTRY)
    .map(entry => {
      const fields = childrenOf(bytes, entry)
      const field = (id: number) => fields.find(item => item.id === id)
      return {
        number: field(TRACK_NUMBER) ? numberIn(bytes, field(TRACK_NUMBER)!) : 1,
        type: field(TRACK_TYPE) ? numberIn(bytes, field(TRACK_TYPE)!) : 0,
      }
    })
  return (entries.find(entry => entry.type === VIDEO) ?? entries[0])?.number ?? 1
}

function rebuilt(source: Blob, bytes: Uint8Array): Blob {
  const header = readElement(bytes, 0, bytes.length)
  const segment = header?.id === EBML ? readElement(bytes, header.end, bytes.length) : null
  if (!header || segment?.id !== SEGMENT) return source

  const before: Element[] = []
  const clusters: ClusterStart[] = []
  const patches: SizePatch[] = []
  let last = 0
  let previous = 0
  let blocks = 0
  const seen = (time: number) => {
    previous = last
    last = time
    blocks++
  }
  for (let element = readElement(bytes, segment.data, segment.end); element;) {
    if (element.id === CUES) return source
    if (element.id !== CLUSTER) {
      if (!clusters.length) before.push(element)
      element = readElement(bytes, element.end, segment.end)
      continue
    }
    let time = 0
    let at = element.data
    for (let child = readElement(bytes, at, element.end); child && INSIDE_CLUSTER.has(child.id); child = readElement(bytes, at, element.end)) {
      if (child.id === TIMECODE) {
        time = numberIn(bytes, child)
        clusters.push({ offset: element.start, time })
      } else if (child.id === SIMPLE_BLOCK) seen(blockTime(bytes, child, time))
      else if (child.id === BLOCK_GROUP) for (const inner of childrenOf(bytes, child)) if (inner.id === BLOCK) seen(blockTime(bytes, inner, time))
      at = child.end
    }
    const sizeAt = element.start + Math.clz32(bytes[element.start]) - 23
    if (element.data - sizeAt === 8 && bytes.subarray(sizeAt, element.data).every((byte, index) => byte === (index ? 0xff : 0x01))) patches.push({ at: sizeAt, bytes: [0x01, ...bigEndian(at - element.data, 7)] })
    element = readElement(bytes, at, segment.end)
  }
  const oldInfo = before.find(element => element.id === INFO)
  if (!oldInfo || !clusters.length) return source

  const duration = last + (blocks > 1 ? last - previous : 0)
  const info = build(INFO, [
    ...childrenOf(bytes, oldInfo)
      .filter(child => child.id !== DURATION)
      .flatMap(child => [...bytes.subarray(child.start, child.end)]),
    ...idBytes(DURATION),
    0x88,
    ...float64(duration),
  ])
  const kept = before.filter(element => ![INFO, SEEK_HEAD, VOID].includes(element.id))
  const keptBytes = kept.flatMap(element => [...bytes.subarray(element.start, element.end)])
  const track = cueTrack(
    bytes,
    kept.find(element => element.id === TRACKS),
  )
  const first = clusters[0].offset
  const cuesAt = (clustersAt: number) =>
    build(
      CUES,
      clusters.flatMap(cluster => build(CUE_POINT, [...build(CUE_TIME, bigEndian(cluster.time, 8)), ...build(CUE_TRACK_POSITIONS, [...build(CUE_TRACK, bigEndian(track, 8)), ...build(CUE_CLUSTER_POSITION, bigEndian(clustersAt + cluster.offset - first, 8))])])),
    )
  const seekHead = (targets: [number, number][]) =>
    build(
      SEEK_HEAD,
      targets.flatMap(([id, position]) => build(SEEK, [...build(SEEK_ID, bigEndian(id, 4)), ...build(SEEK_POSITION, bigEndian(position, 8))])),
    )

  const tracksOffset = kept
    .slice(
      0,
      kept.findIndex(element => element.id === TRACKS),
    )
    .reduce((sum, element) => sum + element.end - element.start, 0)
  const infoAt = seekHead([
    [INFO, 0],
    [TRACKS, 0],
    [CUES, 0],
  ]).length
  const keptAt = infoAt + info.length
  const cuesStart = keptAt + keptBytes.length
  const clustersAt = cuesStart + cuesAt(0).length
  const head = [
    ...seekHead([
      [INFO, infoAt],
      [TRACKS, keptAt + tracksOffset],
      [CUES, cuesStart],
    ]),
    ...info,
    ...keptBytes,
    ...cuesAt(clustersAt),
  ]
  const segmentSize = clustersAt + bytes.length - first
  const body: BlobPart[] = []
  let copied = first
  for (const patch of patches) {
    body.push(source.slice(copied, patch.at), new Uint8Array(patch.bytes))
    copied = patch.at + patch.bytes.length
  }
  body.push(source.slice(copied))
  return new Blob([bytes.subarray(0, header.end), new Uint8Array([...idBytes(SEGMENT), 0x01, ...bigEndian(segmentSize, 7), ...head]), ...body], { type: source.type })
}

export async function makeSeekable(source: Blob): Promise<Blob> {
  try {
    return rebuilt(source, new Uint8Array(await source.arrayBuffer()))
  } catch {
    return source
  }
}
