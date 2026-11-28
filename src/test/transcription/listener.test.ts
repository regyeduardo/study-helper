import { afterEach, describe, expect, it, vi } from 'vitest'

// T199 (dono, 28/11: "não quero por exemplo esperar mais de 1 minuto pra transcrever uma hora e meia, quero este tipo de performance ainda
// melhorando a qualidade", e no máximo 10 centavos): medido em 28/11 (research R28), os tempos do Whisper com o texto de um modelo que ouve
// (Qwen3.8 Omni Flash, pela OpenRouter, sem "pensar") deram 0% de palavras erradas e 27 de 27 termos na reunião montada (hoje, com o
// Voxtral: 1,5% e 24 de 27) e 13,1% contra 13,3% do Voxtral numa conversa real, por 1/20 do custo. Os termos vão para ele como contexto,
// nunca para o Whisper (com a lista, o turbo pulou quase tudo).

vi.mock('@/lib/transcription/audio', async importOriginal => ({ ...(await importOriginal<typeof import('@/lib/transcription/audio')>()), decodeChannels16k: vi.fn(async () => [new Float32Array(16000 * 12).map((_, at) => Math.sin(at / 8) * 0.3)]) }))

import { transcribe } from '@/lib/transcription'
import { DEEPINFRA_TEXT_MODEL, transcribeWithDeepInfra } from '@/lib/transcription/providers/deepinfra'
import type { ProviderJob } from '@/lib/transcription/types'
import { installBlobShim } from '@/test/imports/blob-shim'

// jsdom's Blob has no arrayBuffer (the browsers do)
installBlobShim()

const OPENROUTER = 'https://openrouter.ai/api/v1'
const LISTENER = { apiKey: 'or_ok', baseUrl: OPENROUTER, model: 'qwen/qwen3.8-omni-flash', extra: '' }

const json = (body: object, status = 200) => new Response(JSON.stringify(body), { status })
const whisper = {
  text: ' Quanto custou isso? Custou dois mil.',
  words: [
    { word: ' Quanto', start: 2, end: 2.4 },
    { word: ' custou', start: 2.4, end: 2.9 },
    { word: ' isso?', start: 2.9, end: 3.3 },
    { word: ' Custou', start: 4.1, end: 4.5 },
    { word: ' dois', start: 4.5, end: 5 },
    { word: ' mil.', start: 5, end: 5.6 },
  ],
}
const nemotron = { speaker_segments: [{ start: 0, end: 12, speaker: 'speaker_0' }] }
const heard = (content: string) => json({ choices: [{ message: { content } }], usage: { cost: 0.0004 } })

type Init = { body: FormData | string; headers?: Record<string, string>; signal?: AbortSignal }
interface Call {
  url: string
  form?: FormData
  sent?: { model: string; temperature: number; reasoning?: { enabled: boolean }; messages: { content: { type: string; input_audio?: { data: string; format: string }; text?: string }[] }[] }
  headers?: Record<string, string>
}

function serve(listen: () => Response | Promise<Response>) {
  const calls: Call[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: Init) => {
      if (url.endsWith('/chat/completions')) {
        calls.push({ url, sent: JSON.parse(init.body as string), headers: init.headers })
        return listen()
      }
      calls.push({ url, form: init.body as FormData })
      if (url.includes('Nemotron')) return json(nemotron)
      if ((init.body as FormData).get('model') === DEEPINFRA_TEXT_MODEL) return json({ text: 'Voxtral ouviu isto.' })
      return json(whisper)
    }),
  )
  return calls
}

