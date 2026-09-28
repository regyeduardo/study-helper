import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

const { startNewContent } = vi.hoisted(() => ({ startNewContent: vi.fn(async (..._args: unknown[]) => null) }))

vi.mock('@/stores/jobs', async () => {
  const { create } = await import('zustand')
  return { useJobsStore: create(() => ({ jobs: [], startNewContent })) }
})

import { RecordDialog, RecordingDoneDialog, RecordingWindow } from '@/components/dialogs/RecordDialogs'
import { LOCAL_ACCOUNT, useAccountStore } from '@/stores/account'
import { useRecorderStore } from '@/stores/recorder'
import { useUiStore } from '@/stores/ui'
import { COMPUTER_INPUT, installMediaEnvironment } from '@/test/recording/media-fakes'

const FIREFOX = 'Mozilla/5.0 (X11; Linux x86_64; rv:128.0) Gecko/20100101 Firefox/128.0'
const CHROME_WINDOWS = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36'
const MB = 1024 * 1024
const GOOGLE = { id: 'g-1', kind: 'google' as const, name: 'Ana', email: 'ana@example.com', picture: '' }

function recordingOf(size: number) {
  const file = new File(['x'], 'Reunião.mp4', { type: 'video/mp4' })
  Object.defineProperty(file, 'size', { value: size })
  return { file, mime: 'video/mp4;codecs=avc1,opus', durationSeconds: 65, storedName: 'gravacao-1.mp4' }
}

