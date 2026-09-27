import { describe, it, expect, vi, afterEach } from 'vitest'
import { TranscriptionError, transcribeWithGroqController } from '@/controllers/transcription.controller'

const audio = () => new Blob(['wav'], { type: 'audio/wav' })
const json = (body: object, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers })

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('Groq controller', () => {
  it('401 tells the user the key was refused', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ error: { message: 'Invalid API Key' } }, 401)))
    const call = transcribeWithGroqController(audio(), 'gsk_wrong', 'pt', 0)
    await expect(call).rejects.toBeInstanceOf(TranscriptionError)
    await expect(transcribeWithGroqController(audio(), 'gsk_wrong', 'pt', 0)).rejects.toThrow('A chave da Groq foi recusada.')
  })

  it('missing key fails before any request and says where to get one', async () => {
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)
    await expect(transcribeWithGroqController(audio(), '', 'pt', 0)).rejects.toThrow('Falta a chave da Groq nas Configurações (é grátis em console.groq.com).')
    expect(fetch).not.toHaveBeenCalled()
  })

  it('posts whisper-large-v3-turbo verbose_json with bearer key and offsets segments', async () => {
    const fetch = vi.fn(async () => json({ segments: [{ start: 1, end: 2.5, text: ' oi ' }, { start: 3, end: 4, text: 'tchau' }] }))
    vi.stubGlobal('fetch', fetch)
    const segments = await transcribeWithGroqController(audio(), 'gsk_ok', 'pt', 600)
    expect(segments).toEqual([
      { start: 601, end: 602.5, text: 'oi' },
      { start: 603, end: 604, text: 'tchau' },
    ])
    const [url, init] = fetch.mock.calls[0] as unknown as [string, { method: string; headers: Record<string, string>; body: FormData }]
    expect(url).toBe('https://api.groq.com/openai/v1/audio/transcriptions')
    expect(init.method).toBe('POST')
    expect(init.headers.Authorization).toBe('Bearer gsk_ok')
    expect(init.body.get('model')).toBe('whisper-large-v3-turbo')
    expect(init.body.get('response_format')).toBe('verbose_json')
    expect(init.body.get('language')).toBe('pt')
    expect((init.body.get('file') as File).name).toBe('trecho.wav')
  })

  it('auto language omits the field; text-only answer becomes one segment at the offset', async () => {
    const fetch = vi.fn(async () => json({ text: ' só texto ' }))
    vi.stubGlobal('fetch', fetch)
    expect(await transcribeWithGroqController(audio(), 'gsk_ok', '', 1200)).toEqual([{ start: 1200, end: 1200, text: 'só texto' }])
    expect((fetch.mock.calls[0] as unknown as [string, { body: FormData }])[1].body.has('language')).toBe(false)
    vi.stubGlobal('fetch', vi.fn(async () => json({ text: '' })))
    expect(await transcribeWithGroqController(audio(), 'gsk_ok', '', 0)).toEqual([])
  })

  it('429 waits retry-after then succeeds', async () => {
    vi.useFakeTimers()
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(json({}, 429, { 'retry-after': '3' }))
      .mockResolvedValueOnce(json({ segments: [{ start: 0, end: 1, text: 'ok' }] }))
    vi.stubGlobal('fetch', fetch)
    const call = transcribeWithGroqController(audio(), 'gsk_ok', 'pt', 0)
    await vi.advanceTimersByTimeAsync(2999)
    expect(fetch).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(await call).toEqual([{ start: 0, end: 1, text: 'ok' }])
  })

  it('429 six times gives up with the status', async () => {
    vi.useFakeTimers()
    const fetch = vi.fn(async () => json({}, 429))
    vi.stubGlobal('fetch', fetch)
    const call = transcribeWithGroqController(audio(), 'gsk_ok', 'pt', 0)
    const outcome = expect(call).rejects.toThrow('A Groq recusou o áudio (429).')
    await vi.advanceTimersByTimeAsync((2 + 4 + 8 + 16 + 32) * 1000)
    await outcome
    expect(fetch).toHaveBeenCalledTimes(6)
  })

  it('other errors, network failure and cancel have their own messages', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({}, 413)))
    await expect(transcribeWithGroqController(audio(), 'gsk_ok', 'pt', 0)).rejects.toThrow('A Groq recusou o áudio (413).')
    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new TypeError('network'))))
    await expect(transcribeWithGroqController(audio(), 'gsk_ok', 'pt', 0)).rejects.toThrow('A Groq não respondeu.')
    const controller = new AbortController()
    controller.abort()
    await expect(transcribeWithGroqController(audio(), 'gsk_ok', 'pt', 0, controller.signal)).rejects.toThrow('Transcrição cancelada.')
  })
})
