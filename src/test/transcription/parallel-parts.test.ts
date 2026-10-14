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
  const fetchMock = vi.fn(async (url: string, init: { body: FormData }) => {
    if (!String(url).endsWith('/audio/transcriptions')) return new Response(JSON.stringify({ speaker_segments: [] }))
    const file = init.body.get('file') as File
    const part = file.size - 1
    return new Promise<Response>(resolve => waiting.push({ part, answer: resolve }))
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
    await vi.waitFor(() => expect(waiting).toHaveLength(PARTS))
    expect(fetchMock.mock.calls.filter(([url]) => url === WHISPER_URL)).toHaveLength(PARTS)
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
})
