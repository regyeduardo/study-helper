import '@/test/account/storage-shim'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRef } from 'react'
import { act, fireEvent, render, screen, within } from '@testing-library/react'

import { MediaPlayer, type MeetingMedia } from '@/components/reader/MediaPlayer'

const video: MeetingMedia = { url: 'blob:aula', available: true, video: true, request: async () => undefined }
const audio: MeetingMedia = { url: 'blob:aula', available: true, video: false, request: async () => undefined }

const play = vi.fn(async () => undefined)
const pause = vi.fn()
const onPlayFrom = vi.fn()
const onTime = vi.fn()

function renderPlayer(media: MeetingMedia, extra?: React.ReactNode) {
  const ref = createRef<HTMLMediaElement>()
  const view = render(
    <>
      <MediaPlayer player={ref} media={media} onTime={onTime} onPlayFrom={onPlayFrom} />
      {extra}
    </>,
  )
  const element = document.querySelector('video, audio') as HTMLMediaElement
  Object.defineProperty(element, 'duration', { configurable: true, value: 100 })
  fireEvent.durationChange(element)
  return { ...view, element, region: screen.getByRole('region', { name: 'Player da gravação' }) }
}

const box = () => document.querySelector('.mplayer-box') as HTMLElement
const button = (name: string) => screen.getByRole('button', { name })
const maybeButton = (name: string) => screen.queryByRole('button', { name })
const seek = () => screen.getByRole('slider', { name: 'Posição na gravação' })
const speed = () => screen.getByRole('combobox', { name: 'Velocidade' }) as HTMLSelectElement
const volume = () => screen.getByRole('slider', { name: 'Volume' }) as HTMLInputElement

let fullscreenOf: Element | null = null
const requestFullscreen = vi.fn(async function (this: HTMLElement) {
  return undefined
})
const exitFullscreen = vi.fn(async () => undefined)

function fullscreenChange(element: Element | null) {
  fullscreenOf = element
  fireEvent(document, new Event('fullscreenchange'))
}

beforeEach(() => {
  localStorage.clear()
  fullscreenOf = null
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(play)
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(pause)
  Object.defineProperty(HTMLElement.prototype, 'requestFullscreen', { configurable: true, writable: true, value: requestFullscreen })
  Object.defineProperty(document, 'exitFullscreen', { configurable: true, writable: true, value: exitFullscreen })
  Object.defineProperty(document, 'fullscreenElement', { configurable: true, get: () => fullscreenOf })
})

afterEach(() => {
  vi.restoreAllMocks()
  for (const mock of [play, pause, onPlayFrom, onTime, requestFullscreen, exitFullscreen]) mock.mockClear()
  Reflect.deleteProperty(HTMLElement.prototype, 'requestFullscreen')
  Reflect.deleteProperty(document, 'exitFullscreen')
  Reflect.deleteProperty(document, 'fullscreenElement')
})

