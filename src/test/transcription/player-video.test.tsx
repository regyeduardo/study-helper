import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, renderHook, screen } from '@testing-library/react'

import { MeetingTabs } from '@/components/reader/MeetingTabs'
import { type MeetingMedia, useMeetingMedia } from '@/components/reader/MediaPlayer'
import { defaultIndex } from '@/lib/defaults'
import { useLibraryStore } from '@/stores/library'
import type { FileMeta, RecordingData } from '@/types/domain'

const recording: RecordingData = {
  blocks: [
    { speaker: 'mic', start: 0, end: 4, text: 'Abre o slide.' },
    { speaker: 'speaker_0', start: 190, end: 200, text: 'Olha esse gráfico aqui.' },
  ],
  speakers: [
    { id: 'mic', name: 'Você', suggested: false },
    { id: 'speaker_0', name: 'Marina', suggested: false },
  ],
  marks: [],
}

const media = (video: boolean): MeetingMedia => ({ url: 'blob:reuniao', available: true, video, request: async () => undefined })

beforeEach(() => {
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(async () => undefined)
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => undefined)
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('the screen in the player', () => {
  it('with video, the thin bar shows a thumbnail of the screen at the speech being played', () => {
    render(<MeetingTabs recording={recording} media={media(true)} />)
    const thumbnail = screen.getByRole('button', { name: 'Ampliar a tela' })
    const video = thumbnail.querySelector('video')!
    expect(video).toHaveAttribute('src', 'blob:reuniao')
    fireEvent.click(screen.getByText('Olha esse gráfico aqui.'))
    expect(video.currentTime).toBe(190)
    expect(document.querySelector('audio')).toBeNull()
  })

  it('a click on the thumbnail enlarges the screen, and another click makes it small again', () => {
    render(<MeetingTabs recording={recording} media={media(true)} />)
    fireEvent.click(screen.getByRole('button', { name: 'Ampliar a tela' }))
    expect(screen.getByRole('button', { name: 'Diminuir a tela' })).toHaveAttribute('aria-expanded', 'true')
    fireEvent.click(screen.getByRole('button', { name: 'Diminuir a tela' }))
    expect(screen.getByRole('button', { name: 'Ampliar a tela' })).toHaveAttribute('aria-expanded', 'false')
  })

  it('without video, there is only the bar with the sound', () => {
    render(<MeetingTabs recording={recording} media={media(false)} />)
    expect(screen.queryByRole('button', { name: 'Ampliar a tela' })).toBeNull()
    expect(document.querySelector('video')).toBeNull()
    expect(document.querySelector('audio')).toHaveAttribute('src', 'blob:reuniao')
  })
})

describe('which media has video', () => {
  const meta = { id: 'n1', origin: { input: 'file', name: 'aula.mp4', mime: 'video/mp4', storage: 'none' } } as unknown as FileMeta

  function withLocal(mime: string) {
    useLibraryStore.setState({ index: defaultIndex(), repo: null, localMedia: [{ storedName: 'envio-1', name: 'aula.mp4', mime, durationSeconds: 10, size: 8, createdAt: '', fileIds: ['n1'] }] })
  }

  it('a video sent by "Novo conteúdo" and kept in Mídias plays as video', () => {
    withLocal('video/mp4')
    expect(renderHook(() => useMeetingMedia(meta)).result.current.video).toBe(true)
  })

  it('a screen recording kept in Mídias plays as video', () => {
    withLocal('video/webm;codecs=vp9,opus')
    expect(renderHook(() => useMeetingMedia(meta)).result.current.video).toBe(true)
  })

  it('a sound recording plays as sound', () => {
    withLocal('audio/webm;codecs=opus')
    expect(renderHook(() => useMeetingMedia({ ...meta, origin: { ...meta.origin!, mime: 'audio/webm' } })).result.current.video).toBe(false)
  })
})
