import { describe, it, expect, vi, afterEach } from 'vitest'
import { DEEPINFRA_TEXT_MODEL, transcribeWithDeepInfra } from '@/lib/transcription/providers/deepinfra'
import { blocksFromWords } from '@/lib/transcription/turns'
import type { ProviderJob } from '@/lib/transcription/types'

const NEMOTRON_URL = 'https://api.deepinfra.com/v1/inference/nvidia/Nemotron-3-Diarization'
const WHISPER_URL = 'https://api.deepinfra.com/v1/openai/audio/transcriptions'

const json = (body: object, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers })

const nemotron = {
  text: '',
  segments: [],
  words: [],
  duration: 12,
  num_speakers: 2,
  speaker_segments: [
    { start: 0, end: 3.6, speaker: 'speaker_0' },
    { start: 3.9, end: 6, speaker: 'speaker_1' },
  ],
}

const whisper = {
  text: ' Quanto custou isso? Custou dois mil.',
  language: 'pt',
  duration: 12,
  words: [
    { word: ' Quanto', start: 2, end: 2.4 },
    { word: ' custou', start: 2.4, end: 2.9 },
    { word: ' isso?', start: 2.9, end: 3.3 },
    { word: ' Custou', start: 4.1, end: 4.5 },
    { word: ' dois', start: 4.5, end: 5 },
    { word: ' mil.', start: 5, end: 5.6 },
  ],
  segments: [{ id: 0, start: 0, end: 12, text: ' Quanto custou isso? Custou dois mil.' }],
}

type Call = [string, { method: string; headers: Record<string, string>; body: FormData; signal?: AbortSignal }]

const isText = (call: Call) => call[1].body.get('model') === DEEPINFRA_TEXT_MODEL

function serve(answers: { nemotron?: () => Response; whisper?: () => Response; voxtral?: () => Response } = {}) {
  const fetch = vi.fn(async (url: string, init: Call[1]) => {
    if (url === NEMOTRON_URL) return answers.nemotron?.() ?? json(nemotron)
    if (init.body.get('model') === DEEPINFRA_TEXT_MODEL) return answers.voxtral?.() ?? json({ text: whisper.text })
    return answers.whisper?.() ?? json(whisper)
  })
  vi.stubGlobal('fetch', fetch)
  const all = () => fetch.mock.calls as unknown as Call[]
  return { calls: all, to: (url: string) => all().filter(call => call[0] === url && !isText(call)), text: () => all().filter(isText) }
}

