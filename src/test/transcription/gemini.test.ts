import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { SAMPLE_RATE, encodeWav } from '@/lib/transcription/audio'
import { transcribeWithGemini } from '@/lib/transcription/providers/gemini'
import { blocksFromWords } from '@/lib/transcription/turns'
import type { ProviderJob } from '@/lib/transcription/types'
import { installBlobShim } from '@/test/imports/blob-shim'

const json = (body: object, status = 200) => new Response(JSON.stringify(body), { status })
const answer = (text: string) => json({ candidates: [{ content: { parts: [{ text }] } }] })
const speech = (falante: string, inicio: number, fim: number, texto: string) => ({ falante, inicio, fim, texto })
const speeches = (...falas: unknown[]) => answer(JSON.stringify({ falas }))

type Call = [string, { method: string; headers: Record<string, string>; body: string }]

function serve(answers: Response[]) {
  const fetch = vi.fn(async () => answers.shift() ?? speeches())
  vi.stubGlobal('fetch', fetch)
  return () => fetch.mock.calls as unknown as Call[]
}

const sent = (call: Call) => JSON.parse(call[1].body) as { contents: { parts: [{ inline_data: { mime_type: string; data: string } }, { text: string }] }[] }
const secondsOf = (call: Call) => (atob(sent(call).contents[0].parts[0].inline_data.data).length - 44) / 2 / SAMPLE_RATE
const instructionOf = (call: Call) => sent(call).contents[0].parts[1].text

const part = (seconds: number) => encodeWav(new Float32Array(seconds * SAMPLE_RATE).fill(0.1))

const job = (fields: Partial<ProviderJob> = {}): ProviderJob => ({
  audio: new Blob(['gravação inteira'], { type: 'audio/webm' }),
  parts: [part(40)],
  partSeconds: 600,
  language: 'pt',
  credential: { apiKey: 'chave-ok', baseUrl: '', model: '', extra: '' },
  progress: () => {},
  ...fields,
})

beforeEach(() => installBlobShim())

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('Gemini provider', () => {
  it('the speeches of the answer become blocks per speaker with start and end', async () => {
    const calls = serve([speeches(speech('F1', 2, 3.3, ' Quanto custou isso? '), speech('F2', 4.1, 9.6, 'Custou dois mil.'), speech('F2', 9.8, 11, 'Com frete.'), speech('F1', 12, 12.5, 'Tá.'))])
    const { words, turns } = await transcribeWithGemini(job())
    expect(blocksFromWords(words, turns)).toEqual([
      { speaker: 'F1', start: 2, end: 3.3, text: 'Quanto custou isso?' },
      { speaker: 'F2', start: 4.1, end: 11, text: 'Custou dois mil. Com frete.' },
      { speaker: 'F1', start: 12, end: 12.5, text: 'Tá.' },
    ])
    expect(calls()).toHaveLength(1)
    const [url, init] = calls()[0]
    expect(url).toBe('https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-latest:generateContent')
    expect(init.headers['x-goog-api-key']).toBe('chave-ok')
    expect(sent(calls()[0]).contents[0].parts[0].inline_data.mime_type).toBe('audio/wav')
    expect(secondsOf(calls()[0])).toBeCloseTo(40, 1)
    expect(instructionOf(calls()[0])).toContain('(pt)')
    expect(instructionOf(calls()[0])).not.toContain('continua uma gravação')
  })

  it('a long part goes in clips of 5 minutes, each one with the last speeches so the same voice keeps its label', async () => {
    const before = Array.from({ length: 8 }, (_, index) => speech(index % 2 ? 'F2' : 'F1', index * 10, index * 10 + 5, `fala ${index + 1}`))
    const calls = serve([speeches(...before), speeches(speech('F2', 1, 2, 'Combinado.'))])
    const { words, turns } = await transcribeWithGemini(job({ parts: [part(320)] }))
    expect(calls()).toHaveLength(2)
    expect(secondsOf(calls()[0])).toBeCloseTo(300, 1)
    expect(secondsOf(calls()[1])).toBeCloseTo(20, 1)
    const instruction = instructionOf(calls()[1])
    expect(instruction).toContain('F1: fala 3\nF2: fala 4\nF1: fala 5\nF2: fala 6\nF1: fala 7\nF2: fala 8')
    expect(instruction).not.toContain('fala 2')
    expect(words.at(-1)).toEqual({ start: 301, end: 302, text: 'Combinado.' })
    expect(turns.at(-1)).toEqual({ start: 301, end: 302, speaker: 'F2' })
  })

  it('the second part of the recording counts the time from where the first one ended', async () => {
    serve([speeches(speech('F1', 1, 2, 'Bom dia.')), speeches(speech('F1', 3, 4, 'Até logo.'))])
    const { words } = await transcribeWithGemini(job({ parts: [part(40), part(10)], partSeconds: 40 }))
    expect(words).toEqual([
      { start: 1, end: 2, text: 'Bom dia.' },
      { start: 43, end: 44, text: 'Até logo.' },
    ])
  })

  it('a speech without label keeps the text and gives no speaker, and one without text or time is dropped', async () => {
    serve([speeches({ inicio: 0, fim: 1, texto: 'Sem rótulo.' }, speech('F1', 2, 3, '   '), { falante: 'F1', texto: 'Sem tempo.' }, 'lixo')])
    const { words, turns } = await transcribeWithGemini(job())
    expect(words).toEqual([{ start: 0, end: 1, text: 'Sem rótulo.' }])
    expect(turns).toEqual([])
  })

  it('says where to get the key when it is missing, that the key was refused and that the answer could not be read', async () => {
    serve([])
    await expect(transcribeWithGemini(job({ credential: { apiKey: '', baseUrl: '', model: '', extra: '' } }))).rejects.toThrow('Falta a chave do Gemini nas Configurações (aistudio.google.com › Get API key).')
    serve([json({ error: {} }, 403)])
    await expect(transcribeWithGemini(job())).rejects.toThrow('A chave do Gemini foi recusada.')
    serve([answer('isto não é JSON')])
    await expect(transcribeWithGemini(job())).rejects.toThrow('O Gemini devolveu uma transcrição que não deu para ler. Tente de novo.')
  })
})
