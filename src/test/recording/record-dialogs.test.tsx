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
    expect(screen.getByText(/Monitor of…/)).toBeInTheDocument()
    expect(screen.queryByText(/só o microfone e a imagem/)).not.toBeInTheDocument()
    expect(screen.getByText(/Parar pela barra do navegador também termina/)).toBeInTheDocument()
  })

  it('names the Windows system input', () => {
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(CHROME_WINDOWS)
    render(<RecordDialog />)
    expect(screen.getByText(/Mixagem estéreo/)).toBeInTheDocument()
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
    fireEvent.click(screen.getByRole('radio', { name: /Só o microfone/ }))
    fireEvent.click(screen.getByRole('button', { name: /Começar a gravar/ }))
    await waitFor(() => expect(start).toHaveBeenCalledWith('microphone', 'auto'))
  })

  it('explains a denied permission', async () => {
    useRecorderStore.setState({ start: vi.fn(async () => Promise.reject(Object.assign(new Error('x'), { name: 'NotAllowedError' }))) })
    render(<RecordDialog />)
    fireEvent.click(screen.getByRole('button', { name: /Começar a gravar/ }))
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

  it('stores a small recording on Gofile for the Local profile', async () => {
    useRecorderStore.setState({ result: recordingOf(50 * MB) })
    renderDone()
    expect(screen.getByText(/A gravação fica guardada em Gofile\./)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Transcrever e gerar' }))
    await waitFor(() => expect(startNewContent).toHaveBeenCalled())
    expect(startNewContent.mock.calls[0][0]).toMatchObject({ agent: 'meeting', storage: 'gofile', input: { kind: 'recording' } })
  })

  it('stores a medium recording on Litterbox for the Local profile', () => {
    useRecorderStore.setState({ result: recordingOf(500 * MB) })
    renderDone()
    expect(screen.getByText(/A gravação fica guardada em Litterbox \(temporário\)\./)).toBeInTheDocument()
  })

  it('discarding the finished recording deletes the stored file from the browser', async () => {
    const removeEntry = vi.fn(async () => undefined)
    Object.defineProperty(navigator, 'storage', { configurable: true, value: { getDirectory: async () => ({ removeEntry }) } })
    useRecorderStore.setState({ result: recordingOf(5 * MB) })
    renderDone()
    fireEvent.click(screen.getByRole('button', { name: 'Descartar' }))
    await waitFor(() => expect(removeEntry).toHaveBeenCalledWith('gravacao-1.mp4'))
    expect(useRecorderStore.getState().result).toBeNull()
  })

  it('stores the recording on Drive when logged in', () => {
    useAccountStore.setState({ accounts: [LOCAL_ACCOUNT, GOOGLE], activeId: GOOGLE.id })
    useRecorderStore.setState({ result: recordingOf(3000 * MB) })
    renderDone()
    expect(screen.getByText(/A gravação fica guardada em Google Drive\./)).toBeInTheDocument()
  })
})
