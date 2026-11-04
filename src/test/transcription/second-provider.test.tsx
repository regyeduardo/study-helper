import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import 'fake-indexeddb/auto'

import { render, screen } from '@testing-library/react'

import { TranscriptTab } from '@/components/reader/TranscriptTab'
import { defaultSettings } from '@/lib/defaults'
import { transcribe } from '@/lib/transcription'
import { installBlobShim } from '@/test/imports/blob-shim'
import type { TranscriptionSettings } from '@/types/domain'

const CUSTOM_URL = 'https://agrupador.example/v1/audio/transcriptions'
const NEMOTRON_URL = 'https://api.deepinfra.com/v1/inference/nvidia/Nemotron-3-Diarization'
const RATE = 16000

const timedOnly = {
  text: 'Quanto custou isso? Custou dois mil.',
  words: [
    { word: 'Quanto', start: 2, end: 2.4 },
    { word: 'custou', start: 2.4, end: 2.9 },
    { word: 'isso?', start: 2.9, end: 3.3 },
    { word: 'Custou', start: 4.1, end: 4.5 },
    { word: 'dois', start: 4.5, end: 5 },
    { word: 'mil.', start: 5, end: 5.6 },
  ],
}
const whoSpoke = { speaker_segments: [{ start: 1.8, end: 3.6, speaker: 'speaker_0' }, { start: 3.9, end: 6, speaker: 'speaker_1' }] }

const json = (body: object, status = 200) => new Response(JSON.stringify(body), { status })

function serve(nemotron: () => Response = () => json(whoSpoke)) {
  const fetch = vi.fn(async (url: string) => (url === NEMOTRON_URL ? nemotron() : json(timedOnly)))
  vi.stubGlobal('fetch', fetch)
  return (url: string) => fetch.mock.calls.filter(call => call[0] === url) as unknown as [string, { headers: Record<string, string>; body: FormData }][]
}

function stubDecoder(channels: Float32Array[]): void {
  vi.stubGlobal(
    'OfflineAudioContext',
    class {
      destination = {}
      decodeAudioData = async () => ({ duration: channels[0].length / RATE, sampleRate: 48000, numberOfChannels: channels.length })
      createBufferSource() {
        return { buffer: null, connect: vi.fn(), start: vi.fn() }
      }
      startRendering = async () => ({ getChannelData: (index: number) => channels[index] })
    },
  )
}

const tone = (seconds: number, level: number) => Float32Array.from({ length: seconds * RATE }, (_, index) => (index % 2 ? level : -level))
const joined = (...parts: Float32Array[]) => {
  const out = new Float32Array(parts.reduce((sum, part) => sum + part.length, 0))
  parts.reduce((at, part) => (out.set(part, at), at + part.length), 0)
  return out
}

const audio = new Blob(['gravação'], { type: 'audio/webm' })

function settings(patch: Partial<TranscriptionSettings> = {}): TranscriptionSettings {
  return {
    ...defaultSettings().transcription,
    engine: 'custom',
    credentials: { custom: { apiKey: 'chave-do-agrupador', baseUrl: 'https://agrupador.example/v1', model: 'whisper-large', extra: '{"timestamp_granularities": ["word"]}' }, deepinfra: { apiKey: 'di_ok', baseUrl: '', model: '', extra: '' } },
    ...patch,
  }
}

