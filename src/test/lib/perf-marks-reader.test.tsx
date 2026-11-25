import '@/test/account/storage-shim'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRef } from 'react'
import { act, fireEvent, render } from '@testing-library/react'

import { MediaPlayer, type MeetingMedia } from '@/components/reader/MediaPlayer'
import { ligarMedidas, medidas } from '@/lib/perf'

// Marcas de tocar a mídia e pular para um minuto (spec 007, T017): do "play" até tocar de verdade, e do pulo até a mídia estar no
// minuto novo. São as que o dono mais sente no celular, e o painel de medidas mostra.

const media: MeetingMedia = { url: 'blob:reuniao', available: true, video: false, request: async () => undefined }

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true })
  ligarMedidas(true)
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(async () => undefined)
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => undefined)
  vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => undefined)
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
  ligarMedidas(false)
})

it('mede do play até tocar, e do pulo até o minuto novo', async () => {
  render(<MediaPlayer player={createRef<HTMLMediaElement>()} media={media} onTime={() => undefined} onPlayFrom={() => undefined} />)
  const element = document.querySelector('audio')!
  fireEvent.play(element)
  await act(async () => {
    await vi.advanceTimersByTimeAsync(300)
  })
  fireEvent.playing(element)
  fireEvent.seeking(element)
  await act(async () => {
    await vi.advanceTimersByTimeAsync(150)
  })
  fireEvent.seeked(element)
  await act(async () => {
    await vi.advanceTimersByTimeAsync(50)
  })
  const ops = medidas()
  expect(ops.map(medida => medida.op)).toEqual(['tocar-midia', 'pular-minuto'])
  expect(ops[0].ms).toBeGreaterThanOrEqual(300)
  expect(ops[1].ms).toBeGreaterThanOrEqual(150)
})

describe('sem medir', () => {
  it('nada é gravado', async () => {
    ligarMedidas(false)
    render(<MediaPlayer player={createRef<HTMLMediaElement>()} media={media} onTime={() => undefined} onPlayFrom={() => undefined} />)
    const element = document.querySelector('audio')!
    fireEvent.play(element)
    fireEvent.playing(element)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(50)
    })
    expect(medidas()).toEqual([])
  })
})
