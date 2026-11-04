import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRef } from 'react'
import { fireEvent, render, screen } from '@testing-library/react'

import { MediaPlayer, type MeetingMedia, SHARED_MEDIA_EXPIRED } from '@/components/reader/MediaPlayer'

const MB = 1024 * 1024
const remote: MeetingMedia = { url: 'https://share.test/media/Reuniao1234567890/f1', available: true, video: true, remote: true, size: 20 * MB, request: async () => undefined }
const local: MeetingMedia = { url: 'blob:reuniao', available: true, video: false, request: async () => undefined }
const load = vi.fn()

function renderPlayer(media: MeetingMedia): HTMLMediaElement {
  render(<MediaPlayer player={createRef<HTMLMediaElement>()} media={media} onTime={() => undefined} onPlayFrom={() => undefined} />)
  return document.querySelector('video, audio')!
}

function set(element: HTMLMediaElement, fields: Record<string, unknown>) {
  for (const [name, value] of Object.entries(fields)) Object.defineProperty(element, name, { configurable: true, value })
}

function loaded(...ranges: [number, number][]) {
  return { length: ranges.length, start: (index: number) => ranges[index][0], end: (index: number) => ranges[index][1] }
}

beforeEach(() => {
  load.mockClear()
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(async () => undefined)
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => undefined)
  vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(load)
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('downloading the media', () => {
  it('a shared media downloads ahead; a media on this device only reads its start', () => {
    expect(renderPlayer(remote)).toHaveAttribute('preload', 'auto')
    document.body.innerHTML = ''
    expect(renderPlayer(local)).toHaveAttribute('preload', 'metadata')
  })
})

describe('what is loading', () => {
  it('says "Carregando a mídia…" until it can play, and "Carregando…" while it waits after a play or a jump', () => {
    const video = renderPlayer(remote)
    expect(screen.getByRole('status')).toHaveTextContent('Carregando a mídia…')
    fireEvent.canPlay(video)
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
    fireEvent.waiting(video)
    expect(screen.getByRole('status')).toHaveTextContent('Carregando…')
    fireEvent.playing(video)
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
    fireEvent.seeking(video)
    expect(screen.getByRole('status')).toHaveTextContent('Carregando…')
    fireEvent.seeked(video)
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
  })

  it('a media on this device that stops after its start is not left "loading"', () => {
    const audio = renderPlayer(local)
    set(audio, { readyState: 1 })
    fireEvent.suspend(audio)
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
  })

  it('the bar paints the stretches already downloaded, and its title says how much', () => {
    const video = renderPlayer(remote)
    set(video, { duration: 100, buffered: loaded([0, 25], [50, 60]) })
    fireEvent.durationChange(video)
    fireEvent.progress(video)
    const bar = screen.getByRole('slider', { name: 'Posição na gravação' })
    expect(bar.style.getPropertyValue('--loaded')).toContain('0% 25%')
    expect(bar.style.getPropertyValue('--loaded')).toContain('50% 60%')
    expect(bar).toHaveAttribute('title', 'Baixado 35% · 7,0 de 20,0 MB')
  })
})

describe('when the media does not play', () => {
  function failWith(status: number) {
    const fetch = vi.fn(async () => new Response(null, { status }))
    vi.stubGlobal('fetch', fetch)
    const video = renderPlayer(remote)
    set(video, { error: { code: 4 } })
    fireEvent.error(video)
    return { video, fetch }
  }

  it('a media that did not finish uploading says so, and "Tentar de novo" loads it again', async () => {
    const { fetch } = failWith(404)
    expect(await screen.findByText('A mídia não terminou de subir ou não existe.')).toBeInTheDocument()
    expect(fetch).toHaveBeenCalledWith(remote.url, { headers: { Range: 'bytes=0-0' } })
    fireEvent.click(screen.getByRole('button', { name: 'Tentar de novo' }))
    expect(load).toHaveBeenCalledTimes(1)
    expect(screen.queryByText('A mídia não terminou de subir ou não existe.')).not.toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveTextContent('Carregando a mídia…')
  })

  it('an expired media says it expired', async () => {
    failWith(410)
    expect(await screen.findByText(SHARED_MEDIA_EXPIRED)).toBeInTheDocument()
  })

  it('a media that downloads but does not play says the format is the problem', async () => {
    failWith(206)
    expect(await screen.findByText('Este navegador não toca o formato desta mídia.')).toBeInTheDocument()
  })

  it('a network failure is tried again 3 times before the message', async () => {
    vi.useFakeTimers()
    const audio = renderPlayer(local)
    set(audio, { error: { code: 2 } })
    for (let round = 1; round <= 3; round++) {
      fireEvent.error(audio)
      expect(screen.queryByRole('button', { name: 'Tentar de novo' })).not.toBeInTheDocument()
      vi.runOnlyPendingTimers()
      expect(load).toHaveBeenCalledTimes(round)
    }
    fireEvent.error(audio)
    vi.useRealTimers()
    expect(await screen.findByText('A mídia parou de baixar. Confira a internet.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Tentar de novo' })).toBeInTheDocument()
  })
})
