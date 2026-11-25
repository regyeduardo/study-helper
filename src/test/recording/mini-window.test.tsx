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
import { COMPUTER_INPUT, FakeMediaRecorder, FakeMediaStream, FakeTrack, installMediaEnvironment, type MediaEnvironment } from '@/test/recording/media-fakes'
import { readFileSync } from 'node:fs'

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
    for (const name of ['Desligar o microfone', 'Desligar o som do computador', 'Pausar', 'Marcar momento', 'Anotar', 'Fontes', 'Terminar']) expect(button(name)).toBeVisible()
    // spec 007 (mocks/gravar-reuniao, d-durante): six controls in 3 columns, each with its whole name; the screen goes to Fontes
    expect(screen.getAllByRole('button').filter(item => item.classList.contains('tile')).map(tile => tile.textContent)).toEqual(['Microfone', 'Som do PC', 'Pausar', 'Marcar', 'Anotar', 'Fontes'])
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
    fireEvent.click(button('Marcar momento'))
    expect(actions.mark).toHaveBeenCalledTimes(1)
    fireEvent.click(button('Fontes'))
    fireEvent.click(button('Desligar a gravação de tela'))
    expect(actions.setScreen).toHaveBeenLastCalledWith(false)
    fireEvent.click(button('Trocar a tela'))
    expect(actions.switchScreen).toHaveBeenCalledTimes(1)
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
    fireEvent.click(button('Fontes'))
    expect(button('Ligar a gravação de tela')).toHaveAttribute('aria-pressed', 'false')
    expect(button('Trocar a tela')).toBeDisabled()
    fireEvent.click(button('Ligar a gravação de tela'))
    expect(setScreen).toHaveBeenLastCalledWith(true)
  })

  it('"Fontes" opens where the sound comes from in place of the controls, and the choice goes to the recorder', async () => {
    const switchComputerInput = vi.fn(async () => undefined)
    const switchMicrophone = vi.fn(async () => undefined)
    useRecorderStore.setState({ active: true, seconds: 5, mode: 'microphone', live: { ...LIVE, sourceChoice: 'none' }, switchComputerInput, switchMicrophone })
    render(<RecordingWindow />)
    expect(screen.queryByLabelText('Som do computador')).not.toBeInTheDocument()
    fireEvent.click(button('Fontes'))
    // the panel takes the place of the picture and the controls, so the window does not grow
    expect(screen.queryByRole('button', { name: 'Pausar' })).not.toBeInTheDocument()
    await screen.findByRole('option', { name: COMPUTER_INPUT.label })
    fireEvent.change(screen.getByLabelText('Som do computador'), { target: { value: COMPUTER_INPUT.deviceId } })
    expect(switchComputerInput).toHaveBeenCalledWith(COMPUTER_INPUT.deviceId)
    fireEvent.change(screen.getByLabelText('Microfone'), { target: { value: 'mic-1' } })
    expect(switchMicrophone).toHaveBeenCalledWith('mic-1')
    fireEvent.click(button('Voltar'))
    expect(screen.queryByLabelText('Som do computador')).not.toBeInTheDocument()
    expect(button('Pausar')).toBeVisible()
  })

  it('"Anotar" opens a field, Enter keeps the note and the window says how many were kept', () => {
    useRecorderStore.setState({ active: true, seconds: 65, mode: 'microphone', live: LIVE })
    render(<RecordingWindow />)
    fireEvent.click(button('Marcar momento'))
    fireEvent.click(button('Anotar'))
    expect(button('Anotar')).toHaveAttribute('aria-expanded', 'true')
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

  // T172 (pedido do dono, 24/11: "melhore as modais de gravação"; mocks/gravar-reuniao, d-durante)
  it('"Anotar": o campo diz, mesmo com o texto digitado, que Enter guarda', () => {
    useRecorderStore.setState({ active: true, seconds: 65, mode: 'microphone', live: LIVE })
    render(<RecordingWindow />)
    fireEvent.click(button('Anotar'))
    const field = screen.getByRole('textbox', { name: 'Anotação' })
    fireEvent.change(field, { target: { value: 'conferir o preço' } })
    expect(field).toHaveAccessibleDescription('Enter guarda')
    expect(screen.getByText('Enter guarda')).toBeVisible()
  })

  it('pausada, a janela diz "pausado" e não diz mais "Gravando"', () => {
    useRecorderStore.setState({ active: true, seconds: 5, mode: 'tab', live: { ...LIVE, paused: true } })
    render(<RecordingWindow />)
    expect(screen.getByText('pausado')).toBeInTheDocument()
    expect(screen.queryByText(/^Gravando/)).not.toBeInTheDocument()
    expect(button('Continuar')).toBeVisible()
  })
})

