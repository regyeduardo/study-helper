import { afterEach, describe, expect, it, vi } from 'vitest'

import { postAudioController, TranscriptionError } from '@/controllers/transcription.controller'
import { transcribeWithCustom } from '@/lib/transcription/providers/custom'
import { transcribeWithOpenAi } from '@/lib/transcription/providers/openai'
import type { ProviderJob } from '@/lib/transcription/types'

const SERVICE = { the: 'A DeepInfra', of: 'da DeepInfra' }
const URL = 'https://exemplo.test/audio'

type Init = { signal?: AbortSignal; body: FormData }

/** A server that takes the request and never answers, but lets go when the request is aborted (like a real fetch). */
const hang = (init: Init) => new Promise<Response>((_, reject) => init.signal?.addEventListener('abort', () => reject(new DOMException('The operation was aborted.', 'AbortError'))))

const json = (body: object) => new Response(JSON.stringify(body))

const silent = () => {
  const fetch = vi.fn((_url: string, init: Init) => hang(init))
  vi.stubGlobal('fetch', fetch)
  return fetch
}

const signalOf = (fetch: ReturnType<typeof silent>, call: number) => (fetch.mock.calls[call] as unknown as [string, Init])[1].signal

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('time limit of an audio request', () => {
  it('gives up on a request that never answers after 60 s plus 30 s per minute of audio (5 min = 3.5 min) and asks again', async () => {
    vi.useFakeTimers()
    const fetch = silent()
    postAudioController(URL, 'k', new FormData(), SERVICE, undefined, { audioSeconds: 300 }).catch(() => {})
    await vi.advanceTimersByTimeAsync(209_999)
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(signalOf(fetch, 0)?.aborted).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(signalOf(fetch, 0)?.aborted).toBe(true)
    await vi.advanceTimersByTimeAsync(2000)
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it.each([
    [60, 90_000],
    [1020, 570_000],
  ])('the limit grows with the audio: %i s of audio waits %i ms', async (audioSeconds, limit) => {
    vi.useFakeTimers()
    const fetch = silent()
    postAudioController(URL, 'k', new FormData(), SERVICE, undefined, { audioSeconds }).catch(() => {})
    await vi.advanceTimersByTimeAsync(limit - 1)
    expect(signalOf(fetch, 0)?.aborted).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(signalOf(fetch, 0)?.aborted).toBe(true)
  })

  it('a request that keeps timing out is tried 3 times, 2 retries, and fails within about 11 minutes saying which part never answered', async () => {
    vi.useFakeTimers()
    const fetch = silent()
    let settled = false
    const failing = postAudioController(URL, 'k', new FormData(), SERVICE, undefined, { audioSeconds: 300, part: { number: 4, of: 4 } }).catch((error: unknown) => error)
    failing.then(() => (settled = true))
    // 3 x 210 s waiting, plus the pauses of 2 s and 4 s
    await vi.advanceTimersByTimeAsync(635_999)
    expect(settled).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    const error = await failing
    expect(error).toBeInstanceOf(TranscriptionError)
    expect((error as Error).message).toBe('A DeepInfra não respondeu a parte 4 de 4 depois de 3 tentativas. Tente de novo.')
    expect(fetch).toHaveBeenCalledTimes(3)
  })

  it('without a part (or with a single one) the message does not talk about parts', async () => {
    vi.useFakeTimers()
    silent()
    const whole = postAudioController(URL, 'k', new FormData(), SERVICE, undefined, { audioSeconds: 300 }).catch((error: unknown) => error)
    const single = postAudioController(URL, 'k', new FormData(), SERVICE, undefined, { audioSeconds: 300, part: { number: 1, of: 1 } }).catch((error: unknown) => error)
    await vi.advanceTimersByTimeAsync(700_000)
    expect(((await whole) as Error).message).toBe('A DeepInfra não respondeu depois de 3 tentativas. Tente de novo.')
    expect(((await single) as Error).message).toBe('A DeepInfra não respondeu depois de 3 tentativas. Tente de novo.')
  })

  it('an optional request can ask for a shorter wait (10 s per minute) and fewer tries: 20 min waits 260 s, twice', async () => {
    vi.useFakeTimers()
    const fetch = silent()
    const failing = postAudioController(URL, 'k', new FormData(), SERVICE, undefined, { audioSeconds: 1200, waitPerMinute: 10, timeoutAttempts: 2 }).catch((error: unknown) => error)
    await vi.advanceTimersByTimeAsync(259_999)
    expect(signalOf(fetch, 0)?.aborted).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(signalOf(fetch, 0)?.aborted).toBe(true)
    await vi.advanceTimersByTimeAsync(262_000)
    expect(((await failing) as Error).message).toBe('A DeepInfra não respondeu depois de 2 tentativas. Tente de novo.')
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('a dropped network and a server error keep the 6 tries, even after a timeout', async () => {
    vi.useFakeTimers()
    let calls = 0
    const fetch = vi.fn((_url: string, init: Init) => (++calls === 1 ? hang(init) : Promise.reject(new TypeError('network'))))
    vi.stubGlobal('fetch', fetch)
    const failing = postAudioController(URL, 'k', new FormData(), SERVICE, undefined, { audioSeconds: 300 }).catch((error: unknown) => error)
    await vi.advanceTimersByTimeAsync(400_000)
    expect(((await failing) as Error).message).toBe('A DeepInfra não respondeu depois de 6 tentativas. Confira a internet e tente de novo.')
    expect(fetch).toHaveBeenCalledTimes(6)
  })

  it('a request that answers on the second try returns its answer', async () => {
    vi.useFakeTimers()
    let calls = 0
    const fetch = vi.fn((_url: string, init: Init) => (++calls === 1 ? hang(init) : Promise.resolve(json({ text: 'oi' }))))
    vi.stubGlobal('fetch', fetch)
    const sent = postAudioController(URL, 'k', new FormData(), SERVICE, undefined, { audioSeconds: 300 })
    await vi.advanceTimersByTimeAsync(212_000)
    expect(await sent).toEqual({ text: 'oi' })
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('an answer whose body never arrives also times out and is asked again', async () => {
    vi.useFakeTimers()
    let calls = 0
    const stuckBody = { ok: true, status: 200, headers: new Headers(), json: () => new Promise(() => {}) } as unknown as Response
    const fetch = vi.fn(async () => (++calls === 1 ? stuckBody : json({ text: 'oi' })))
    vi.stubGlobal('fetch', fetch)
    const sent = postAudioController(URL, 'k', new FormData(), SERVICE, undefined, { audioSeconds: 300 })
    await vi.advanceTimersByTimeAsync(212_000)
    expect(await sent).toEqual({ text: 'oi' })
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('the cancel of the job still wins: no new try, and no timer is left running', async () => {
    vi.useFakeTimers()
    const fetch = silent()
    const cancel = new AbortController()
    const sent = postAudioController(URL, 'k', new FormData(), SERVICE, cancel.signal, { audioSeconds: 300 }).catch((error: unknown) => error)
    await vi.advanceTimersByTimeAsync(1000)
    cancel.abort()
    expect(((await sent) as Error).message).toBe('Transcrição cancelada.')
    await vi.advanceTimersByTimeAsync(600_000)
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('an answer on time leaves no timer behind', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('fetch', vi.fn(async () => json({ text: 'oi' })))
    expect(await postAudioController(URL, 'k', new FormData(), SERVICE, undefined, { audioSeconds: 300 })).toEqual({ text: 'oi' })
    expect(vi.getTimerCount()).toBe(0)
  })
})

describe('other providers of the shared function', () => {
  const job = (credential: ProviderJob['credential']): ProviderJob => ({ audio: new Blob(['x']), parts: [new Blob(['x'])], partSeconds: 300, language: 'pt', credential, progress: () => {} })

  it('the custom provider gets the same limit', async () => {
    vi.useFakeTimers()
    const fetch = silent()
    transcribeWithCustom(job({ apiKey: 'k', baseUrl: 'https://exemplo.test/v1', model: 'modelo', extra: '' })).catch(() => {})
    await vi.advanceTimersByTimeAsync(209_999)
    expect(signalOf(fetch, 0)?.aborted).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(signalOf(fetch, 0)?.aborted).toBe(true)
  })

  it('OpenAI gets the same limit', async () => {
    vi.useFakeTimers()
    const fetch = silent()
    transcribeWithOpenAi(job({ apiKey: 'k', baseUrl: '', model: 'whisper-1', extra: '' })).catch(() => {})
    await vi.advanceTimersByTimeAsync(209_999)
    expect(signalOf(fetch, 0)?.aborted).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(signalOf(fetch, 0)?.aborted).toBe(true)
  })
})
