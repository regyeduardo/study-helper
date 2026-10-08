import { afterEach, describe, expect, it, vi } from 'vitest'

import { transcribeWithCustom } from '@/lib/transcription/providers/custom'
import { blocksFromWords } from '@/lib/transcription/turns'
import type { ProviderJob } from '@/lib/transcription/types'

const json = (body: object, status = 200) => new Response(JSON.stringify(body), { status })

const answer = {
  text: 'Quanto custou isso? Custou dois mil.',
  segments: [
    { id: 0, start: 2, end: 3.3, text: ' Quanto custou isso?', speaker: 'SPEAKER_00' },
    { id: 1, start: 4.1, end: 5.6, text: ' Custou dois mil.', speaker: 'SPEAKER_01' },
  ],
}

type Call = [string, { method: string; headers: Record<string, string>; body: FormData }]

function serve(answers: Response[]) {
  const fetch = vi.fn(async () => answers.shift() ?? json(answer))
  vi.stubGlobal('fetch', fetch)
  return () => fetch.mock.calls as unknown as Call[]
}

const job = (credential: Partial<ProviderJob['credential']> = {}, fields: Partial<ProviderJob> = {}): ProviderJob => ({
  audio: new Blob(['gravação inteira'], { type: 'audio/webm' }),
  parts: [new Blob(['wav 1'], { type: 'audio/wav' })],
  partSeconds: 600,
  language: 'pt',
  credential: { apiKey: 'chave-do-agrupador', baseUrl: 'https://agrupador.example/v1/', model: 'whisper-diarize', extra: '', ...credential },
  progress: () => {},
  ...fields,
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('custom provider in the OpenAI format', () => {
  it('segments with speaker become blocks with time and speaker', async () => {
    const calls = serve([])
    const { words, turns } = await transcribeWithCustom(job())
    expect(blocksFromWords(words, turns)).toEqual([
      { speaker: 'SPEAKER_00', start: 2, end: 3.3, text: 'Quanto custou isso?' },
      { speaker: 'SPEAKER_01', start: 4.1, end: 5.6, text: 'Custou dois mil.' },
    ])
    const [url, init] = calls()[0]
    expect(url).toBe('https://agrupador.example/v1/audio/transcriptions')
    expect(init.headers.Authorization).toBe('Bearer chave-do-agrupador')
    expect(init.body.get('model')).toBe('whisper-diarize')
    expect(init.body.get('language')).toBe('pt')
    expect(init.body.get('response_format')).toBe('verbose_json')
  })

  it('the request carries the extra options, lists as repeated fields, and they win over the defaults', async () => {
    const calls = serve([])
    await transcribeWithCustom(job({ extra: '{"diarize": true, "response_format": "diarized_json", "timestamp_granularities": ["word", "segment"], "vad": {"min_silence_ms": 300}, "language": null}' }))
    const body = calls()[0][1].body
    expect(body.get('diarize')).toBe('true')
    expect(body.getAll('response_format')).toEqual(['diarized_json'])
    expect(body.getAll('timestamp_granularities[]')).toEqual(['word', 'segment'])
    expect(body.get('vad')).toBe('{"min_silence_ms":300}')
    expect(body.get('language')).toBeNull()
  })

  it('reads the speaker from each word, and the time of each part of a long recording', async () => {
    const part = { text: 'oi tudo bem', words: [{ word: 'oi', start: 1, end: 1.3, speaker: 0 }, { word: 'tudo', start: 2, end: 2.4, speaker: 1 }, { word: 'bem', start: 2.4, end: 2.8, speaker: 1 }] }
    serve([json(part), json(part)])
    const { words, turns } = await transcribeWithCustom(job({}, { parts: [new Blob(['a']), new Blob(['b'])] }))
    expect(blocksFromWords(words, turns).map(block => [block.speaker, block.start, block.text])).toEqual([
      ['0', 1, 'oi'],
      ['1', 2, 'tudo bem'],
      ['0', 601, 'oi'],
      ['1', 602, 'tudo bem'],
    ])
  })

  it('accepts the address with or without the final path', async () => {
    const calls = serve([])
    await transcribeWithCustom(job({ baseUrl: 'https://agrupador.example/v1/audio/transcriptions' }))
    await transcribeWithCustom(job({ baseUrl: 'https://agrupador.example/v1' }))
    expect(calls().map(call => call[0])).toEqual(['https://agrupador.example/v1/audio/transcriptions', 'https://agrupador.example/v1/audio/transcriptions'])
  })

  it('says what is missing or wrong in the settings before sending anything', async () => {
    const calls = serve([])
    await expect(transcribeWithCustom(job({ baseUrl: '' }))).rejects.toThrow('Falta o endereço do provedor personalizado nas Configurações.')
    await expect(transcribeWithCustom(job({ model: '' }))).rejects.toThrow('Falta o modelo do provedor personalizado nas Configurações.')
    await expect(transcribeWithCustom(job({ extra: '{diarize' }))).rejects.toThrow('As opções extras do provedor personalizado não são um JSON válido.')
    await expect(transcribeWithCustom(job({ extra: '[1]' }))).rejects.toThrow('As opções extras do provedor personalizado não são um JSON válido.')
    expect(calls()).toHaveLength(0)
  })
})