const job = (fields: Partial<ProviderJob> = {}): ProviderJob => ({
  audio: new Blob(['gravação inteira'], { type: 'audio/webm' }),
  parts: [new Blob(['wav 1'], { type: 'audio/wav' })],
  partSeconds: 300,
  language: 'pt',
  credential: { apiKey: 'di_ok', baseUrl: '', model: '', extra: '' },
  listener: LISTENER,
  progress: () => {},
  ...fields,
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('o texto vem de um modelo que ouve, sobre os tempos do Whisper (T199)', () => {
  it('as palavras do modelo que ouve ficam nos tempos do Whisper, e o Voxtral não é chamado', async () => {
    const calls = serve(() => heard('Quanto custou isso? Custou dois mil reais.'))
    const { words } = await transcribeWithDeepInfra(job())
    expect(words.map(word => word.text)).toEqual(['Quanto', 'custou', 'isso?', 'Custou', 'dois', 'mil', 'reais.'])
    expect(words[3]).toEqual({ start: 4.1, end: 4.5, text: 'Custou' })
    expect(calls.some(call => call.form?.get('model') === DEEPINFRA_TEXT_MODEL)).toBe(false)
  })

  it('o pedido: o áudio da parte no formato dela, temperatura 0, sem "pensar", e a instrução de transcrever palavra por palavra', async () => {
    const calls = serve(() => heard('Quanto custou isso?'))
    await transcribeWithDeepInfra(job({ parts: [new Blob(['opus 1'], { type: 'audio/ogg' })] }))
    const listened = calls.find(call => call.sent)!
    expect(listened.url).toBe(`${OPENROUTER}/chat/completions`)
    expect(listened.headers?.authorization).toBe('Bearer or_ok')
    expect(listened.sent!.model).toBe('qwen/qwen3.8-omni-flash')
    expect(listened.sent!.temperature).toBe(0)
    expect(listened.sent!.reasoning).toEqual({ enabled: false })
    const [audio, text] = listened.sent!.messages[0].content
    expect(audio.input_audio?.format).toBe('ogg')
    expect(atob(audio.input_audio!.data)).toBe('opus 1')
    expect(text.text).toMatch(/palavra por palavra/)
    expect(text.text).toMatch(/português do Brasil/)
  })

  it('uma parte em WAV vai como wav', async () => {
    const calls = serve(() => heard('Quanto custou isso?'))
    await transcribeWithDeepInfra(job())
    expect(calls.find(call => call.sent)!.sent!.messages[0].content[0].input_audio?.format).toBe('wav')
  })

  it('os termos vão na instrução do modelo que ouve, e nunca no Whisper', async () => {
    const calls = serve(() => heard('Quanto custou o BGV?'))
    await transcribeWithDeepInfra(job({ terms: 'BGV, Kubernetes\nAna Paula' }))
    const instruction = calls.find(call => call.sent)!.sent!.messages[0].content[1].text!
    expect(instruction).toContain('BGV, Kubernetes, Ana Paula')
    const toWhisper = calls.filter(call => call.form?.has('file') && call.form.get('model') !== DEEPINFRA_TEXT_MODEL)
    expect(toWhisper.length).toBeGreaterThan(0)
    for (const call of toWhisper) expect(call.form!.has('prompt')).toBe(false)
  })

  it('o modelo que ouve recusou: ficam as palavras do Whisper', async () => {
    serve(() => json({ error: 'no' }, 400))
    const { words } = await transcribeWithDeepInfra(job())
    expect(words.map(word => word.text)).toEqual(['Quanto', 'custou', 'isso?', 'Custou', 'dois', 'mil.'])
  })

  it('sem um modelo que ouve na configuração, o Voxtral de antes', async () => {
    const calls = serve(() => heard('não devia ser chamado'))
    await transcribeWithDeepInfra(job({ listener: undefined }))
    expect(calls.some(call => call.sent)).toBe(false)
    expect(calls.some(call => call.form?.get('model') === DEEPINFRA_TEXT_MODEL)).toBe(true)
  })

  it('a transcrição pela DeepInfra leva o modelo que ouve da configuração até as partes', async () => {
    const calls = serve(() => heard('Quanto custou isso? Custou dois mil reais.'))
    const done = await transcribe(new Blob(['gravação'], { type: 'audio/webm' }), { engine: 'deepinfra', language: 'pt', credentials: { deepinfra: { apiKey: 'di_ok', baseUrl: '', model: '', extra: '' } }, listener: LISTENER, speakersEngine: '' })
    expect(calls.some(call => call.sent?.model === 'qwen/qwen3.8-omni-flash')).toBe(true)
    expect(done.text).toContain('reais')
    // T200: what it cost comes with the transcription (the listener said US$ 0.0004; the turbo by its price per hour)
    expect(done.cost).toBeGreaterThanOrEqual(0.0004)
  })

  // T200 (research R32): what each service said it cost, or its price per hour by the length heard, added up per transcription
  it('o custo da transcrição soma o que cada serviço disse ou, sem isso, o preço por hora pelo tempo ouvido', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.endsWith('/chat/completions')) return heard('Quanto custou isso?')
        if (url.includes('Nemotron')) return json({ ...nemotron, inference_status: { status: 'succeeded', cost: 0.002 } })
        return json({ ...whisper, duration: 300 })
      }),
    )
    const { cost } = await transcribeWithDeepInfra(job())
    // the turbo at US$ 0.012 per hour for 300 s, the listener's 0.0004 and the speaker split's 0.002
    expect(cost).toBeCloseTo(0.001 + 0.0004 + 0.002, 6)
  })
})
