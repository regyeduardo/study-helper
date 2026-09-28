import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
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
import { IntegrationCapture, useIntegrationStore } from '@/lib/recording/integration'
import { installIntegration } from '@/test/recording/integration-fakes'
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
  installIntegration({ available: false })
  useIntegrationStore.setState({ status: 'unknown', hello: null })
  startNewContent.mockClear()
  useAccountStore.setState({ accounts: [LOCAL_ACCOUNT], activeId: LOCAL_ACCOUNT.id })
  useRecorderStore.setState({ active: false, seconds: 0, mode: null, result: null, resultPlace: 'dialog', floating: null, live: null, error: null })
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('RecordDialog', () => {
  it('without the integration, offers the download for this system', async () => {
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(FIREFOX)
    render(<RecordDialog />)
    const download = await screen.findByRole('link', { name: 'Baixar a integração (Linux)' })
    expect(download).toHaveAttribute('href', expect.stringMatching(/desktop-latest\/study-helper-audio-x86_64\.AppImage$/))
    expect(screen.getByRole('status', { name: 'Integração' })).toHaveTextContent('Integração não conectada')
    expect(screen.getByRole('radio', { name: /A aba da reunião/ })).toBeInTheDocument()
  })

  it('with the integration, lists the open windows, previews the chosen one and records exactly that preview', async () => {
    installIntegration({ available: true, windows: [{ id: 'x11:9', title: 'SoWork - Google Chrome', app: 'Google-chrome', pid: 77 }] })
    const captures: { stop: ReturnType<typeof vi.fn>; source: unknown }[] = []
    const start = vi.spyOn(IntegrationCapture, 'start').mockImplementation(async source => {
      const capture = { stop: vi.fn(async () => undefined), source, meters: { microphone: null, computer: null }, label: 'x' }
      captures.push(capture)
      return capture as unknown as IntegrationCapture
    })
    const startIntegration = vi.fn(async () => undefined)
    useRecorderStore.setState({ startIntegration })
    render(<RecordDialog />)
    await screen.findByRole('option', { name: 'Sistema inteiro (todo o som do computador)' })
    const picker = screen.getByRole('combobox', { name: 'Som do computador' })
    expect(screen.getByRole('status', { name: 'Integração' })).toHaveTextContent('Integração conectada (versão 0.1.0)')
    expect(await screen.findByRole('option', { name: 'SoWork - Google Chrome · Google-chrome' })).toBeInTheDocument()
    expect(screen.getByRole('option', { name: 'Sistema inteiro (todo o som do computador)' })).toBeInTheDocument()
    expect(screen.getByRole('option', { name: 'Nenhum som do computador' })).toBeInTheDocument()
    expect(screen.getByRole('checkbox', { name: /Gravar o meu microfone/ })).toHaveAttribute('aria-checked', 'true')
    expect(await screen.findByRole('option', { name: 'Headset USB' })).toBeInTheDocument()
    await waitFor(() => expect(start).toHaveBeenCalledWith({ kind: 'system' }, 'todo o som do computador', null))
    fireEvent.change(picker, { target: { value: 'pid:77' } })
    await waitFor(() => expect(start).toHaveBeenLastCalledWith({ kind: 'window', pid: 77 }, 'SoWork - Google Chrome', null))
    await waitFor(() => expect(captures[0].stop).toHaveBeenCalled())
    await waitFor(() => expect(screen.getByRole('button', { name: 'Começar a gravar' })).toBeEnabled())
    fireEvent.click(screen.getByRole('button', { name: 'Começar a gravar' }))
    await waitFor(() => expect(startIntegration).toHaveBeenCalledWith(captures.at(-1), { microphoneOn: true, microphoneId: null }))
    expect(captures.at(-1)!.stop).not.toHaveBeenCalled()
  })

  it('offers the computer audio the same way in Firefox, with the system input picked on automatic', async () => {
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(FIREFOX)
    installMediaEnvironment({ computerInput: true })
    render(<RecordDialog />)
    expect(await screen.findByRole('option', { name: `Automático · ${COMPUTER_INPUT.label}` })).toBeInTheDocument()
    expect(screen.getByRole('option', { name: `${COMPUTER_INPUT.label} · som do computador` })).toBeInTheDocument()
    expect(screen.getByRole('option', { name: 'Não gravar o som do computador' })).toBeInTheDocument()
    expect(screen.getAllByText(/Monitor of…/).length).toBeGreaterThan(0)
    expect(screen.queryByText(/só o microfone e a imagem/)).not.toBeInTheDocument()
    expect(screen.getByRole('note', { name: 'Aviso do Firefox' })).toHaveTextContent('Escolha "Sem compartilhar a tela" para gravar o seu microfone e todo o som do computador')
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
    await waitFor(() => expect(start).toHaveBeenCalledWith('tab', COMPUTER_INPUT.deviceId, { microphoneOn: true, microphoneId: null }))
  })

  it('starts recording the selected mode', async () => {
    const start = vi.fn(async () => undefined)
    useRecorderStore.setState({ start })
    render(<RecordDialog />)
    fireEvent.click(await screen.findByRole('radio', { name: /Sem compartilhar a tela/ }))
    fireEvent.click(screen.getByRole('button', { name: /Começar a gravar/ }))
    await waitFor(() => expect(start).toHaveBeenCalledWith('microphone', 'auto', { microphoneOn: true, microphoneId: null }))
  })

  it('has a separate microphone check and does not start with nothing to record', async () => {
    const start = vi.fn(async () => undefined)
    useRecorderStore.setState({ start })
    render(<RecordDialog />)
    fireEvent.click(await screen.findByRole('radio', { name: /Sem compartilhar a tela/ }))
    fireEvent.click(screen.getByRole('checkbox', { name: /Gravar o meu microfone/ }))
    fireEvent.change(screen.getByLabelText('Som do computador'), { target: { value: 'none' } })
    expect(screen.getByRole('button', { name: /Começar a gravar/ })).toBeDisabled()
    expect(screen.getByText('Ligue o microfone ou escolha um som do computador.')).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('Som do computador'), { target: { value: 'auto' } })
    fireEvent.click(screen.getByRole('button', { name: /Começar a gravar/ }))
    await waitFor(() => expect(start).toHaveBeenCalledWith('microphone', 'auto', { microphoneOn: false, microphoneId: null }))
  })

  it('explains a denied permission', async () => {
    useRecorderStore.setState({ start: vi.fn(async () => Promise.reject(Object.assign(new Error('x'), { name: 'NotAllowedError' }))) })
    render(<RecordDialog />)
    fireEvent.click(await screen.findByRole('button', { name: /Começar a gravar/ }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Você não deu permissão para gravar.')
  })
})

const LIVE = { preview: null, meters: { microphone: null, computer: null }, computerAudio: 'som da aba', hasMicrophone: true, hasSource: true, microphoneOn: true, sourceOn: true, microphoneId: null, sourceChoice: 'display', paused: false }

describe('RecordingWindow', () => {
  it('pauses and turns each sound off and on while recording', () => {
    const pause = vi.fn()
    const setEnabled = vi.fn()
    useRecorderStore.setState({ active: true, seconds: 5, mode: 'tab', live: LIVE, pause, setEnabled, floating: null })
    render(<RecordingWindow />)
    fireEvent.click(screen.getByRole('button', { name: 'Pausar' }))
    expect(pause).toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Desligar o microfone' }))
    expect(setEnabled).toHaveBeenCalledWith('microphone', false)
    fireEvent.click(screen.getByRole('button', { name: 'Desligar o som do computador' }))
    expect(setEnabled).toHaveBeenCalledWith('source', false)
    expect(screen.getByRole('button', { name: 'Trocar a aba' })).toBeInTheDocument()
  })

  it('shows Continuar while paused', () => {
    const resume = vi.fn()
    useRecorderStore.setState({ active: true, seconds: 5, mode: 'tab', live: { ...LIVE, paused: true, microphoneOn: false }, resume, floating: null })
    render(<RecordingWindow />)
    expect(screen.getByText('pausado')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Ligar o microfone' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Continuar' }))
    expect(resume).toHaveBeenCalled()
  })

  it('shows the choices for the recording in the same window after Terminar, not in the middle of the screen', () => {
    useRecorderStore.setState({ active: false, result: recordingOf(5 * MB), resultPlace: 'window', floating: null })
    render(
      <MemoryRouter>
        <RecordingWindow />
        <RecordingDoneDialog />
      </MemoryRouter>,
    )
    const window = screen.getByRole('dialog', { name: 'Gravação pronta' })
    expect(window).toHaveClass('mini-rec')
    expect(screen.getAllByRole('dialog')).toHaveLength(1)
    expect(screen.getByRole('button', { name: 'Só salvar' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Transcrever e gerar' })).toBeInTheDocument()
  })

  it('draws the controls and then the choices inside the floating window', async () => {
    const floating = { document: document.implementation.createHTMLDocument('pip'), focus: vi.fn(), close: vi.fn() } as unknown as Window
    useRecorderStore.setState({ active: true, seconds: 7, mode: 'tab', live: LIVE, floating })
    render(<RecordingWindow />)
    expect(screen.getByText('Gravando na janela flutuante')).toBeInTheDocument()
    await waitFor(() => expect(floating.document.body.textContent).toContain('Terminar'))
    expect(floating.document.body.textContent).toContain('00:07')
    act(() => useRecorderStore.setState({ active: false, result: recordingOf(5 * MB), resultPlace: 'window' }))
    await waitFor(() => expect(floating.document.body.textContent).toContain('Transcrever e gerar'))
    expect(screen.queryByRole('button', { name: 'Transcrever e gerar' })).not.toBeInTheDocument()
  })

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

  it('asks where else to keep it, suggests OnlyFiles for a small recording on the Local profile, and closes right away', async () => {
    useRecorderStore.setState({ result: recordingOf(50 * MB) })
    renderDone()
    expect(screen.getByText('Guardar também na nuvem?')).toBeInTheDocument()
    expect(checked().some(text => text?.startsWith('OnlyFiles'))).toBe(true)
    expect(screen.getByRole('radio', { name: /Não, só neste computador/ })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Transcrever e gerar' }))
    expect(useRecorderStore.getState().result).toBeNull()
    await waitFor(() => expect(startNewContent).toHaveBeenCalled())
    expect(startNewContent.mock.calls[0][0]).toMatchObject({ agent: 'meeting', storage: 'onlyfiles', input: { kind: 'recording' } })
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

  it('"Só salvar" keeps the recording in the browser without generating', async () => {
    const removeEntry = vi.fn(async () => undefined)
    Object.defineProperty(navigator, 'storage', { configurable: true, value: { getDirectory: async () => ({ removeEntry }) } })
    useRecorderStore.setState({ result: recordingOf(5 * MB) })
    renderDone()
    fireEvent.click(screen.getByRole('button', { name: 'Só salvar' }))
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
