import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRef } from 'react'
import { fireEvent, render, screen } from '@testing-library/react'

import { MediaPlayer, type MeetingMedia } from '@/components/reader/MediaPlayer'

// Streaming (pedido do dono: "Sim, um streaming"): a mídia guardada no App (ou no Drive, pelo worker do app) toca do endereço dela, e o
// navegador pede as partes com a sessão; o player diz o que falta baixar e, quando não toca, o motivo de verdade.

const MB = 1024 * 1024
const streamed: MeetingMedia = { url: 'https://api.study.test/v1/media/n1/m1', available: true, video: true, streamed: true, size: 40 * MB, request: async () => undefined }

function renderPlayer(media: MeetingMedia): HTMLMediaElement {
  render(<MediaPlayer player={createRef<HTMLMediaElement>()} media={media} onTime={() => undefined} onPlayFrom={() => undefined} />)
  return document.querySelector('video, audio')!
}

function set(element: HTMLMediaElement, fields: Record<string, unknown>) {
  for (const [name, value] of Object.entries(fields)) Object.defineProperty(element, name, { configurable: true, value })
}

beforeEach(() => {
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(async () => undefined)
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => undefined)
  vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => undefined)
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('a mídia tocada aos pedaços do endereço da conta', () => {
  it('vai com a sessão (crossorigin="use-credentials", antes do src) e só lê o começo até tocar', () => {
    const video = renderPlayer(streamed)
    expect(video).toHaveAttribute('crossorigin', 'use-credentials')
    expect(video).toHaveAttribute('src', streamed.url)
    expect(video).toHaveAttribute('preload', 'metadata')
    const names = video.getAttributeNames()
    expect(names.indexOf('crossorigin')).toBeLessThan(names.indexOf('src'))
  })

  it('a barra diz quanto já baixou', () => {
    const video = renderPlayer(streamed)
    set(video, { duration: 100, buffered: { length: 1, start: () => 0, end: () => 10 } })
    fireEvent.durationChange(video)
    fireEvent.progress(video)
    expect(screen.getByRole('slider', { name: 'Posição na gravação' })).toHaveAttribute('title', 'Baixado 10% · 4,0 de 40,0 MB')
  })
})

describe('quando a mídia aos pedaços não toca', () => {
  function failWith(status: number) {
    const fetch = vi.fn(async () => new Response(null, { status }))
    vi.stubGlobal('fetch', fetch)
    const video = renderPlayer(streamed)
    set(video, { error: { code: 4 } })
    fireEvent.error(video)
    return fetch
  }

  it('a sessão que acabou pede para entrar de novo (e não culpa o formato)', async () => {
    const fetch = failWith(401)
    expect(await screen.findByText('Não deu para abrir a mídia: entre de novo na conta.')).toBeInTheDocument()
    expect(fetch).toHaveBeenCalledWith(streamed.url, { headers: { Range: 'bytes=0-0' }, credentials: 'include' })
  })

  it('a mídia apagada diz que foi apagada; a que não terminou de subir diz isso', async () => {
    failWith(410)
    expect(await screen.findByText('A mídia foi apagada.')).toBeInTheDocument()
    document.body.innerHTML = ''
    failWith(404)
    expect(await screen.findByText('A mídia não terminou de subir ou não existe.')).toBeInTheDocument()
  })
})
