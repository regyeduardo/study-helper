import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'

import { MeetingTabs } from '@/components/reader/MeetingTabs'
import type { MeetingMedia } from '@/components/reader/MediaPlayer'
import type { RecordingData } from '@/types/domain'

const recording: RecordingData = {
  blocks: [
    { speaker: 'mic', start: 0, end: 4.2, text: 'Quanto custou isso?' },
    { speaker: 'speaker_0', start: 72.5, end: 80, text: 'Custou dois mil.' },
    { speaker: 'mic', start: 3725, end: 3730, text: 'Fechado.' },
  ],
  speakers: [
    { id: 'mic', name: 'Você', suggested: false },
    { id: 'speaker_0', name: 'Falante 2', suggested: false },
  ],
  marks: [],
}

const ready: MeetingMedia = {
  url: 'blob:reuniao',
  available: true,
  video: false,
  request: async () => undefined,
}
const play = vi.fn(async () => undefined)
const pause = vi.fn()

function current(): (string | null)[] {
  return screen.getAllByRole('listitem').map(block => block.getAttribute('aria-current'))
}

beforeEach(() => {
  play.mockClear()
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(play)
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(pause)
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('playing a speech', () => {
  it('a click on the second speech puts the player at its start and plays', () => {
    render(<MeetingTabs recording={recording} media={ready} />)
    const audio = document.querySelector('audio')!
    expect(audio).toHaveAttribute('src', 'blob:reuniao')
    fireEvent.click(screen.getByText('Custou dois mil.'))
    expect(audio.currentTime).toBe(72.5)
    expect(play).toHaveBeenCalledTimes(1)
  })

  it('the speech being played stays highlighted, and the highlight follows the audio', () => {
    render(<MeetingTabs recording={recording} media={ready} />)
    const audio = document.querySelector('audio')!
    expect(current()).toEqual([null, null, null])
    fireEvent.click(screen.getByText('Custou dois mil.'))
    fireEvent.timeUpdate(audio)
    expect(current()).toEqual([null, 'true', null])
    audio.currentTime = 3726
    fireEvent.timeUpdate(audio)
    expect(current()).toEqual([null, null, 'true'])
  })

  it('the time of each speech is a button that plays from there', () => {
    render(<MeetingTabs recording={recording} media={ready} />)
    fireEvent.click(screen.getByRole('button', { name: 'Tocar a partir de 1:02:05' }))
    expect(document.querySelector('audio')!.currentTime).toBe(3725)
    expect(play).toHaveBeenCalledTimes(1)
  })

  it('the bar below shows where the audio is and pauses it', () => {
    render(<MeetingTabs recording={recording} media={ready} />)
    const audio = document.querySelector('audio')!
    Object.defineProperty(audio, 'duration', {
      configurable: true,
      value: 3730,
    })
    fireEvent.durationChange(audio)
    fireEvent.click(screen.getByText('Custou dois mil.'))
    fireEvent.play(audio)
    fireEvent.timeUpdate(audio)
    const bar = screen.getByRole('region', { name: 'Player da gravação' })
    expect(bar).toHaveTextContent('01:12')
    expect(bar).toHaveTextContent('1:02:10')
    fireEvent.click(screen.getByRole('button', { name: 'Pausar' }))
    expect(pause).toHaveBeenCalledTimes(1)
    fireEvent.change(screen.getByRole('slider', { name: 'Posição na gravação' }), { target: { value: '10' } })
    expect(audio.currentTime).toBe(10)
  })

  it('media kept elsewhere is fetched on the first click and then plays from the speech', async () => {
    const request = vi.fn(async () => undefined)
    const { rerender } = render(<MeetingTabs recording={recording} media={{ url: null, available: true, video: false, request }} />)
    fireEvent.click(screen.getByText('Custou dois mil.'))
    expect(request).toHaveBeenCalledTimes(1)
    rerender(<MeetingTabs recording={recording} media={{ url: 'blob:baixada', available: true, video: false, request }} />)
    await waitFor(() => expect(play).toHaveBeenCalledTimes(1))
    expect(document.querySelector('audio')!.currentTime).toBe(72.5)
  })

  it('a note without media shows the transcription with no player', () => {
    render(<MeetingTabs recording={recording} media={{ url: null, available: false, video: false, request: async () => undefined }} />)
    expect(screen.queryByRole('region', { name: 'Player da gravação' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Tocar a partir de/ })).not.toBeInTheDocument()
    expect(screen.getAllByRole('listitem')).toHaveLength(3)
  })
})

function fakeAudioContext() {
  const wires: string[] = []
  const node = (name: string) => ({ connect: (target: { name: string }, output = 0, input = 0) => void wires.push(`${name}:${output}->${target.name}:${input}`), name })
  const made: string[] = []
  class FakeContext {
    destination = { name: 'ouvidos' }
    state = 'suspended'
    constructor() {
      made.push('context')
    }
    createMediaElementSource = () => node('gravacao')
    createChannelSplitter = () => node('lados')
    createChannelMerger = () => node('fones')
    resume = async () => undefined
  }
  vi.stubGlobal('AudioContext', FakeContext)
  return { wires, made }
}

describe('both sides in both ears', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('plays the left side (you) and the right side (the computer) together in both ears', () => {
    const { wires } = fakeAudioContext()
    render(<MeetingTabs recording={recording} media={ready} />)
    fireEvent.play(document.querySelector('audio')!)
    expect(wires.sort()).toEqual(['fones:0->ouvidos:0', 'gravacao:0->lados:0', 'lados:0->fones:0', 'lados:0->fones:1', 'lados:1->fones:0', 'lados:1->fones:1'])
  })

  it('wires the player only once, even after pausing and playing again', () => {
    const { made } = fakeAudioContext()
    render(<MeetingTabs recording={recording} media={ready} />)
    const audio = document.querySelector('audio')!
    fireEvent.play(audio)
    fireEvent.pause(audio)
    fireEvent.play(audio)
    expect(made).toEqual(['context'])
  })

  it('leaves media from another site as it is, so it does not go silent', () => {
    const { made } = fakeAudioContext()
    render(<MeetingTabs recording={recording} media={{ ...ready, url: 'https://drive.example/reuniao.webm' }} />)
    fireEvent.play(document.querySelector('audio')!)
    expect(made).toEqual([])
  })
})

