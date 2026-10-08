import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { SAMPLE_RATE, encodeWav } from '@/lib/transcription/audio'
import { transcribeWithOpenAi } from '@/lib/transcription/providers/openai'
import { blocksFromWords } from '@/lib/transcription/turns'
import type { ProviderJob } from '@/lib/transcription/types'
import { installBlobShim } from '@/test/imports/blob-shim'

const URL = 'https://api.openai.com/v1/audio/transcriptions'
const json = (body: object, status = 200) => new Response(JSON.stringify(body), { status })
const segment = (speaker: string, start: number, end: number, text: string) => ({ type: 'transcript.text.segment', id: `seg_${start}`, speaker, start, end, text })

const first = {
  text: 'Quanto custou isso? Custou dois mil. Com frete.',
  segments: [segment('A', 2, 3.3, ' Quanto custou isso?'), segment('B', 4.1, 9.6, ' Custou dois mil.'), segment('B', 9.8, 11, ' Com frete.'), segment('A', 12, 12.5, ' Tá.'), segment('A', 20, 34, ' Então fechamos assim, eu aviso o time hoje ainda.')],
}
const second = { text: 'Combinado.', segments: [segment('B', 1, 2, ' Combinado.')] }

type Call = [string, { method: string; headers: Record<string, string>; body: FormData }]

function serve(answers: Response[]) {
  const fetch = vi.fn(async () => answers.shift() ?? json({ text: '', segments: [] }))
  vi.stubGlobal('fetch', fetch)
  return () => fetch.mock.calls as unknown as Call[]
}

const part = (seconds: number) => encodeWav(new Float32Array(seconds * SAMPLE_RATE).fill(0.1))

const job = (fields: Partial<ProviderJob> = {}): ProviderJob => ({
  audio: new Blob(['gravação inteira'], { type: 'audio/webm' }),
  parts: [part(40)],
  partSeconds: 600,
  language: 'pt',
  credential: { apiKey: 'sk-ok', baseUrl: '', model: '', extra: '' },
  progress: () => {},
  ...fields,
})

beforeEach(() => installBlobShim())

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('OpenAI provider', () => {
  it('a diarized_json answer with speakers A and B becomes blocks per speaker with start and end', async () => {
    const calls = serve([json(first)])
    const { words, turns } = await transcribeWithOpenAi(job())
    expect(blocksFromWords(words, turns)).toEqual([
      { speaker: 'A', start: 2, end: 3.3, text: 'Quanto custou isso?' },
      { speaker: 'B', start: 4.1, end: 11, text: 'Custou dois mil. Com frete.' },
      { speaker: 'A', start: 12, end: 12.5, text: 'Tá.' },
      { speaker: 'A', start: 20, end: 34, text: 'Então fechamos assim, eu aviso o time hoje ainda.' },
    ])
    const [url, init] = calls()[0]
    expect(url).toBe(URL)
    expect(init.headers.Authorization).toBe('Bearer sk-ok')
    expect(init.body.get('model')).toBe('gpt-4o-transcribe-diarize')
    expect(init.body.get('response_format')).toBe('diarized_json')
    expect(init.body.get('chunking_strategy')).toBe('auto')
    expect(init.body.get('language')).toBe('pt')
    expect(init.body.getAll('known_speaker_names[]')).toEqual([])
  })

  it('a long recording goes in parts, and the next part gets a voice sample of each speaker so A and B stay the same people', async () => {
    const calls = serve([json(first), json(second)])
    const { words, turns } = await transcribeWithOpenAi(job({ parts: [part(40), part(5)], partSeconds: 40 }))
    expect(blocksFromWords(words, turns).at(-1)).toEqual({ speaker: 'B', start: 41, end: 42, text: 'Combinado.' })
    const body = calls()[1][1].body
    expect(body.getAll('known_speaker_names[]')).toEqual(['A', 'B'])
    const samples = body.getAll('known_speaker_references[]') as string[]
    expect(samples).toHaveLength(2)
    for (const sample of samples) expect(sample.startsWith('data:audio/wav;base64,')).toBe(true)
    const seconds = samples.map(sample => (atob(sample.split(',')[1]).length - 44) / 2 / SAMPLE_RATE)
    expect(seconds[0]).toBeCloseTo(10, 1)
    expect(seconds[1]).toBeCloseTo(5.5, 1)
  })

  it('a speaker who never spoke two seconds in a row sends no sample', async () => {
    const calls = serve([json({ text: '', segments: [segment('A', 0, 1, ' Oi.'), segment('B', 2, 6, ' Tudo bem?')] }), json(second)])
    await transcribeWithOpenAi(job({ parts: [part(10), part(5)], partSeconds: 10 }))
    expect(calls()[1][1].body.getAll('known_speaker_names[]')).toEqual(['B'])
  })

  it('a model without speakers gives the text with time and no speaker', async () => {
    const calls = serve([json({ text: ' Bom dia a todos.', words: [{ word: ' Bom', start: 0.2, end: 0.5 }, { word: ' dia', start: 0.5, end: 0.9 }] })])
    const { words, turns } = await transcribeWithOpenAi(job({ credential: { apiKey: 'sk-ok', baseUrl: '', model: 'whisper-1', extra: '' } }))
    expect(turns).toEqual([])
    expect(words.map(word => word.text)).toEqual(['Bom', 'dia'])
    const body = calls()[0][1].body
    expect(body.get('response_format')).toBe('verbose_json')
    expect(body.getAll('timestamp_granularities[]')).toEqual(['word'])
    expect(body.get('chunking_strategy')).toBeNull()
  })

  it('says where to get the key when it is missing, and that the key was refused', async () => {
    serve([])
    await expect(transcribeWithOpenAi(job({ credential: { apiKey: '', baseUrl: '', model: '', extra: '' } }))).rejects.toThrow('Falta a chave da OpenAI nas Configurações (platform.openai.com › API keys).')
    serve([json({ error: {} }, 401)])
    await expect(transcribeWithOpenAi(job())).rejects.toThrow('A chave da OpenAI foi recusada.')
  })
})
