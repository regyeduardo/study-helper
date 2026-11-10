import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { defaultSettings } from '@/lib/defaults'
import { transcribe } from '@/lib/transcription'
import { transcribeWithDeepInfra } from '@/lib/transcription/providers/deepinfra'
import type { ProviderJob } from '@/lib/transcription/types'
import { installBlobShim } from '@/test/imports/blob-shim'
import type { TranscriptionSettings } from '@/types/domain'

const mocks = vi.hoisted(() => ({ opusOgg: vi.fn<(source: Blob) => Promise<Blob | null>>() }))

vi.mock('@/lib/transcription/opus', async importOriginal => ({ ...(await importOriginal<typeof import('@/lib/transcription/opus')>()), opusOgg: mocks.opusOgg }))

const NEMOTRON_URL = 'https://api.deepinfra.com/v1/inference/nvidia/Nemotron-3-Diarization'
const CUSTOM_URL = 'https://agrupador.example/v1/audio/transcriptions'
const RATE = 16000

const json = (body: object, status = 200) => new Response(JSON.stringify(body), { status })

const whoSpoke = { speaker_segments: [{ start: 1.8, end: 3.6, speaker: 'speaker_0' }, { start: 3.9, end: 6, speaker: 'speaker_1' }] }
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

type Sent = [string, { body: FormData }]

/** A fake DeepInfra/Personalizado: `nemotron` answers the speaker split, anything else gives the text with time. */
function serve(nemotron: () => Response = () => json(whoSpoke)) {
  const fetch = vi.fn(async (url: string) => (url === NEMOTRON_URL ? nemotron() : json(timedOnly)))
  vi.stubGlobal('fetch', fetch)
  return (url: string) => fetch.mock.calls.filter(call => call[0] === url) as unknown as Sent[]
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

function settings(patch: Partial<TranscriptionSettings> = {}): TranscriptionSettings {
  return {
    ...defaultSettings().transcription,
    engine: 'deepinfra',
    credentials: {
      deepinfra: { apiKey: 'di_ok', baseUrl: '', model: '', extra: '' },
      custom: { apiKey: 'chave-do-agrupador', baseUrl: 'https://agrupador.example/v1', model: 'whisper-large', extra: '{"timestamp_granularities": ["word"]}' },
    },
    ...patch,
  }
}

const job = (fields: Partial<ProviderJob> = {}): ProviderJob => ({
  audio: new Blob(['x'.repeat(5000)], { type: 'video/webm' }),
  parts: [new Blob(['wav 1'], { type: 'audio/wav' })],
  partSeconds: 600,
  language: 'pt',
  credential: { apiKey: 'di_ok', baseUrl: '', model: '', extra: '' },
  progress: () => {},
  ...fields,
})

beforeEach(() => {
  installBlobShim()
  mocks.opusOgg.mockReset()
  mocks.opusOgg.mockResolvedValue(null)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('the speaker split gets the sound of the recording, not the video', () => {
  it('a recording with video sends Nemotron only its audio track (the 09/11 meeting was 1.2 GB of video for 17 MB of sound)', async () => {
    const sound = new Blob(['só o som'], { type: 'audio/ogg' })
    mocks.opusOgg.mockResolvedValue(sound)
    const video = new Blob(['x'.repeat(5000)], { type: 'video/webm' })
    const to = serve()
    const { turns } = await transcribeWithDeepInfra(job({ audio: video }))
    expect(mocks.opusOgg).toHaveBeenCalledWith(video)
    expect(to(NEMOTRON_URL)).toHaveLength(1)
    expect((to(NEMOTRON_URL)[0][1].body.get('audio') as File).size).toBe(sound.size)
    expect(turns.map(turn => turn.speaker)).toEqual(['speaker_0', 'speaker_1'])
  })

  it('a file whose sound cannot be taken apart (not a WebM with Opus) goes as it is', async () => {
    const song = new Blob(['x'.repeat(300)], { type: 'audio/mpeg' })
    const to = serve()
    await transcribeWithDeepInfra(job({ audio: song }))
    expect((to(NEMOTRON_URL)[0][1].body.get('audio') as File).size).toBe(song.size)
  })
})

describe('when the speaker split does not come, the note says why and the microphone stays clean', () => {
  it('a refused split is named in the warning, not passed off as a model that never separates speakers', async () => {
    stubDecoder([tone(8, 0.3)])
    serve(() => json({}, 413))
    const outcome = await transcribe(new Blob(['gravação'], { type: 'audio/webm' }), settings())
    expect(outcome.recording?.blocks.length).toBeGreaterThan(0)
    expect(outcome.recording?.warning).toBe('Os falantes não foram separados: A DeepInfra recusou o áudio (413).')
  })

  it('the quiet voice of the computer is never taken for who recorded (computer at -48 dB, below the old fixed floor)', async () => {
    // microphone loud on 0-4 s; on 4-6 s the person on the computer speaks at 0.004 (-48 dB), under the fixed -40 dB floor; the computer is loud later, so it is a call
    stubDecoder([joined(tone(4, 0.4), tone(4, 0)), joined(tone(4, 0), tone(2, 0.004), tone(2, 0.3))])
    const to = serve()
    const outcome = await transcribe(new Blob(['gravação'], { type: 'audio/webm' }), settings({ engine: 'custom' }), () => {}, undefined, { microphoneOnLeft: true, recorder: 'Regy Niles' })
    expect(to(CUSTOM_URL)).toHaveLength(1)
    expect(outcome.recording?.blocks.map(block => [block.speaker, block.text])).toEqual([
      ['mic', 'Quanto custou isso?'],
      ['', 'Custou dois mil.'],
    ])
  })
})