describe('the bar has the controls people expect', () => {
  it('a video has play, back and forward 10 seconds, the time, the bar, speed, sound and the screen size', () => {
    renderPlayer(video)
    for (const name of ['Tocar', 'Voltar 10 segundos', 'Avançar 10 segundos', 'Tirar o som', 'Ampliar a tela']) expect(button(name)).toBeInTheDocument()
    expect(seek()).toBeInTheDocument()
    expect(volume()).toBeInTheDocument()
    expect(speed()).toHaveDisplayValue('1×')
    expect([...speed().options].map(option => option.textContent)).toEqual(['0,75×', '1×', '1,25×', '1,5×', '1,75×', '2×'])
    expect(maybeButton('Tela cheia')).toBeNull()
  })

  it('a sound recording has the same controls, without any screen size', () => {
    renderPlayer(audio)
    for (const name of ['Tocar', 'Voltar 10 segundos', 'Avançar 10 segundos', 'Tirar o som']) expect(button(name)).toBeInTheDocument()
    expect(speed()).toBeInTheDocument()
    expect(volume()).toBeInTheDocument()
    expect(maybeButton('Ampliar a tela')).toBeNull()
    expect(maybeButton('Tela cheia')).toBeNull()
    expect(document.querySelector('video')).toBeNull()
  })

  it('goes back and forward 10 seconds, and stops at the start and at the end', () => {
    const { element } = renderPlayer(video)
    element.currentTime = 50
    fireEvent.click(button('Avançar 10 segundos'))
    expect(element.currentTime).toBe(60)
    fireEvent.click(button('Voltar 10 segundos'))
    fireEvent.click(button('Voltar 10 segundos'))
    expect(element.currentTime).toBe(40)
    element.currentTime = 4
    fireEvent.click(button('Voltar 10 segundos'))
    expect(element.currentTime).toBe(0)
    element.currentTime = 95
    fireEvent.click(button('Avançar 10 segundos'))
    expect(element.currentTime).toBe(100)
    expect(onTime).toHaveBeenLastCalledWith(100)
  })

  it('does not jump while the length is not known yet', () => {
    render(<MediaPlayer player={createRef<HTMLMediaElement>()} media={audio} onTime={onTime} onPlayFrom={onPlayFrom} />)
    expect(button('Avançar 10 segundos')).toBeDisabled()
    expect(button('Voltar 10 segundos')).toBeDisabled()
  })

  it('shows the time, the length and keeps the name of the position bar', () => {
    const { element, region } = renderPlayer(video)
    element.currentTime = 75
    fireEvent.timeUpdate(element)
    expect(region).toHaveTextContent('01:15')
    expect(region).toHaveTextContent('01:40')
    expect(seek()).toHaveValue('75')
  })
})

describe('speed', () => {
  it('changes how fast it plays and the bar shows the current one', () => {
    const { element } = renderPlayer(video)
    fireEvent.change(speed(), { target: { value: '1.5' } })
    expect(element.playbackRate).toBe(1.5)
    expect(speed()).toHaveDisplayValue('1,5×')
    fireEvent.change(speed(), { target: { value: '0.75' } })
    expect(element.playbackRate).toBe(0.75)
    expect(speed()).toHaveDisplayValue('0,75×')
  })

  it('is remembered by the browser for the next recording', () => {
    const first = renderPlayer(video)
    fireEvent.change(speed(), { target: { value: '2' } })
    first.unmount()
    const second = renderPlayer(audio)
    expect(speed()).toHaveDisplayValue('2×')
    expect(second.element.playbackRate).toBe(2)
  })

  it('ignores a saved speed that is not in the list', () => {
    localStorage.setItem('study-helper:player', JSON.stringify({ speed: 9 }))
    const { element } = renderPlayer(video)
    expect(speed()).toHaveDisplayValue('1×')
    expect(element.playbackRate).toBe(1)
  })
})

describe('sound', () => {
  it('"Tirar o som" mutes and becomes "Voltar o som"', () => {
    const { element } = renderPlayer(video)
    fireEvent.click(button('Tirar o som'))
    expect(element.muted).toBe(true)
    fireEvent.click(button('Voltar o som'))
    expect(element.muted).toBe(false)
    expect(maybeButton('Tirar o som')).toBeInTheDocument()
  })

  it('the volume slider sets the volume, and the bar shows it', () => {
    const { element } = renderPlayer(video)
    expect(volume()).toHaveValue('100')
    fireEvent.change(volume(), { target: { value: '40' } })
    expect(element.volume).toBeCloseTo(0.4)
    expect(volume()).toHaveValue('40')
  })

  it('raising the volume while muted brings the sound back, and an empty slider reads as muted', () => {
    const { element } = renderPlayer(video)
    fireEvent.click(button('Tirar o som'))
    fireEvent.change(volume(), { target: { value: '60' } })
    expect(element.muted).toBe(false)
    expect(element.volume).toBeCloseTo(0.6)
    fireEvent.change(volume(), { target: { value: '0' } })
    expect(maybeButton('Voltar o som')).toBeInTheDocument()
    fireEvent.click(button('Voltar o som'))
    expect(element.muted).toBe(false)
    expect(element.volume).toBeGreaterThan(0)
  })

  it('volume and mute are remembered by the browser', () => {
    const first = renderPlayer(video)
    fireEvent.change(volume(), { target: { value: '30' } })
    fireEvent.click(button('Tirar o som'))
    first.unmount()
    const second = renderPlayer(video)
    expect(second.element.volume).toBeCloseTo(0.3)
    expect(second.element.muted).toBe(true)
    expect(maybeButton('Voltar o som')).toBeInTheDocument()
  })

  it('works when the browser refuses to keep anything', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked')
    })
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked')
    })
    const { element } = renderPlayer(video)
    fireEvent.change(speed(), { target: { value: '1.25' } })
    fireEvent.click(button('Tirar o som'))
    expect(element.playbackRate).toBe(1.25)
    expect(element.muted).toBe(true)
  })
})

