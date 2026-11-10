import { afterEach, describe, expect, it, vi } from 'vitest'

import { DEEPINFRA_TEXT_MODEL, transcribeWithDeepInfra } from '@/lib/transcription/providers/deepinfra'
import type { ProviderJob } from '@/lib/transcription/types'

const NEMOTRON_URL = 'https://api.deepinfra.com/v1/inference/nvidia/Nemotron-3-Diarization'
const PARTS = 4
const WAITING = ' · ainda esperando a DeepInfra…'

type Init = { signal?: AbortSignal; body: FormData }
type Kind = 'nemotron' | 'whisper' | 'voxtral'

const json = (body: object) => new Response(JSON.stringify(body))
const hang = (init: Init) => new Promise<Response>((_, reject) => init.signal?.addEventListener('abort', () => reject(new DOMException('The operation was aborted.', 'AbortError'))))

const whisper = { text: ' Olá mundo.', words: [{ word: ' Olá', start: 1, end: 1.4 }, { word: ' mundo.', start: 1.4, end: 2 }] }
const nemotron = { speaker_segments: [{ start: 0, end: 2, speaker: 'speaker_0' }] }

/** A fake DeepInfra where `stuck` says which requests it takes and never answers. Part n carries n+1 bytes. */
function serve(stuck: (kind: Kind, part: number) => boolean) {
  const fetch = vi.fn((url: string, init: Init) => {
    const kind: Kind = url === NEMOTRON_URL ? 'nemotron' : init.body.get('model') === DEEPINFRA_TEXT_MODEL ? 'voxtral' : 'whisper'
    const part = kind === 'nemotron' ? -1 : (init.body.get('file') as File).size - 1
    if (stuck(kind, part)) return hang(init)
    return Promise.resolve(json(kind === 'nemotron' ? nemotron : kind === 'voxtral' ? { text: whisper.text } : whisper))
  })
  vi.stubGlobal('fetch', fetch)
  const calls = (kind: Kind) => (fetch.mock.calls as unknown as [string, Init][]).filter(([url, init]) => (url === NEMOTRON_URL ? 'nemotron' : init.body.get('model') === DEEPINFRA_TEXT_MODEL ? 'voxtral' : 'whisper') === kind)
  return { fetch, calls }
}

const job = (progress = vi.fn(), parts = PARTS): ProviderJob => ({
  audio: new Blob(['x']),
  parts: Array.from({ length: parts }, (_, index) => new Blob(['x'.repeat(index + 1)], { type: 'audio/wav' })),
  partSeconds: 300,
  language: 'pt',
  credential: { apiKey: 'di_ok', baseUrl: '', model: '', extra: '' },
  progress,
})

const lastOf = (progress: ReturnType<typeof vi.fn>) => progress.mock.calls.at(-1)

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('DeepInfra waiting, with a time limit', () => {
  it('says which part it is waiting for, and that it is still waiting after 60 s without an answer', async () => {
    vi.useFakeTimers()
    serve((kind, part) => kind !== 'nemotron' && part === 2)
    const progress = vi.fn()
    transcribeWithDeepInfra(job(progress)).catch(() => {})
    await vi.advanceTimersByTimeAsync(10)
    expect(progress.mock.calls[0]).toEqual(['Transcrevendo pela DeepInfra · parte 1 de 4', 0])
    expect(lastOf(progress)).toEqual(['Transcrevendo pela DeepInfra · parte 3 de 4', 0.75])
    await vi.advanceTimersByTimeAsync(60_000)
    expect(lastOf(progress)).toEqual([`Transcrevendo pela DeepInfra · parte 3 de 4${WAITING}`, 0.75])
  })

  it('a recording of a single part does not say "parte 1 de 1"', async () => {
    vi.useFakeTimers()
    serve(() => false)
    const progress = vi.fn()
    await transcribeWithDeepInfra(job(progress, 1))
    expect(progress.mock.calls[0]).toEqual(['Transcrevendo pela DeepInfra', 0])
    expect(lastOf(progress)).toEqual(['Transcrevendo pela DeepInfra', 1])
  })

  it('each part request waits up to 3.5 min (a 5 min part) and then asks again', async () => {
    vi.useFakeTimers()
    const server = serve((kind, part) => kind === 'whisper' && part === 2)
    transcribeWithDeepInfra(job()).catch(() => {})
    await vi.advanceTimersByTimeAsync(209_999)
    expect(server.calls('whisper').filter(([, init]) => (init.body.get('file') as File).size === 3)).toHaveLength(1)
    expect(server.calls('whisper').find(([, init]) => (init.body.get('file') as File).size === 3)?.[1].signal?.aborted).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(server.calls('whisper').find(([, init]) => (init.body.get('file') as File).size === 3)?.[1].signal?.aborted).toBe(true)
    await vi.advanceTimersByTimeAsync(2000)
    expect(server.calls('whisper').filter(([, init]) => (init.body.get('file') as File).size === 3)).toHaveLength(2)
  })

  it('a part that never answers fails the job with a clear message, instead of hanging at 75%', async () => {
    vi.useFakeTimers()
    const server = serve((kind, part) => kind !== 'nemotron' && part === 2)
    const failing = transcribeWithDeepInfra(job()).catch((error: unknown) => error)
    await vi.advanceTimersByTimeAsync(640_000)
    expect(((await failing) as Error).message).toBe('A DeepInfra não respondeu a parte 3 de 4 depois de 3 tentativas. Tente de novo.')
    expect(server.calls('whisper')).toHaveLength(3 + 3)
  })

  it('after the last part it says it is separating the speakers, and the diarization has its own limit for the whole audio', async () => {
    vi.useFakeTimers()
    const server = serve(kind => kind === 'nemotron')
    const progress = vi.fn()
    transcribeWithDeepInfra(job(progress)).catch(() => {})
    await vi.advanceTimersByTimeAsync(10)
    expect(lastOf(progress)).toEqual(['Separando quem fala'])
    await vi.advanceTimersByTimeAsync(60_000)
    expect(lastOf(progress)).toEqual([`Separando quem fala${WAITING}`])
    // 4 parts of 5 min = 20 min of audio: 60 s + 10 s x 20 = 260 s (the speaker split is optional, so it waits less)
    const diarization = server.calls('nemotron')[0][1].signal
    await vi.advanceTimersByTimeAsync(259_999 - 60_010)
    expect(diarization?.aborted).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(diarization?.aborted).toBe(true)
  })

  it('a diarization that never answers is tried twice and then gives up: the text comes without speakers, with the reason, and nothing waits longer for it', async () => {
    vi.useFakeTimers()
    const server = serve(kind => kind === 'nemotron')
    let done = false
    const running = transcribeWithDeepInfra(job())
    running.then(() => (done = true), () => (done = true))
    // 2 x 260 s waiting, plus the pause of 2 s
    await vi.advanceTimersByTimeAsync(521_999)
    expect(done).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(done).toBe(true)
    const { words, turns, speakersError } = await running
    expect(words).toHaveLength(PARTS * 2)
    expect(turns).toEqual([])
    expect(speakersError).toBe('A DeepInfra não respondeu depois de 2 tentativas. Tente de novo.')
    expect(server.calls('nemotron')).toHaveLength(2)
  })

  it('leaves no "still waiting" timer behind when everything answers', async () => {
    vi.useFakeTimers()
    serve(() => false)
    await transcribeWithDeepInfra(job())
    expect(vi.getTimerCount()).toBe(0)
  })
})