const job = (fields: Partial<ProviderJob> = {}): ProviderJob => ({
  audio: new Blob(['gravação inteira'], { type: 'audio/webm' }),
  parts: [new Blob(['wav 1'], { type: 'audio/wav' })],
  partSeconds: 600,
  language: 'pt',
  credential: { apiKey: 'di_ok', baseUrl: '', model: '', extra: '' },
  progress: () => {},
  ...fields,
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('DeepInfra provider', () => {
  it('returns who spoke and the text with time, ready to become blocks', async () => {
    serve()
    const { words, turns } = await transcribeWithDeepInfra(job())
    expect(turns).toEqual([
      { start: 0, end: 3.6, speaker: 'speaker_0' },
      { start: 3.9, end: 6, speaker: 'speaker_1' },
    ])
    expect(words[0]).toEqual({ start: 2, end: 2.4, text: 'Quanto' })
    expect(blocksFromWords(words, turns)).toEqual([
      { speaker: 'speaker_0', start: 2, end: 3.3, text: 'Quanto custou isso?' },
      { speaker: 'speaker_1', start: 4.1, end: 5.6, text: 'Custou dois mil.' },
    ])
  })

  it('sends the whole recording once to Nemotron, so the speakers keep the same label', async () => {
    const server = serve()
    const whole = new Blob(['gravação inteira'], { type: 'audio/webm' })
    await transcribeWithDeepInfra(job({ audio: whole, parts: [new Blob(['a']), new Blob(['b'])] }))
    const calls = server.to(NEMOTRON_URL)
    expect(calls).toHaveLength(1)
    expect(calls[0][1].method).toBe('POST')
    expect(calls[0][1].headers.Authorization).toBe('Bearer di_ok')
    expect((calls[0][1].body.get('audio') as File).size).toBe(whole.size)
  })

  it('asks whisper for word times on each part and shifts the later parts', async () => {
    const server = serve()
    const { words } = await transcribeWithDeepInfra(job({ parts: [new Blob(['a']), new Blob(['b'])] }))
    const calls = server.to(WHISPER_URL)
    expect(calls).toHaveLength(2)
    const body = calls[0][1].body
    expect(calls[0][1].headers.Authorization).toBe('Bearer di_ok')
    expect(body.get('model')).toBe('openai/whisper-large-v3')
    expect(body.get('response_format')).toBe('verbose_json')
    expect(body.getAll('timestamp_granularities[]')).toEqual(['word'])
    expect(body.get('language')).toBe('pt')
    expect((body.get('file') as File).name).toBe('trecho.wav')
    expect(words).toHaveLength(12)
    expect(words[6]).toEqual({ start: 602, end: 602.4, text: 'Quanto' })
  })

  it('uses the model typed by the user and sends Portuguese on auto, so Whisper never translates to English', async () => {
    const server = serve()
    await transcribeWithDeepInfra(job({ language: '', credential: { apiKey: 'di_ok', baseUrl: '', model: 'Qwen/Qwen3-ASR', extra: '' } }))
    const body = server.to(WHISPER_URL)[0][1].body
    expect(body.get('model')).toBe('Qwen/Qwen3-ASR')
    expect(body.get('language')).toBe('pt')
  })

  it('an answer with only segments still gives timed text', async () => {
    serve({ whisper: () => json({ text: 'oi tudo bem', segments: [{ start: 1, end: 2.5, text: ' oi ' }, { start: 3, end: 4, text: 'tudo bem' }] }), voxtral: () => json({}, 400) })
    const { words } = await transcribeWithDeepInfra(job())
    expect(words).toEqual([
      { start: 1, end: 2.5, text: 'oi' },
      { start: 3, end: 4, text: 'tudo bem' },
    ])
  })

  it('the words come from Voxtral, which hears better, on the times of Whisper, in the same language', async () => {
    const server = serve({ voxtral: () => json({ text: 'Quanto custou isso? Custou dois mil reais.' }) })
    const { words, inSpeech } = await transcribeWithDeepInfra(job())
    const asked = server.text()[0][1].body
    expect(asked.get('language')).toBe('pt')
    expect((asked.get('file') as File).name).toBe('trecho.wav')
    expect(words.map(word => word.text)).toEqual(['Quanto', 'custou', 'isso?', 'Custou', 'dois', 'mil', 'reais.'])
    expect(words[3]).toEqual({ start: 4.1, end: 4.5, text: 'Custou' })
    expect(inSpeech).toBe(true)
  })

  it('what Whisper invents where nobody speaks is dropped', async () => {
    serve({ whisper: () => json({ ...whisper, words: [{ word: ' Tchau.', start: 8, end: 8.5 }, ...whisper.words] }) })
    const { words } = await transcribeWithDeepInfra(job())
    expect(words.map(word => word.text)).not.toContain('Tchau.')
    expect(words).toHaveLength(6)
  })

  it('when Voxtral fails, the text of Whisper stays', async () => {
    serve({ voxtral: () => json({}, 400) })
    const { words } = await transcribeWithDeepInfra(job())
    expect(words.map(word => word.text)).toEqual(['Quanto', 'custou', 'isso?', 'Custou', 'dois', 'mil.'])
  })

  it('missing key fails before any request and says where to get one', async () => {
    const server = serve()
    await expect(transcribeWithDeepInfra(job({ credential: { apiKey: '', baseUrl: '', model: '', extra: '' } }))).rejects.toThrow('Falta a chave da DeepInfra nas Configurações (deepinfra.com › Dashboard › API Keys).')
    expect(server.calls()).toHaveLength(0)
  })

  it('refused key, refused audio, silence from the service and cancel have their own messages', async () => {
    serve({ whisper: () => json({}, 401), nemotron: () => json({}, 401) })
    await expect(transcribeWithDeepInfra(job())).rejects.toThrow('A chave da DeepInfra foi recusada.')
    serve({ whisper: () => json({}, 413) })
    await expect(transcribeWithDeepInfra(job())).rejects.toThrow('A DeepInfra recusou o áudio (413).')
    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new DOMException('aborted', 'AbortError'))))
    const controller = new AbortController()
    controller.abort()
    await expect(transcribeWithDeepInfra(job({ signal: controller.signal }))).rejects.toThrow('Transcrição cancelada.')
  })

  it('429 waits retry-after then goes on', async () => {
    vi.useFakeTimers()
    let refused = false
    serve({
      whisper: () => {
        if (refused) return json(whisper)
        refused = true
        return json({}, 429, { 'retry-after': '3' })
      },
    })
    const call = transcribeWithDeepInfra(job())
    await vi.advanceTimersByTimeAsync(3000)
    expect((await call).words).toHaveLength(6)
  })

  it('a server error (502) is tried again and the text comes', async () => {
    vi.useFakeTimers()
    let failed = false
    serve({
      whisper: () => {
        if (failed) return json(whisper)
        failed = true
        return json({}, 502)
      },
    })
    const call = transcribeWithDeepInfra(job())
    await vi.advanceTimersByTimeAsync(2000)
    expect((await call).words).toHaveLength(6)
  })

  it('when the server keeps failing or the network keeps dropping, it tries 6 times and then says so', async () => {
    vi.useFakeTimers()
    const server = serve({ whisper: () => json({}, 503) })
    const failing = expect(transcribeWithDeepInfra(job())).rejects.toThrow('A DeepInfra está com erro no servidor (503). Tente de novo em alguns minutos.')
    await vi.advanceTimersByTimeAsync(62000)
    await failing
    expect(server.to(WHISPER_URL)).toHaveLength(6)
    const dropped = vi.fn(async (_url: string, _init: Call[1]) => Promise.reject(new TypeError('network')))
    vi.stubGlobal('fetch', dropped)
    const offline = expect(transcribeWithDeepInfra(job())).rejects.toThrow('A DeepInfra não respondeu depois de 6 tentativas. Confira a internet e tente de novo.')
    await vi.advanceTimersByTimeAsync(62000)
    await offline
    expect((dropped.mock.calls as unknown as Call[]).filter(call => call[0] === WHISPER_URL && !isText(call))).toHaveLength(6)
  })

  it('when Nemotron fails the text still comes, without speakers', async () => {
    vi.useFakeTimers()
    serve({ nemotron: () => json({}, 500) })
    const call = transcribeWithDeepInfra(job())
    await vi.advanceTimersByTimeAsync(62000)
    const { words, turns } = await call
    expect(turns).toEqual([])
    expect(words).toHaveLength(6)
  })
})