describe('the expanded screen', () => {
  it('puts the whole player over a dimmed backdrop, with every control right under the video', () => {
    const { region, element } = renderPlayer(video)
    fireEvent.click(button('Ampliar a tela'))
    expect(button('Diminuir a tela')).toHaveAttribute('aria-expanded', 'true')
    expect(box()).toHaveAttribute('data-big', 'true')
    expect(region.querySelector('.mplayer-backdrop')).not.toBeNull()
    const inside = within(box())
    for (const name of ['Tocar', 'Voltar 10 segundos', 'Avançar 10 segundos', 'Tirar o som', 'Diminuir a tela', 'Tela cheia']) expect(inside.getByRole('button', { name })).toBeInTheDocument()
    expect(inside.getByRole('slider', { name: 'Posição na gravação' })).toBeInTheDocument()
    expect(inside.getByRole('slider', { name: 'Volume' })).toBeInTheDocument()
    expect(inside.getByRole('combobox', { name: 'Velocidade' })).toBeInTheDocument()
    expect(box()).toContainElement(element)
  })

  it('tells assistive technology it is a window while open, and the bar says the time in words', () => {
    const { element } = renderPlayer(video)
    element.currentTime = 75
    fireEvent.timeUpdate(element)
    expect(seek()).toHaveAttribute('aria-valuetext', '01:15 de 01:40')
    expect(screen.queryByRole('dialog')).toBeNull()
    fireEvent.click(button('Ampliar a tela'))
    const dialog = screen.getByRole('dialog', { name: 'Player da gravação ampliado' })
    expect(dialog).toHaveAttribute('aria-modal', 'true')
    expect(dialog).toBe(box())
    fireEvent.click(button('Diminuir a tela'))
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('a click on the backdrop, Esc or "Diminuir a tela" go back to the thin bar', () => {
    const { region } = renderPlayer(video)
    fireEvent.click(button('Ampliar a tela'))
    fireEvent.click(region.querySelector('.mplayer-backdrop')!)
    expect(button('Ampliar a tela')).toHaveAttribute('aria-expanded', 'false')
    expect(box()).not.toHaveAttribute('data-big', 'true')
    fireEvent.click(button('Ampliar a tela'))
    fireEvent.keyDown(document.body, { key: 'Escape' })
    expect(button('Ampliar a tela')).toBeInTheDocument()
    fireEvent.click(button('Ampliar a tela'))
    fireEvent.click(button('Diminuir a tela'))
    expect(button('Ampliar a tela')).toBeInTheDocument()
    expect(region.querySelector('.mplayer-backdrop')).toBeNull()
  })

  it('the very same video element goes through expanding and shrinking: no remount, playback and time go on', () => {
    const { element, container } = renderPlayer(video)
    element.currentTime = 42
    fireEvent.play(element)
    const watcher = new MutationObserver(() => undefined)
    watcher.observe(container, { childList: true, subtree: true })
    fireEvent.click(button('Ampliar a tela'))
    expect(document.querySelector('video')).toBe(element)
    expect(element.isConnected).toBe(true)
    expect(element.currentTime).toBe(42)
    expect(button('Pausar')).toBeInTheDocument()
    fireEvent.click(button('Diminuir a tela'))
    expect(document.querySelector('video')).toBe(element)
    expect(element.currentTime).toBe(42)
    expect(element).toHaveAttribute('src', 'blob:aula')
    const moved = watcher.takeRecords().filter(record => [...record.removedNodes, ...record.addedNodes].some(node => node === element || node.contains(element)))
    watcher.disconnect()
    expect(moved).toEqual([])
    expect(pause).not.toHaveBeenCalled()
    expect(play).not.toHaveBeenCalled()
  })

  it('a click on the expanded video plays and pauses, and a double click goes to full screen', () => {
    const { element } = renderPlayer(video)
    element.currentTime = 12
    fireEvent.timeUpdate(element)
    fireEvent.click(element)
    expect(onPlayFrom).not.toHaveBeenCalled()
    fireEvent.click(button('Ampliar a tela'))
    fireEvent.click(element)
    expect(onPlayFrom).toHaveBeenCalledWith(12)
    fireEvent.play(element)
    fireEvent.click(element)
    expect(pause).toHaveBeenCalledTimes(1)
    fireEvent.doubleClick(element)
    expect(requestFullscreen.mock.contexts).toEqual([box()])
  })

  it('moves the focus into the screen when it opens and gives it back to the thumbnail when it closes', () => {
    renderPlayer(video)
    fireEvent.click(button('Ampliar a tela'))
    expect(button('Diminuir a tela')).toHaveFocus()
    fireEvent.click(button('Diminuir a tela'))
    expect(button('Ampliar a tela')).toHaveFocus()
  })

  it('keeps Tab inside the screen while it is open', () => {
    renderPlayer(video)
    fireEvent.click(button('Ampliar a tela'))
    const focusable = [...box().querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), select:not([disabled])')]
    focusable.at(-1)!.focus()
    fireEvent.keyDown(focusable.at(-1)!, { key: 'Tab' })
    expect(focusable[0]).toHaveFocus()
    fireEvent.keyDown(focusable[0], { key: 'Tab', shiftKey: true })
    expect(focusable.at(-1)).toHaveFocus()
  })

  it('a failed media can still be closed', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 206 })))
    const { element } = renderPlayer({ ...video, remote: true, url: 'https://share.test/media/x' })
    fireEvent.click(button('Ampliar a tela'))
    Object.defineProperty(element, 'error', { configurable: true, value: { code: 4 } })
    fireEvent.error(element)
    expect(await screen.findByText('Este navegador não toca o formato desta mídia.')).toBeInTheDocument()
    expect(button('Tentar de novo')).toBeInTheDocument()
    fireEvent.click(button('Diminuir a tela'))
    expect(button('Ampliar a tela')).toBeInTheDocument()
    vi.unstubAllGlobals()
  })
})