beforeEach(() => {
  installMediaEnvironment()
  startNewContent.mockClear()
  useAccountStore.setState({ accounts: [LOCAL_ACCOUNT], activeId: LOCAL_ACCOUNT.id })
  useRecorderStore.setState({ active: false, seconds: 0, mode: null, result: null, error: null })
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('RecordDialog', () => {
  it('offers the computer audio the same way in Firefox, with the system input picked on automatic', async () => {
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(FIREFOX)
    installMediaEnvironment({ computerInput: true })
    render(<RecordDialog />)
    expect(await screen.findByRole('option', { name: `Automático · ${COMPUTER_INPUT.label}` })).toBeInTheDocument()
    expect(screen.getByRole('option', { name: `${COMPUTER_INPUT.label} · som do computador` })).toBeInTheDocument()
    expect(screen.getByRole('option', { name: 'Não gravar o som do computador' })).toBeInTheDocument()
    expect(screen.getAllByText(/Monitor of…/).length).toBeGreaterThan(0)
    expect(screen.queryByText(/só o microfone e a imagem/)).not.toBeInTheDocument()
    expect(screen.getByRole('note', { name: 'Aviso do Firefox' })).toHaveTextContent('No Firefox não dá pra gravar o som do computador junto com a tela ou a aba')
    expect(screen.getByText(/Parar pela barra do navegador também termina/)).toBeInTheDocument()
  })

  it('names the Windows system input', async () => {
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(CHROME_WINDOWS)
    render(<RecordDialog />)
    expect(await screen.findByText(/Mixagem estéreo/)).toBeInTheDocument()
    expect(screen.queryByRole('note', { name: 'Aviso do Firefox' })).not.toBeInTheDocument()
  })

  it('opens only after the microphone is allowed, and asks to keep the recordings for good', async () => {
    const env = installMediaEnvironment({ computerInput: true })
    const persist = vi.fn(async () => true)
    Object.defineProperty(navigator, 'storage', { configurable: true, value: { getDirectory: async () => env.directory, persist } })
    let allow: (stream: unknown) => void = () => undefined
    env.getUserMedia.mockImplementationOnce(() => new Promise(resolve => (allow = resolve)))
    render(<RecordDialog />)
    expect(screen.queryByText('O que gravar')).not.toBeInTheDocument()
    expect(env.getUserMedia).toHaveBeenCalledWith({ audio: true })
    allow(env.microphoneStream)
    expect(await screen.findByText('O que gravar')).toBeInTheDocument()
    expect(screen.getByRole('option', { name: `${COMPUTER_INPUT.label} · som do computador` })).toBeInTheDocument()
    expect(persist).toHaveBeenCalled()
  })

  it('does not open when the microphone is refused and says how to allow it', async () => {
    const env = installMediaEnvironment()
    env.getUserMedia.mockRejectedValueOnce(Object.assign(new Error('no'), { name: 'NotAllowedError' }))
    const close = vi.fn()
    const toast = vi.fn()
    useUiStore.setState({ close, toast })
    render(<RecordDialog />)
    await waitFor(() => expect(close).toHaveBeenCalled())
    expect(toast).toHaveBeenCalledWith(expect.stringMatching(/libere o microfone deste site/))
    expect(screen.queryByText('O que gravar')).not.toBeInTheDocument()
  })

  it('asks the microphone permission to show the input names when the browser hides them', async () => {
    const env = installMediaEnvironment({ computerInput: true })
    env.enumerateDevices.mockResolvedValueOnce([{ kind: 'audioinput', deviceId: 'x', label: '', groupId: '' }])
    render(<RecordDialog />)
    fireEvent.click(await screen.findByRole('button', { name: 'Mostrar as entradas de som' }))
    expect(await screen.findByRole('option', { name: `${COMPUTER_INPUT.label} · som do computador` })).toBeInTheDocument()
    expect(env.getUserMedia).toHaveBeenCalledWith({ audio: true })
  })

  it('starts with the computer input the person picked', async () => {
    installMediaEnvironment({ computerInput: true })
    const start = vi.fn(async () => undefined)
    useRecorderStore.setState({ start })
    render(<RecordDialog />)
    await screen.findByRole('option', { name: `${COMPUTER_INPUT.label} · som do computador` })
    fireEvent.change(screen.getByLabelText('Som do computador'), { target: { value: COMPUTER_INPUT.deviceId } })
    fireEvent.click(screen.getByRole('button', { name: /Começar a gravar/ }))
    await waitFor(() => expect(start).toHaveBeenCalledWith('tab', COMPUTER_INPUT.deviceId))
  })

  it('starts recording the selected mode', async () => {
    const start = vi.fn(async () => undefined)
    useRecorderStore.setState({ start })
    render(<RecordDialog />)
    fireEvent.click(await screen.findByRole('radio', { name: /Só o microfone/ }))
    fireEvent.click(screen.getByRole('button', { name: /Começar a gravar/ }))
    await waitFor(() => expect(start).toHaveBeenCalledWith('microphone', 'auto'))
  })

  it('explains a denied permission', async () => {
    useRecorderStore.setState({ start: vi.fn(async () => Promise.reject(Object.assign(new Error('x'), { name: 'NotAllowedError' }))) })
    render(<RecordDialog />)
    fireEvent.click(await screen.findByRole('button', { name: /Começar a gravar/ }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Você não deu permissão para gravar.')
  })
})

describe('RecordingWindow', () => {
  it('shows the elapsed time and finishes on Terminar', () => {
    const finish = vi.fn()
    useRecorderStore.setState({ active: true, seconds: 3725, mode: 'tab', finish })
    render(<RecordingWindow />)
    expect(screen.getByText('1:02:05')).toBeInTheDocument()
    expect(screen.getByText('Gravando a aba')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Terminar' }))
    expect(finish).toHaveBeenCalled()
  })

  it('asks before discarding', () => {
    const cancel = vi.fn()
    useRecorderStore.setState({ active: true, seconds: 5, mode: 'microphone', cancel })
    render(<RecordingWindow />)
    fireEvent.click(screen.getByRole('button', { name: 'Cancelar' }))
    expect(cancel).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Descartar' }))
    expect(cancel).toHaveBeenCalled()
  })
})

describe('RecordingDoneDialog', () => {
  function renderDone() {
    render(
      <MemoryRouter>
        <RecordingDoneDialog />
      </MemoryRouter>,
    )
  }

  const checked = () => screen.getAllByRole('radio').filter(radio => radio.getAttribute('aria-checked') === 'true').map(radio => radio.textContent)

  it('asks where else to keep it, suggests Gofile for a small recording on the Local profile, and closes right away', async () => {
    useRecorderStore.setState({ result: recordingOf(50 * MB) })
    renderDone()
    expect(screen.getByText('Guardar também na nuvem?')).toBeInTheDocument()
    expect(checked().some(text => text?.startsWith('Gofile'))).toBe(true)
    expect(screen.getByRole('radio', { name: /Não, só neste computador/ })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Transcrever e gerar' }))
    expect(useRecorderStore.getState().result).toBeNull()
    await waitFor(() => expect(startNewContent).toHaveBeenCalled())
    expect(startNewContent.mock.calls[0][0]).toMatchObject({ agent: 'meeting', storage: 'gofile', input: { kind: 'recording' } })
  })

  it('sends the place the person picked', async () => {
    useRecorderStore.setState({ result: recordingOf(50 * MB) })
    renderDone()
    fireEvent.click(screen.getByRole('radio', { name: /Não, só neste computador/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Transcrever e gerar' }))
    await waitFor(() => expect(startNewContent).toHaveBeenCalled())
    expect(startNewContent.mock.calls[0][0]).toMatchObject({ storage: 'none' })
  })

  it('suggests Litterbox for a medium recording on the Local profile', () => {
    useRecorderStore.setState({ result: recordingOf(500 * MB) })
    renderDone()
    expect(checked().some(text => text?.startsWith('Litterbox'))).toBe(true)
  })

  it('"Agora não" keeps the recording in the browser', async () => {
    const removeEntry = vi.fn(async () => undefined)
    Object.defineProperty(navigator, 'storage', { configurable: true, value: { getDirectory: async () => ({ removeEntry }) } })
    useRecorderStore.setState({ result: recordingOf(5 * MB) })
    renderDone()
    fireEvent.click(screen.getByRole('button', { name: 'Agora não' }))
    expect(useRecorderStore.getState().result).toBeNull()
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(removeEntry).not.toHaveBeenCalled()
  })

  it('suggests Drive when logged in', () => {
    useAccountStore.setState({ accounts: [LOCAL_ACCOUNT, GOOGLE], activeId: GOOGLE.id })
    useRecorderStore.setState({ result: recordingOf(3000 * MB) })
    renderDone()
    expect(checked().some(text => text?.startsWith('Google Drive'))).toBe(true)
  })
})