describe('screen while recording', () => {
  it('turning the screen off stops showing it, turning it on asks which screen again, and the sound goes on', async () => {
    await useRecorderStore.getState().start('tab')
    render(<RecordingWindow />)
    expect(useRecorderStore.getState().live?.screenOn).toBe(true)
    const video = env.displayStream.getVideoTracks()[0]
    const audio = env.displayStream.getAudioTracks()[0]
    fireEvent.click(button('Fontes'))
    fireEvent.click(button('Desligar a gravação de tela'))
    await waitFor(() => expect(useRecorderStore.getState().live?.screenOn).toBe(false))
    expect(video.stop).toHaveBeenCalled()
    expect(audio.stop).not.toHaveBeenCalled()
    expect(useRecorderStore.getState().live?.preview).toBeNull()
    expect(FakeMediaRecorder.instances.at(-1)!.state).toBe('recording')
    fireEvent.click(button('Ligar a gravação de tela'))
    await waitFor(() => expect(useRecorderStore.getState().live?.screenOn).toBe(true))
    expect(env.getDisplayMedia).toHaveBeenLastCalledWith({ video: true, audio: false })
    fireEvent.click(button('Trocar a tela'))
    await waitFor(() => expect(env.getDisplayMedia).toHaveBeenCalledTimes(3))
    expect(audio.stop).not.toHaveBeenCalled()
  })

  it('a microphone recording starts with the screen off', async () => {
    await useRecorderStore.getState().start('microphone')
    expect(useRecorderStore.getState().live?.screenOn).toBe(false)
  })
})

// T175 (dono, 25/11: "não deixe o visualizador do vídeo do lado das ondas de som"; mocks/gravar-reuniao, opção I): a tela em cima, na
// largura toda, e as ondas numa faixa fina embaixo dela, lado a lado; sem a tela, só as ondas, uma embaixo da outra
describe('a tela e as ondas na janelinha', () => {
  const screenStream = () => new FakeMediaStream([new FakeTrack('video', 'screen')]) as unknown as MediaStream
  const parts = (container: HTMLElement) => [...container.querySelector('.mr-media')!.children].map(child => (child.classList.contains('mr-thumb') ? 'tela' : child.classList.contains('player') ? 'ondas' : child.className))

  it('com a tela, a tela vem primeiro e as ondas numa faixa embaixo, lado a lado', () => {
    useRecorderStore.setState({ active: true, seconds: 5, mode: 'tab', live: { ...LIVE, preview: screenStream() } })
    const { container } = render(<RecordingWindow />)
    expect(parts(container)).toEqual(['tela', 'ondas'])
    expect(container.querySelector('.mr-media .player')).toHaveAttribute('data-lanes', 'side')
  })

  it('sem a tela, só as ondas, uma embaixo da outra', () => {
    useRecorderStore.setState({ active: true, seconds: 5, mode: 'microphone', live: { ...LIVE, preview: null, screenOn: false } })
    const { container } = render(<RecordingWindow />)
    expect(parts(container)).toEqual(['ondas'])
    expect(container.querySelector('.mr-media .player')).toHaveAttribute('data-lanes', 'stacked')
  })

  // na janela flutuante de 340 × 360, com a linha do resumo embaixo dos botões: 100 px de tela e 30 de faixa davam 375 px e a janela
  // rolava (medido no Chromium); com 90, 4 e 26, dá 359
  // revisão /ui-ux-pro-max (aria-labels): os nomes da faixa são só pixels no desenho; o leitor de tela não ouvia nada
  it('a faixa de ondas diz ao leitor de tela de onde vem o som', () => {
    const meter = {} as AnalyserNode
    useRecorderStore.setState({ active: true, seconds: 5, mode: 'tab', live: { ...LIVE, preview: screenStream(), meters: { microphone: meter, computer: meter } } })
    const { container, unmount } = render(<RecordingWindow />)
    expect(container.querySelector('.mr-media .player')).toHaveAttribute('role', 'img')
    expect(container.querySelector('.mr-media .player')).toHaveAttribute('aria-label', 'Ondas do som: microfone, som do PC')
    unmount()
    useRecorderStore.setState({ live: { ...LIVE, preview: null, meters: { microphone: meter, computer: null } } })
    const again = render(<RecordingWindow />)
    expect(again.container.querySelector('.mr-media .player')).toHaveAttribute('aria-label', 'Ondas do som: microfone, sem som do computador')
  })

  it('o estilo põe a tela na largura toda, com 90 px, e a faixa de 26 px embaixo (mais nada ao lado), cabendo em 360 px', () => {
    const css = readFileSync('src/styles/record-dialog.css', 'utf8').replace(/\s+/g, '')
    expect(css).toContain('.mini-rec.mr-media.screen{grid-template-columns:minmax(0,1fr);gap:4px}')
    expect(css).toContain('.mini-rec.mr-media.screen.player{height:26px}')
    expect(css).toMatch(/\.mini-rec\.mr-thumb\{width:100%;height:90px;/)
  })
})