describe('full screen', () => {
  it('asks the browser for the whole player box, so the controls go along', () => {
    renderPlayer(video)
    fireEvent.click(button('Ampliar a tela'))
    fireEvent.click(button('Tela cheia'))
    expect(requestFullscreen.mock.contexts).toEqual([box()])
  })

  it('says "Sair da tela cheia" while on it, and leaves it with a click, with F, and with Esc going to Diminuir only after', () => {
    renderPlayer(video)
    fireEvent.click(button('Ampliar a tela'))
    fullscreenChange(box())
    fireEvent.click(button('Sair da tela cheia'))
    expect(exitFullscreen).toHaveBeenCalledTimes(1)
    fireEvent.keyDown(document.body, { key: 'f' })
    expect(exitFullscreen).toHaveBeenCalledTimes(2)
    fireEvent.keyDown(document.body, { key: 'Escape' })
    expect(exitFullscreen).toHaveBeenCalledTimes(3)
    expect(button('Diminuir a tela')).toBeInTheDocument()
    fullscreenChange(null)
    expect(button('Tela cheia')).toBeInTheDocument()
    fireEvent.keyDown(document.body, { key: 'Escape' })
    expect(button('Ampliar a tela')).toBeInTheDocument()
  })

  it('shrinking while in full screen leaves the full screen too', () => {
    renderPlayer(video)
    fireEvent.click(button('Ampliar a tela'))
    fullscreenChange(box())
    fireEvent.click(button('Diminuir a tela'))
    expect(exitFullscreen).toHaveBeenCalledTimes(1)
  })
})

