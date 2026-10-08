import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

const { startNewContent } = vi.hoisted(() => ({ startNewContent: vi.fn(async (..._args: unknown[]) => null) }))

vi.mock('@/stores/jobs', async () => {
  const { create } = await import('zustand')
  return { useJobsStore: create(() => ({ jobs: [], startNewContent })) }
})

import { RecordingDoneDialog } from '@/components/dialogs/RecordDialogs'
import { TranscriptTab } from '@/components/reader/TranscriptTab'
import { LOCAL_ACCOUNT, useAccountStore } from '@/stores/account'
import { useRecorderStore } from '@/stores/recorder'
import { installIntegration } from '@/test/recording/integration-fakes'
import { installMediaEnvironment } from '@/test/recording/media-fakes'
import type { RecordingData } from '@/types/domain'

const initial = useRecorderStore.getState()

beforeEach(() => {
  vi.useFakeTimers()
  installMediaEnvironment()
  installIntegration({ available: false })
  startNewContent.mockClear()
  useAccountStore.setState({ accounts: [LOCAL_ACCOUNT], activeId: LOCAL_ACCOUNT.id })
  useRecorderStore.setState({ ...initial, active: false, seconds: 0, mode: null, result: null, floating: null, live: null, error: null, marks: [] }, true)
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('marking while recording', () => {
  it('a mark made at 65 s of recorded sound, with a pause before, is kept at 65 s', async () => {
    const recorder = useRecorderStore.getState()
    await recorder.start('microphone')
    await vi.advanceTimersByTimeAsync(40_000)
    recorder.pause()
    await vi.advanceTimersByTimeAsync(30_000)
    recorder.resume()
    await vi.advanceTimersByTimeAsync(25_400)
    recorder.mark()
    await vi.advanceTimersByTimeAsync(4_600)
    recorder.annotate('conferir o preço')
    const marks = useRecorderStore.getState().marks
    expect(marks.map(mark => [mark.kind, mark.text])).toEqual([
      ['mark', ''],
      ['note', 'conferir o preço'],
    ])
    expect(marks[0].at).toBeCloseTo(65.4, 1)
    expect(marks[1].at).toBeCloseTo(70, 1)
  })

  it('a mark made during the pause stays at the moment the sound stopped', async () => {
    const recorder = useRecorderStore.getState()
    await recorder.start('microphone')
    await vi.advanceTimersByTimeAsync(12_000)
    recorder.pause()
    await vi.advanceTimersByTimeAsync(50_000)
    recorder.mark()
    expect(useRecorderStore.getState().marks[0].at).toBeCloseTo(12, 1)
  })

  it('the marks leave with the finished recording and go to the note being generated', async () => {
    const recorder = useRecorderStore.getState()
    await recorder.start('microphone')
    await vi.advanceTimersByTimeAsync(65_000)
    recorder.mark()
    recorder.finish()
    await vi.waitFor(() => expect(useRecorderStore.getState().result).not.toBeNull())
    expect(useRecorderStore.getState().result?.marks).toHaveLength(1)
    vi.useRealTimers()
    useRecorderStore.setState({ resultPlace: 'dialog' })
    render(
      <MemoryRouter>
        <RecordingDoneDialog />
      </MemoryRouter>,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Transcrever e gerar' }))
    await waitFor(() => expect(startNewContent).toHaveBeenCalled())
    const request = startNewContent.mock.calls[0][0] as { marks: { kind: string; at: number }[] }
    expect(request.marks).toHaveLength(1)
    expect(request.marks[0]).toMatchObject({ kind: 'mark' })
    expect(request.marks[0].at).toBeCloseTo(65, 1)
  })

  it('a new recording starts with no marks', async () => {
    const recorder = useRecorderStore.getState()
    await recorder.start('microphone')
    recorder.mark()
    recorder.cancel()
    await recorder.start('microphone')
    expect(useRecorderStore.getState().marks).toEqual([])
  })
})

describe('marks in the transcription', () => {
  const recording: RecordingData = {
    blocks: [
      { speaker: 'mic', start: 0, end: 20, text: 'Vamos começar.' },
      { speaker: 'speaker_0', start: 60, end: 70, text: 'O preço fica em dois mil.' },
      { speaker: 'mic', start: 80, end: 85, text: 'Fechado.' },
    ],
    speakers: [
      { id: 'mic', name: 'Você', suggested: false },
      { id: 'speaker_0', name: 'Marina', suggested: false },
    ],
    marks: [
      { id: 'm1', kind: 'mark', at: 65, text: '' },
      { id: 'm2', kind: 'note', at: 82, text: 'conferir o preço' },
    ],
  }

  it('the flag sits on the speech that plays at 65 s, and the note on its own speech', () => {
    vi.useRealTimers()
    render(<TranscriptTab recording={recording} />)
    const blocks = screen.getAllByRole('listitem')
    expect(within(blocks[1]).getByRole('note', { name: 'Momento marcado em 01:05' })).toBeInTheDocument()
    expect(within(blocks[2]).getByRole('note', { name: 'Anotação em 01:22' })).toHaveTextContent('conferir o preço')
    expect(within(blocks[0]).queryByRole('note')).not.toBeInTheDocument()
    expect(screen.getAllByRole('note')).toHaveLength(2)
  })

  it('a mark made before anyone speaks goes to the first speech', () => {
    vi.useRealTimers()
    render(<TranscriptTab recording={{ ...recording, blocks: recording.blocks.slice(1), marks: [{ id: 'm0', kind: 'mark', at: 3, text: '' }] }} />)
    expect(within(screen.getAllByRole('listitem')[0]).getByRole('note', { name: 'Momento marcado em 00:03' })).toBeInTheDocument()
  })
})
