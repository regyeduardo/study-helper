import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RecordingData } from '@/types/domain'
import type { GenerationSession } from '@/lib/generation/session'
import { reviewTranscript } from '@/lib/generation/reviewer'
import { termsHint } from '@/lib/transcription/types'
import { transcribeWithCustom } from '@/lib/transcription/providers/custom'
import { DEEPINFRA_TEXT_MODEL, transcribeWithDeepInfra } from '@/lib/transcription/providers/deepinfra'
import { transcribeWithOpenAi } from '@/lib/transcription/providers/openai'
import type { ProviderJob } from '@/lib/transcription/types'

const TERMS = 'API, Kubernetes\nStewart\n\nAna Paula'

function job(terms: string): ProviderJob {
  return {
    audio: new Blob(['x']),
    parts: [new Blob(['parte'])],
    partSeconds: 300,
    language: 'pt',
    terms,
    credential: { apiKey: 'chave', baseUrl: 'https://exemplo.test/v1', model: 'whisper-1', extra: '' },
    progress: vi.fn(),
  }
}

function capture() {
  const forms: FormData[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init: { body: FormData }) => {
      forms.push(init.body)
      return new Response(JSON.stringify({ text: 'ok', words: [{ word: 'ok', start: 0, end: 1 }], speaker_segments: [] }))
    }),
  )
  return forms
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('your list of terms', () => {
  it('becomes a short hint with every term, one comma apart', () => {
    expect(termsHint(TERMS)).toBe('Termos que aparecem nesta gravação: API, Kubernetes, Stewart, Ana Paula.')
    expect(termsHint('  \n ')).toBe('')
  })

  it('goes with every transcription request, in every provider', async () => {
    for (const transcribe of [transcribeWithDeepInfra, transcribeWithCustom, transcribeWithOpenAi]) {
      const forms = capture()
      await transcribe(job(TERMS))
      const sent = forms.filter(form => form.has('file') && form.get('model') !== DEEPINFRA_TEXT_MODEL)
      expect(sent.length).toBeGreaterThan(0)
      for (const form of sent) expect(form.get('prompt')).toBe(termsHint(TERMS))
      vi.unstubAllGlobals()
    }
  })

  it('is left out when the list is empty', async () => {
    const forms = capture()
    await transcribeWithDeepInfra(job(''))
    expect(forms.filter(form => form.has('file')).every(form => !form.has('prompt'))).toBe(true)
  })

  it('goes to the AI review of the transcript', async () => {
    const chat = vi.fn(async (_content: string) => '{"correcoes": []}')
    const recording: RecordingData = { blocks: [{ speaker: 's1', start: 0, end: 2, text: 'o istiuarti diz' }], speakers: [{ id: 's1', name: 'Pessoa 1', suggested: false }], marks: [] }
    await reviewTranscript(recording, { chat } as unknown as GenerationSession, TERMS)
    expect(chat.mock.calls[0][0]).toContain(termsHint(TERMS))
  })
})