describe('keyboard', () => {
  it('with the focus inside the player: Space and K play and pause, arrows and J/L jump, M mutes', () => {
    const { element, region } = renderPlayer(audio)
    element.currentTime = 50
    fireEvent.timeUpdate(element)
    fireEvent.keyDown(region, { key: ' ' })
    expect(onPlayFrom).toHaveBeenCalledTimes(1)
    fireEvent.keyDown(button('Avançar 10 segundos'), { key: 'k' })
    expect(onPlayFrom).toHaveBeenCalledTimes(2)
    fireEvent.play(element)
    fireEvent.keyDown(region, { key: 'k' })
    expect(pause).toHaveBeenCalledTimes(1)
    fireEvent.keyDown(region, { key: 'ArrowRight' })
    expect(element.currentTime).toBe(55)
    fireEvent.keyDown(region, { key: 'ArrowLeft' })
    fireEvent.keyDown(region, { key: 'ArrowLeft' })
    expect(element.currentTime).toBe(45)
    fireEvent.keyDown(region, { key: 'l' })
    expect(element.currentTime).toBe(55)
    fireEvent.keyDown(region, { key: 'J' })
    expect(element.currentTime).toBe(45)
    fireEvent.keyDown(region, { key: 'm' })
    expect(element.muted).toBe(true)
    fireEvent.keyDown(region, { key: 'm' })
    expect(element.muted).toBe(false)
  })

  it('Space on a focused button is left to the button, so it does not toggle twice', () => {
    const { region } = renderPlayer(audio)
    fireEvent.keyDown(within(region).getByRole('button', { name: 'Tirar o som' }), { key: ' ' })
    expect(onPlayFrom).not.toHaveBeenCalled()
  })

  it('on a slider the arrows are the slider own, and nothing else is stolen', () => {
    const { element } = renderPlayer(audio)
    element.currentTime = 50
    fireEvent.keyDown(seek(), { key: 'ArrowRight' })
    expect(element.currentTime).toBe(50)
    fireEvent.keyDown(seek(), { key: 'm' })
    expect(element.muted).toBe(true)
  })

  it('outside the player and with the thin bar, no key is taken', () => {
    const { element } = renderPlayer(video)
    fireEvent.keyDown(document.body, { key: ' ' })
    fireEvent.keyDown(document.body, { key: 'm' })
    fireEvent.keyDown(document.body, { key: 'ArrowRight' })
    fireEvent.keyDown(document.body, { key: 'Escape' })
    expect(onPlayFrom).not.toHaveBeenCalled()
    expect(element.muted).toBe(false)
    expect(element.currentTime).toBe(0)
  })

  it('expanded, the keys work even when the focus went to the page, with F going to full screen', () => {
    const { element } = renderPlayer(video)
    fireEvent.click(button('Ampliar a tela'))
    fireEvent.keyDown(document.body, { key: ' ' })
    expect(onPlayFrom).toHaveBeenCalledTimes(1)
    element.currentTime = 20
    fireEvent.keyDown(document.body, { key: 'ArrowRight' })
    expect(element.currentTime).toBe(25)
    fireEvent.keyDown(document.body, { key: 'f' })
    expect(requestFullscreen.mock.contexts).toEqual([box()])
  })

  it('F on the thin bar of a video opens the big screen in full screen', () => {
    const { region } = renderPlayer(video)
    fireEvent.keyDown(region, { key: 'f' })
    expect(button('Diminuir a tela')).toBeInTheDocument()
    expect(requestFullscreen.mock.contexts).toEqual([box()])
  })

  it('F on a sound recording does nothing', () => {
    const { region } = renderPlayer(audio)
    fireEvent.keyDown(region, { key: 'f' })
    expect(requestFullscreen).not.toHaveBeenCalled()
  })

  it('does not steal keys from a text field elsewhere, even with the screen open', () => {
    const { element } = renderPlayer(video, <textarea aria-label="Pergunta" />)
    fireEvent.click(button('Ampliar a tela'))
    const field = screen.getByLabelText('Pergunta')
    for (const key of [' ', 'k', 'm', 'f', 'j', 'l', 'ArrowLeft', 'ArrowRight']) fireEvent.keyDown(field, { key })
    expect(onPlayFrom).not.toHaveBeenCalled()
    expect(element.muted).toBe(false)
    expect(requestFullscreen).not.toHaveBeenCalled()
    expect(element.currentTime).toBe(0)
  })

  it('keys with Ctrl, Alt or Cmd belong to the browser', () => {
    const { element, region } = renderPlayer(audio)
    fireEvent.keyDown(region, { key: 'k', ctrlKey: true })
    fireEvent.keyDown(region, { key: 'm', metaKey: true })
    fireEvent.keyDown(region, { key: 'ArrowRight', altKey: true })
    expect(onPlayFrom).not.toHaveBeenCalled()
    expect(element.muted).toBe(false)
    expect(element.currentTime).toBe(0)
  })

  it('each key counts once, with the focus inside the open screen', () => {
    const { element } = renderPlayer(video)
    fireEvent.click(button('Ampliar a tela'))
    element.currentTime = 20
    fireEvent.keyDown(button('Voltar 10 segundos'), { key: 'ArrowRight' })
    expect(element.currentTime).toBe(25)
  })
})

