import { afterEach, describe, expect, it, vi } from 'vitest'

import { MeetingRecorder } from '@/lib/recording/recorder'
import { SAMPLE_RATE, decodeChannels16k } from '@/lib/transcription/audio'
import { blocksFromWords, microphoneWords, speakersOf } from '@/lib/transcription/turns'
import { FakeAudioContext, installMediaEnvironment } from '@/test/recording/media-fakes'

const turn = (start: number, end: number, speaker: string) => ({
  start,
  end,
  speaker,
})
const word = (start: number, end: number, text: string) => ({
  start,
  end,
  text,
})

function channel(...stretches: [number, number][]): Float32Array {
  const samples = new Float32Array(stretches.reduce((sum, [seconds]) => sum + seconds, 0) * SAMPLE_RATE)
  let at = 0
  for (const [seconds, level] of stretches) {
    for (let index = 0; index < seconds * SAMPLE_RATE; index++) samples[at + index] = index % 2 ? level : -level
    at += seconds * SAMPLE_RATE
  }
  return samples
}

const words = [word(0.5, 1.2, 'Quanto'), word(1.2, 2.5, 'custou?'), word(3.5, 4.4, 'Dois'), word(4.4, 5.5, 'mil.')]
const turns = [turn(0.2, 2.8, 'speaker_0'), turn(3.2, 5.8, 'speaker_1')]

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('who spoke into the microphone', () => {
  it('speech only on the microphone channel is "Você", speech only on the computer channel is someone else', () => {
    const fromMicrophone = microphoneWords({
      microphone: channel([3, 0.4], [3, 0]),
      computer: channel([3, 0], [3, 0.4]),
    })
    const blocks = blocksFromWords(words, turns, fromMicrophone)
    expect(blocks.map(block => [block.speaker, block.text])).toEqual([
      ['mic', 'Quanto custou?'],
      ['speaker_1', 'Dois mil.'],
    ])
    expect(speakersOf(blocks)).toEqual([
      { id: 'mic', name: 'Você', suggested: false },
      { id: 'speaker_1', name: 'Falante 2', suggested: false },
    ])
  })

  it('the computer sound leaking into the microphone does not turn the other person into "Você"', () => {
    const fromMicrophone = microphoneWords({
      microphone: channel([3, 0.4], [3, 0.08]),
      computer: channel([3, 0], [3, 0.4]),
    })
    expect(blocksFromWords(words, turns, fromMicrophone).map(block => block.speaker)).toEqual(['mic', 'speaker_1'])
  })

  it('a meeting in the room, with no computer sound, keeps the speakers the service found', () => {
    const fromMicrophone = microphoneWords({
      microphone: channel([6, 0.4]),
      computer: channel([6, 0]),
    })
    const blocks = blocksFromWords(words, turns, fromMicrophone)
    expect(blocks.map(block => block.speaker)).toEqual(['speaker_0', 'speaker_1'])
    expect(speakersOf(blocks).map(speaker => speaker.name)).toEqual(['Falante 1', 'Falante 2'])
  })

  it('numbers the others by the order they first speak, and without speakers names nobody', () => {
    const fromMicrophone = microphoneWords({
      microphone: channel([3, 0], [3, 0.4]),
      computer: channel([3, 0.4], [3, 0]),
    })
    expect(speakersOf(blocksFromWords(words, turns, fromMicrophone))).toEqual([
      { id: 'speaker_0', name: 'Falante 1', suggested: false },
      { id: 'mic', name: 'Você', suggested: false },
    ])
    expect(speakersOf(blocksFromWords(words, []))).toEqual([])
  })
})

describe('decodeChannels16k', () => {
  const contexts: { channels: number; length: number; rate: number }[] = []
  const left = Float32Array.from([0.1, 0.2])
  const right = Float32Array.from([0.3, 0.4])

  function stubDecoder(numberOfChannels: number): void {
    contexts.length = 0
    vi.stubGlobal(
      'OfflineAudioContext',
      class {
        destination = {}
        constructor(channels: number, length: number, rate: number) {
          contexts.push({ channels, length, rate })
        }
        decodeAudioData = async () => ({
          duration: 1,
          sampleRate: 48000,
          numberOfChannels,
        })
        createBufferSource() {
          return { buffer: null, connect: vi.fn(), start: vi.fn() }
        }
        startRendering = async () => ({
          getChannelData: (index: number) => (index ? right : left),
        })
      },
    )
  }

  const audio = {
    arrayBuffer: async () => new ArrayBuffer(8),
  } as unknown as Blob

  it('a stereo recording comes back as microphone and computer, at 16 kHz', async () => {
    stubDecoder(2)
    const channels = await decodeChannels16k(audio)
    expect(contexts[1]).toEqual({ channels: 2, length: 16000, rate: 16000 })
    expect(channels.map(samples => Array.from(samples))).toEqual([Array.from(left), Array.from(right)])
  })

  it('a mono file comes back as one channel', async () => {
    stubDecoder(1)
    expect(await decodeChannels16k(audio)).toHaveLength(1)
    expect(contexts[1].channels).toBe(1)
  })
})

describe('MeetingRecorder channels', () => {
  it('records the microphone on the left and the computer sound on the right', async () => {
    installMediaEnvironment()
    await new MeetingRecorder({
      onTick: vi.fn(),
      onFinished: vi.fn(),
      onCancelled: vi.fn(),
      onError: vi.fn(),
    }).start('tab')
    const context = FakeAudioContext.instances[0]
    expect(context.merger.connect).toHaveBeenCalledWith(context.destination)
    expect(context.microphoneGain.connect).toHaveBeenCalledWith(context.merger, 0, 0)
    expect(context.sourceGain.connect).toHaveBeenCalledWith(context.merger, 0, 1)
    expect(context.destination).toMatchObject({
      channelCount: 2,
      channelCountMode: 'explicit',
    })
  })
})
