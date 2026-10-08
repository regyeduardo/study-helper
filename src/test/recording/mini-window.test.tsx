import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'

vi.mock('@/stores/jobs', async () => {
  const { create } = await import('zustand')
  return { useJobsStore: create(() => ({ jobs: [], startNewContent: async () => null })) }
})

import { RecordingWindow } from '@/components/dialogs/RecordDialogs'
import type { LiveCapture } from '@/lib/recording/recorder'
import { useRecorderStore } from '@/stores/recorder'
import { installIntegration } from '@/test/recording/integration-fakes'
import { COMPUTER_INPUT, FakeMediaRecorder, installMediaEnvironment, type MediaEnvironment } from '@/test/recording/media-fakes'

const LIVE: LiveCapture = {
  preview: null,
  meters: { microphone: null, computer: null },
  computerAudio: 'som da aba',
  hasMicrophone: true,
  hasSource: true,
  microphoneOn: true,
  sourceOn: true,
  microphoneId: null,
  sourceChoice: 'display',
  paused: false,
  screenOn: true,
}

const initial = useRecorderStore.getState()
let env: MediaEnvironment

const button = (name: string) => screen.getByRole('button', { name })

beforeEach(() => {
  env = installMediaEnvironment({ computerInput: true })
  installIntegration({ available: false })
  useRecorderStore.setState({ ...initial, active: false, seconds: 0, mode: null, result: null, floating: null, live: null, error: null, marks: [] }, true)
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('mini recording window', () => {
  it('shows the time and every control at once', () => {
    useRecorderStore.setState({ active: true, seconds: 65, mode: 'tab', live: LIVE })
    render(<RecordingWindow />)
    expect(screen.getByText('01:05')).toBeInTheDocument()
    for (const name of ['Trocar janela', 'Desligar o microfone', 'Desligar o som do computador', 'Pausar', 'Desligar a gravação de tela', 'Trocar tela', 'Marcar momento', 'Anotar', 'Terminar']) expect(button(name)).toBeVisible()
    expect(screen.getAllByRole('button').filter(item => item.classList.contains('tile')).map(tile => tile.textContent)).toEqual(['Microfone', 'Som do PC', 'Pausar', 'Gravar tela', 'Trocar janela', 'Trocar tela', 'Marcar', 'Anotar'])
  })

  it('each control changes its own state', () => {
    const actions = { setEnabled: vi.fn(), pause: vi.fn(), setScreen: vi.fn(async () => undefined), switchScreen: vi.fn(async () => undefined), mark: vi.fn(), finish: vi.fn() }
    useRecorderStore.setState({ active: true, seconds: 5, mode: 'tab', live: LIVE, ...actions })
    render(<RecordingWindow />)
    fireEvent.click(button('Desligar o microfone'))
    expect(actions.setEnabled).toHaveBeenLastCalledWith('microphone', false)
    fireEvent.click(button('Desligar o som do computador'))
    expect(actions.setEnabled).toHaveBeenLastCalledWith('source', false)
    fireEvent.click(button('Pausar'))
    expect(actions.pause).toHaveBeenCalledTimes(1)
    fireEvent.click(button('Desligar a gravação de tela'))
    expect(actions.setScreen).toHaveBeenLastCalledWith(false)
    fireEvent.click(button('Trocar tela'))
    expect(actions.switchScreen).toHaveBeenCalledTimes(1)
    fireEvent.click(button('Marcar momento'))
    expect(actions.mark).toHaveBeenCalledTimes(1)
    fireEvent.click(button('Terminar'))
    expect(actions.finish).toHaveBeenCalledTimes(1)
  })

  it('each control shows the state it is in', () => {
    const resume = vi.fn()
    const setScreen = vi.fn(async () => undefined)
    useRecorderStore.setState({ active: true, seconds: 5, mode: 'microphone', live: { ...LIVE, microphoneOn: false, hasSource: false, sourceOn: false, paused: true, screenOn: false, computerAudio: '' }, resume, setScreen })
    render(<RecordingWindow />)
    expect(button('Ligar o microfone')).toHaveAttribute('aria-pressed', 'false')
    expect(button('Ligar o som do computador')).toBeDisabled()
    expect(screen.getByText('pausado')).toBeInTheDocument()
    fireEvent.click(button('Continuar'))
    expect(resume).toHaveBeenCalledTimes(1)
    expect(button('Ligar a gravação de tela')).toHaveAttribute('aria-pressed', 'false')
    expect(button('Trocar tela')).toBeDisabled()
    fireEvent.click(button('Ligar a gravação de tela'))
    expect(setScreen).toHaveBeenLastCalledWith(true)
  })

  it('"Trocar janela" opens where the sound comes from, and the choice goes to the recorder', async () => {
    const switchComputerInput = vi.fn(async () => undefined)
    const switchMicrophone = vi.fn(async () => undefined)
    useRecorderStore.setState({ active: true, seconds: 5, mode: 'microphone', live: { ...LIVE, sourceChoice: 'none' }, switchComputerInput, switchMicrophone })
    render(<RecordingWindow />)
    expect(screen.queryByLabelText('Som do computador')).not.toBeInTheDocument()
    fireEvent.click(button('Trocar janela'))
    expect(button('Trocar janela')).toHaveAttribute('aria-expanded', 'true')
    await screen.findByRole('option', { name: COMPUTER_INPUT.label })
    fireEvent.change(screen.getByLabelText('Som do computador'), { target: { value: COMPUTER_INPUT.deviceId } })
    expect(switchComputerInput).toHaveBeenCalledWith(COMPUTER_INPUT.deviceId)
    fireEvent.change(screen.getByLabelText('Microfone'), { target: { value: 'mic-1' } })
    expect(switchMicrophone).toHaveBeenCalledWith('mic-1')
    fireEvent.click(button('Trocar janela'))
    expect(screen.queryByLabelText('Som do computador')).not.toBeInTheDocument()
  })

  it('"Anotar" opens a field, Enter keeps the note and the window says how many were kept', () => {
    useRecorderStore.setState({ active: true, seconds: 65, mode: 'microphone', live: LIVE })
    render(<RecordingWindow />)
    fireEvent.click(button('Marcar momento'))
    fireEvent.click(button('Anotar'))
    const field = screen.getByRole('textbox', { name: 'Anotação' })
    fireEvent.change(field, { target: { value: 'conferir o preço' } })
    fireEvent.keyDown(field, { key: 'Enter' })
    expect(screen.queryByRole('textbox', { name: 'Anotação' })).not.toBeInTheDocument()
    expect(useRecorderStore.getState().marks.map(mark => [mark.kind, mark.text])).toEqual([
      ['mark', ''],
      ['note', 'conferir o preço'],
    ])
    expect(screen.getByText('1 marcação · 1 anotação')).toBeInTheDocument()
  })
})

describe('screen while recording', () => {
  it('turning the screen off stops showing it, turning it on asks which screen again, and the sound goes on', async () => {
    await useRecorderStore.getState().start('tab')
    render(<RecordingWindow />)
    expect(useRecorderStore.getState().live?.screenOn).toBe(true)
    const video = env.displayStream.getVideoTracks()[0]
    const audio = env.displayStream.getAudioTracks()[0]
    fireEvent.click(button('Desligar a gravação de tela'))
    await waitFor(() => expect(useRecorderStore.getState().live?.screenOn).toBe(false))
    expect(video.stop).toHaveBeenCalled()
    expect(audio.stop).not.toHaveBeenCalled()
    expect(useRecorderStore.getState().live?.preview).toBeNull()
    expect(FakeMediaRecorder.instances.at(-1)!.state).toBe('recording')
    fireEvent.click(button('Ligar a gravação de tela'))
    await waitFor(() => expect(useRecorderStore.getState().live?.screenOn).toBe(true))
    expect(env.getDisplayMedia).toHaveBeenLastCalledWith({ video: true, audio: false })
    fireEvent.click(button('Trocar tela'))
    await waitFor(() => expect(env.getDisplayMedia).toHaveBeenCalledTimes(3))
    expect(audio.stop).not.toHaveBeenCalled()
  })

  it('a microphone recording starts with the screen off', async () => {
    await useRecorderStore.getState().start('microphone')
    expect(useRecorderStore.getState().live?.screenOn).toBe(false)
  })
})