beforeEach(() => {
  installBlobShim()
  stubDecoder([tone(8, 0.3)])
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('a provider that gives only the text with time', () => {
  it('the transcription comes without speakers and with a warning saying what to do', async () => {
    const to = serve()
    const outcome = await transcribe(audio, settings())
    expect(outcome.recording?.blocks).toEqual([{ speaker: '', start: 2, end: 5.6, text: 'Quanto custou isso? Custou dois mil.' }])
    expect(outcome.recording?.speakers).toEqual([])
    expect(outcome.recording?.warning).toBe('Este modelo de transcrição não separa quem fala.')
    expect(outcome).toMatchObject({ engine: 'custom', language: 'pt', durationSeconds: 8, speakers: 0, text: '[00:02] Quanto custou isso? Custou dois mil.' })
    expect(to(CUSTOM_URL)).toHaveLength(1)
    expect(to(CUSTOM_URL)[0][1].body.getAll('timestamp_granularities[]')).toEqual(['word'])
    expect(to(NEMOTRON_URL)).toHaveLength(0)
  })

  it('with a second provider chosen only for the speakers, the speakers appear and the warning goes away', async () => {
    const to = serve()
    const outcome = await transcribe(audio, settings({ speakersEngine: 'deepinfra' }))
    expect(outcome.recording?.blocks).toEqual([
      { speaker: 'speaker_0', start: 2, end: 3.3, text: 'Quanto custou isso?' },
      { speaker: 'speaker_1', start: 4.1, end: 5.6, text: 'Custou dois mil.' },
    ])
    expect(outcome.recording?.speakers.map(speaker => speaker.name)).toEqual(['Falante 1', 'Falante 2'])
    expect(outcome.recording?.warning).toBeUndefined()
    expect(outcome.speakers).toBe(2)
    expect(outcome.text).toBe('Falante 1 [00:02]: Quanto custou isso?\nFalante 2 [00:04]: Custou dois mil.')
    expect(to(NEMOTRON_URL)).toHaveLength(1)
    expect(to(NEMOTRON_URL)[0][1].headers.Authorization).toBe('Bearer di_ok')
    expect(to(NEMOTRON_URL)[0][1].body.get('audio')).toBeTruthy()
  })

  it('when the second provider fails, the transcription is kept and the warning says why there are no speakers', async () => {
    serve(() => json({ error: 'x' }, 401))
    const outcome = await transcribe(audio, settings({ speakersEngine: 'deepinfra' }))
    expect(outcome.recording?.blocks).toHaveLength(1)
    expect(outcome.recording?.warning).toBe('Os falantes não foram separados: A chave da DeepInfra foi recusada.')
  })

  it('in an app recording the microphone side is "Quem gravou" when nobody is named, even without a second provider', async () => {
    stubDecoder([joined(tone(4, 0.4), tone(4, 0)), joined(tone(4, 0), tone(4, 0.4))])
    serve()
    const outcome = await transcribe(audio, settings(), () => {}, undefined, { microphoneOnLeft: true })
    expect(outcome.recording?.blocks.map(block => [block.speaker, block.text])).toEqual([
      ['mic', 'Quanto custou isso?'],
      ['', 'Custou dois mil.'],
    ])
    expect(outcome.recording?.speakers).toEqual([{ id: 'mic', name: 'Quem gravou', suggested: false }])
    expect(outcome.text).not.toContain('Você')
  })

  it('the microphone side gets the name of who recorded, never "Você"', async () => {
    stubDecoder([joined(tone(4, 0.4), tone(4, 0)), joined(tone(4, 0), tone(4, 0.4))])
    serve()
    const outcome = await transcribe(audio, settings(), () => {}, undefined, { microphoneOnLeft: true, recorder: 'Regy Niles' })
    expect(outcome.recording?.speakers).toEqual([{ id: 'mic', name: 'Regy Niles', suggested: false }])
    expect(outcome.text).toContain('Regy Niles [00:02]: Quanto custou isso?')
    expect(outcome.text).not.toContain('Você')
  })

  it('the note shows the warning above the speeches', () => {
    render(<TranscriptTab recording={{ blocks: [{ speaker: '', start: 2, end: 5.6, text: 'Quanto custou isso?' }], speakers: [], marks: [], warning: 'Este provedor não separa quem fala.' }} />)
    expect(screen.getByRole('status')).toHaveTextContent('Este provedor não separa quem fala.')
  })
})

describe('audio sent to the providers', () => {
  it('goes in parts of 5 minutes, so each request stays small', async () => {
    stubDecoder([tone(12 * 60, 0.3)])
    const sent = serve()
    await transcribe(audio, settings({ engine: 'deepinfra', speakersEngine: '' }))
    const parts = sent('https://api.deepinfra.com/v1/openai/audio/transcriptions')
      .filter(call => call[1].body.get('model') !== 'mistralai/Voxtral-Small-24B-2507')
      .map(call => call[1].body.get('file') as Blob)
    expect(parts.map(part => (part.size - 44) / 2 / RATE)).toEqual([300, 300, 120])
  })
})