describe('em tela cheia, os controles somem enquanto toca', () => {
  function playingInFullscreen() {
    const view = renderPlayer(video)
    fireEvent.click(button('Ampliar a tela'))
    fireEvent.play(view.element)
    fullscreenChange(box())
    return view
  }

  afterEach(() => {
    vi.useRealTimers()
  })

  it('3 segundos sem mexer o mouse: somem; mexer o mouse ou apertar uma tecla: voltam', () => {
    vi.useFakeTimers()
    playingInFullscreen()
    expect(box()).not.toHaveAttribute('data-idle')
    act(() => void vi.advanceTimersByTime(3000))
    expect(box()).toHaveAttribute('data-idle', 'true')
    fireEvent.mouseMove(box())
    expect(box()).not.toHaveAttribute('data-idle')
    act(() => void vi.advanceTimersByTime(3000))
    expect(box()).toHaveAttribute('data-idle', 'true')
    fireEvent.keyDown(box(), { key: 'ArrowLeft' })
    expect(box()).not.toHaveAttribute('data-idle')
  })

  it('pausado ou fora da tela cheia, os controles ficam sempre à vista', () => {
    vi.useFakeTimers()
    const { element } = playingInFullscreen()
    fireEvent.pause(element)
    act(() => void vi.advanceTimersByTime(5000))
    expect(box()).not.toHaveAttribute('data-idle')
    fireEvent.play(element)
    fullscreenChange(null)
    act(() => void vi.advanceTimersByTime(5000))
    expect(box()).not.toHaveAttribute('data-idle')
  })
})

describe('com o vídeo ampliado, a página de trás não rola', () => {
  const wheel = (target: Element) => {
    const event = new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: 120 })
    target.dispatchEvent(event)
    return event.defaultPrevented
  }

  it('a roda do mouse no fundo e no vídeo não rola nada, e a página fica travada até diminuir', () => {
    renderPlayer(video)
    fireEvent.click(button('Ampliar a tela'))
    expect(wheel(document.querySelector('.mplayer-backdrop')!)).toBe(true)
    expect(wheel(box())).toBe(true)
    expect(document.documentElement.style.overflow).toBe('hidden')
    fireEvent.click(button('Diminuir a tela'))
    expect(document.documentElement.style.overflow).toBe('')
    expect(wheel(box())).toBe(false)
  })
})
