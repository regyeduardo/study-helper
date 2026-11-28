import { afterEach, describe, expect, it, vi } from 'vitest'
import { transcribeWithCustom } from '@/lib/transcription/providers/custom'
import { transcribeWithDeepInfra } from '@/lib/transcription/providers/deepinfra'
import type { ProviderJob } from '@/lib/transcription/types'

const WHISPER_URL = 'https://api.deepinfra.com/v1/openai/audio/transcriptions'
const PARTS = 12

interface Waiting {
  part: number
  answer(response: Response): void
}

function slowProvider() {
  const waiting: Waiting[] = []
  const fetchMock = vi.fn(async (url: string, init: { body: FormData; signal?: AbortSignal }) => {
    if (!String(url).endsWith('/audio/transcriptions')) return new Response(JSON.stringify({ speaker_segments: [] }))
    const file = init.body.get('file') as File
    const part = file.size - 1
    // like fetch: a request whose signal is aborted fails at once
    return new Promise<Response>((resolve, reject) => {
      waiting.push({ part, answer: resolve })
      init.signal?.addEventListener('abort', () => reject(new DOMException('The operation was aborted.', 'AbortError')))
    })
  })
  vi.stubGlobal('fetch', fetchMock)
  return { waiting, fetchMock }
}

function job(progress = vi.fn()): ProviderJob {
  return {
    audio: new Blob(['x']),
    parts: Array.from({ length: PARTS }, (_, index) => new Blob(['x'.repeat(index + 1)])),
    partSeconds: 300,
    language: 'pt',
    credential: { apiKey: 'chave', baseUrl: 'https://exemplo.test/v1', model: 'modelo', extra: '' },
    progress,
  }
}

const wordsOf = (part: number) => new Response(JSON.stringify({ words: [{ word: `parte${part}`, start: 1, end: 2 }] }))

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('audio parts sent together', () => {
  it('DeepInfra gets every part at once and the text comes back in the order of the audio', async () => {
    const { waiting, fetchMock } = slowProvider()
    const progress = vi.fn()
    const running = transcribeWithDeepInfra(job(progress))
    await vi.waitFor(() => expect(waiting).toHaveLength(PARTS * 2))
    expect(fetchMock.mock.calls.filter(([url]) => url === WHISPER_URL)).toHaveLength(PARTS * 2)
    for (const pending of [...waiting].reverse()) pending.answer(wordsOf(pending.part))
    const { words } = await running
    expect(words.map(word => word.text)).toEqual(Array.from({ length: PARTS }, (_, index) => `parte${index}`))
    expect(words.map(word => word.start)).toEqual(Array.from({ length: PARTS }, (_, index) => index * 300 + 1))
    expect(progress).toHaveBeenLastCalledWith('Transcrevendo pela DeepInfra', 1)
  })

  it('the custom provider gets every part at once too', async () => {
    const { waiting } = slowProvider()
    const running = transcribeWithCustom(job())
    await vi.waitFor(() => expect(waiting).toHaveLength(PARTS))
    for (const pending of [...waiting].reverse()) pending.answer(wordsOf(pending.part))
    const { words } = await running
    expect(words.map(word => word.text)).toEqual(Array.from({ length: PARTS }, (_, index) => `parte${index}`))
  })

  // T200 (research R28): on the meeting of 27/11, one part of the turbo held the whole transcription 94 s (the median was 15 s)
  it('a part still unanswered after twice the median of the others (20 s at least) is asked again once; the first answer wins and the late one stops', async () => {
    vi.useFakeTimers()
    const { waiting, fetchMock } = slowProvider()
    const four = { ...job(), parts: job().parts.slice(0, 4) }
    let done = false
    const running = transcribeWithCustom(four).finally(() => (done = true))
    await vi.advanceTimersByTimeAsync(10)
    expect(waiting).toHaveLength(4)
    // three parts answer at 5 s; the fourth is late
    await vi.advanceTimersByTimeAsync(5000)
    for (const pending of waiting.filter(item => item.part < 3)) pending.answer(wordsOf(pending.part))
    await vi.advanceTimersByTimeAsync(14_000)
    expect(waiting.filter(item => item.part === 3)).toHaveLength(1)
    // twice the median is 10 s: the floor of 20 s holds
    await vi.advanceTimersByTimeAsync(1_500)
    expect(waiting.filter(item => item.part === 3)).toHaveLength(2)
    const first = fetchMock.mock.calls.find(([, init]) => (init.body.get('file') as File).size === 4)![1] as unknown as { signal: AbortSignal }
    waiting.filter(item => item.part === 3)[1].answer(wordsOf(3))
    await vi.advanceTimersByTimeAsync(10)
    expect(done).toBe(true)
    expect((await running).words.map(word => word.text)).toEqual(['parte0', 'parte1', 'parte2', 'parte3'])
    expect(first.signal.aborted).toBe(true)
    // asked again only once, and nothing keeps ticking
    await vi.advanceTimersByTimeAsync(60_000)
    expect(waiting.filter(item => item.part === 3)).toHaveLength(2)
    expect(vi.getTimerCount()).toBe(0)
    vi.useRealTimers()
  })

  it('with no part answered yet there is no median, and nothing is asked again', async () => {
    vi.useFakeTimers()
    const { waiting } = slowProvider()
    const two = { ...job(), parts: job().parts.slice(0, 2) }
    const running = transcribeWithCustom(two)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(waiting).toHaveLength(2)
    for (const pending of waiting) pending.answer(wordsOf(pending.part))
    await vi.advanceTimersByTimeAsync(10)
    expect((await running).words).toHaveLength(2)
    vi.useRealTimers()
  })
})
