import { describe, expect, it } from 'vitest'

// T202 (research R30): a gravação guarda o volume de cada canal a cada 50 ms (o microfone à esquerda), e o servidor sabe que palavra veio
// de quem gravou sem decodificar o áudio (decodificar 1h30 gasta ~20 s de CPU).

import { SAMPLE_RATE } from '@/lib/transcription/audio'
import { computerWords, microphoneWords } from '@/lib/transcription/turns'
import type { Word } from '@/lib/transcription/types'
import { levelByte, rmsOfByte, VOLUME_STEP, VolumeEnvelope, volumesOf } from '@/lib/recording/volume'

/** 20 s of two channels: the microphone speaks in 2-6 s and 14-16 s, the computer in 8-12 s and 14-16 s (both), quiet noise elsewhere. */
function meeting(): { microphone: Float32Array; computer: Float32Array } {
  const length = 20 * SAMPLE_RATE
  const microphone = new Float32Array(length)
  const computer = new Float32Array(length)
  let seed = 3
  const noise = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648 - 0.5) * 0.002
  for (let i = 0; i < length; i++) {
    const t = i / SAMPLE_RATE
    microphone[i] = noise() + ((t >= 2 && t < 6) || (t >= 14 && t < 16) ? 0.3 * Math.sin(i / 7) : 0)
    computer[i] = noise() + ((t >= 8 && t < 12) || (t >= 14 && t < 16) ? (t >= 14 ? 0.05 : 0.25) * Math.sin(i / 5) : 0)
  }
  return { microphone, computer }
}

/** The envelope as the recording makes it: the RMS of each channel every 50 ms. */
function envelopeOf(channels: { microphone: Float32Array; computer: Float32Array }) {
  const envelope = new VolumeEnvelope()
  const size = VOLUME_STEP * SAMPLE_RATE
  for (let start = 0; start + size <= channels.microphone.length; start += size) {
    const rms = (samples: Float32Array) => Math.sqrt(samples.subarray(start, start + size).reduce((sum, value) => sum + value * value, 0) / size)
    envelope.push(rms(channels.microphone), rms(channels.computer))
  }
  return envelope.result()
}

const words: Word[] = [
  { start: 2.5, end: 3, text: 'microfone' },
  { start: 5, end: 5.5, text: 'ainda' },
  { start: 9, end: 9.4, text: 'computador' },
  { start: 11, end: 11.6, text: 'outro' },
  { start: 14.5, end: 15, text: 'juntos' },
  { start: 18, end: 18.5, text: 'silêncio' },
]

describe('o volume de cada canal, guardado na gravação (T202)', () => {
  it('um byte por janela, na escala de decibéis: volta ao mesmo volume com menos de 0,4 dB de diferença', () => {
    for (const rms of [1, 0.3, 0.05, 0.01, 0.001, 0.0001]) {
      const back = rmsOfByte(levelByte(rms))
      expect(Math.abs(20 * Math.log10(back / rms))).toBeLessThan(0.4)
    }
    expect(levelByte(0)).toBe(0)
    expect(levelByte(2)).toBe(255)
  })

  it('a parte guardada: o passo e um byte por janela de cada canal, em base64', () => {
    const envelope = new VolumeEnvelope()
    envelope.push(1, 0)
    envelope.push(0.001, 0.5)
    const part = envelope.result()
    expect(part.step).toBe(0.05)
    expect(atob(part.microphone).length).toBe(2)
    expect(atob(part.computer).length).toBe(2)
    expect(envelope.count).toBe(2)
  })

  it('o microfone e o computador decidem igual pelo volume e pelo áudio decodificado', () => {
    const channels = meeting()
    const volumes = volumesOf(envelopeOf(channels))
    const byAudio = { microphone: microphoneWords(channels), computer: computerWords(channels) }
    const byVolume = { microphone: microphoneWords(volumes), computer: computerWords(volumes) }
    expect(words.map(byVolume.microphone)).toEqual(words.map(byAudio.microphone))
    expect(words.map(byVolume.computer)).toEqual(words.map(byAudio.computer))
    // and they say what the recording had
    expect(words.map(byVolume.microphone)).toEqual([true, true, false, false, true, false])
    expect(words.map(byVolume.computer)).toEqual([false, false, true, true, false, false])
  })

  it('sem som do computador em nenhum momento, nenhuma palavra é dada ao microfone por exclusão (como pelo áudio)', () => {
    const channels = meeting()
    channels.computer.fill(0)
    const volumes = volumesOf(envelopeOf(channels))
    expect(words.map(microphoneWords(volumes))).toEqual(words.map(microphoneWords(channels)))
    expect(words.map(computerWords(volumes))).toEqual(words.map(computerWords(channels)))
  })
})
