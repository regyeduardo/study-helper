import { beforeEach, describe, expect, it, vi } from 'vitest'

import { readLocalMedia } from '@/lib/recording/media-library'
import { shareMediaOf } from '@/lib/share'
import { installBlobShim } from '@/test/imports/blob-shim'
import type { FileMeta, ShareContent } from '@/types/domain'

vi.mock('@/lib/recording/media-library', async original => ({ ...(await original<typeof import('@/lib/recording/media-library')>()), readLocalMedia: vi.fn() }))

const UNKNOWN_SIZE = [0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]
const CUES = [0x1c, 0x53, 0xbb, 0x6b]

function element(id: number[], payload: number[]): number[] {
  return [...id, 0x80 | payload.length, ...payload]
}

// a browser recording: no duration, no index of where each stretch starts
function browserRecording(): number[] {
  const cluster = (time: number) => [0x1f, 0x43, 0xb6, 0x75, ...UNKNOWN_SIZE, ...element([0xe7], [time >> 8, time & 0xff]), ...element([0xa3], [0x81, 0, 0, 0x80, 0xaa])]
  return [
    ...element([0x1a, 0x45, 0xdf, 0xa3], element([0x42, 0x82], [0x77, 0x65, 0x62, 0x6d])),
    ...[0x18, 0x53, 0x80, 0x67, ...UNKNOWN_SIZE],
    ...element([0x15, 0x49, 0xa9, 0x66], element([0x2a, 0xd7, 0xb1], [0x0f, 0x42, 0x40])),
    ...element([0x16, 0x54, 0xae, 0x6b], element([0xae], [...element([0xd7], [1]), ...element([0x83], [1])])),
    ...cluster(0),
    ...cluster(5000),
  ]
}

function hasCues(bytes: Uint8Array): boolean {
  return bytes.some((_, at) => CUES.every((byte, index) => bytes[at + index] === byte))
}

const meta = { id: 'f1', origin: { input: 'recording', name: 'Reunião.webm', mime: 'video/webm', storage: 'none' } } as unknown as FileMeta
const content = { files: [{ id: 'f1' }] } as unknown as ShareContent
const kept = { storedName: 'envio-1', name: 'Reunião.webm', mime: 'video/webm', durationSeconds: 10, size: 0, createdAt: '', fileIds: ['f1'] }

beforeEach(() => {
  installBlobShim()
})

describe('media sent with a share', () => {
  it('a browser recording goes up with its duration and index, so the link jumps straight to a minute', async () => {
    vi.mocked(readLocalMedia).mockResolvedValue(new File([new Uint8Array(browserRecording())], 'Reunião.webm', { type: 'video/webm' }))
    const [media] = shareMediaOf(content, [meta], [kept], null)
    const sent = await media.read()
    expect(sent.type).toBe('video/webm')
    expect(hasCues(new Uint8Array(await sent.arrayBuffer()))).toBe(true)
  })

  it('a media that is not WebM goes up as it is', async () => {
    const mp4 = new File([new Uint8Array([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70])], 'aula.mp4', { type: 'video/mp4' })
    vi.mocked(readLocalMedia).mockResolvedValue(mp4)
    const [media] = shareMediaOf(content, [{ ...meta, origin: { ...meta.origin!, mime: 'video/mp4' } }], [{ ...kept, mime: 'video/mp4' }], null)
    expect(await media.read()).toBe(mp4)
  })
})
