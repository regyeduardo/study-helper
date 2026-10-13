import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'

vi.mock('@/stores/jobs', async () => {
  const { create } = await import('zustand')
  return { useJobsStore: create(() => ({ jobs: [], startNewContent: vi.fn() })) }
})

import { RecordDialog } from '@/components/dialogs/RecordDialogs'
import { IntegrationCapture, useIntegrationStore } from '@/lib/recording/integration'
import { LOCAL_ACCOUNT, useAccountStore } from '@/stores/account'
import { useRecorderStore } from '@/stores/recorder'
import { installIntegration } from '@/test/recording/integration-fakes'
import { COMPUTER_INPUT, FakeAudioContext, installMediaEnvironment, MICROPHONE_INPUT, type MediaEnvironment } from '@/test/recording/media-fakes'

const HDMI_INPUT = { kind: 'audioinput', deviceId: 'monitor-2', label: 'Monitor of HDMI Audio', groupId: 'g3' }

let env: MediaEnvironment

async function openCheck() {
  render(<RecordDialog />)
  const check = await screen.findByRole('group', { name: 'Confira antes de gravar' })
  await waitFor(() => expect(FakeAudioContext.instances).toHaveLength(1))
  return check
}

beforeEach(() => {
  env = installMediaEnvironment({ computerInput: true, displayAudio: false })
  installIntegration({ available: false })
  useIntegrationStore.setState({ status: 'unknown', hello: null })
  useAccountStore.setState({ accounts: [LOCAL_ACCOUNT], activeId: LOCAL_ACCOUNT.id })
  useRecorderStore.setState({ active: false, seconds: 0, mode: null, result: null, resultPlace: 'dialog', floating: null, live: null, error: null })
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('RecordDialog check before recording', () => {
  it('tells when the microphone is picking up the voice', async () => {
    const check = await openCheck()
    expect(await screen.findByText('Fale algo: ainda não ouvi o microfone.')).toBeInTheDocument()
    FakeAudioContext.instances[0].analysers[0].level = 0.05
    expect(await screen.findByText('Microfone captando.')).toBeInTheDocument()
    expect(check).toHaveTextContent(`Som do computador: ${COMPUTER_INPUT.label}`)
  })

  it('plays the test sound and says it was captured', async () => {
    await openCheck()
    fireEvent.click(await screen.findByRole('button', { name: 'Tocar som de teste' }))
    await waitFor(() => expect(FakeAudioContext.instances[0].oscillators[0]?.start).toHaveBeenCalled())
    FakeAudioContext.instances[0].analysers[1].level = 0.05
    expect(await screen.findByText('O som de teste foi capturado.')).toBeInTheDocument()
  })

  it('says the test sound did not arrive when the computer side stays silent', async () => {
    await openCheck()
    fireEvent.click(await screen.findByRole('button', { name: 'Tocar som de teste' }))
    expect(await screen.findByText(/O som de teste não chegou/, undefined, { timeout: 3000 })).toBeInTheDocument()
  })

  it('names the computer input the browser did not open', async () => {
    env.enumerateDevices.mockResolvedValue([MICROPHONE_INPUT, COMPUTER_INPUT, HDMI_INPUT])
    const open = env.getUserMedia.getMockImplementation()!
    env.getUserMedia.mockImplementation(async (constraints: { audio: { deviceId?: { exact: string } } | boolean }) => {
      if (typeof constraints.audio === 'object' && constraints.audio.deviceId?.exact === HDMI_INPUT.deviceId) throw new DOMException('refused', 'NotAllowedError')
      return open(constraints)
    })
    await openCheck()
    expect(await screen.findByText(`O navegador não abriu: ${HDMI_INPUT.label}.`)).toBeInTheDocument()
  })

  it('picks the tab before recording and records that same tab without asking again', async () => {
    const start = vi.fn(async () => undefined)
    useRecorderStore.setState({ start })
    await openCheck()
    fireEvent.click(await screen.findByRole('button', { name: 'Escolher a aba agora' }))
    expect(await screen.findByText('Aba escolhida: é ela que vai ser gravada.')).toBeInTheDocument()
    expect(env.getDisplayMedia).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByRole('button', { name: 'Começar a gravar' }))
    await waitFor(() => expect(start).toHaveBeenCalledWith('tab', 'auto', expect.objectContaining({ display: env.displayStream })))
    expect(env.displayStream.getVideoTracks()[0].stop).not.toHaveBeenCalled()
  })

  it('with the integration, plays the test sound over the whole system and says it was captured', async () => {
    installIntegration({ available: true, windows: [{ id: 'x11:9', title: 'SoWork - Google Chrome', app: 'Google-chrome', pid: 77 }] })
    useIntegrationStore.setState({ status: 'connected', hello: { version: '0.1.0', os: 'linux' } })
    const context = new FakeAudioContext()
    const meters = { microphone: context.createAnalyser(), computer: context.createAnalyser() }
    vi.spyOn(IntegrationCapture, 'start').mockImplementation(async () => ({ stop: vi.fn(async () => undefined), context, meters, label: 'todo o som do computador' }) as unknown as IntegrationCapture)
    render(<RecordDialog />)
    const check = await screen.findByRole('group', { name: 'Confira antes de gravar' })
    expect(await screen.findByText('Fale algo: ainda não ouvi o microfone.')).toBeInTheDocument()
    expect(check).toHaveTextContent('Som do computador: todo o som do computador')
    fireEvent.click(await screen.findByRole('button', { name: 'Tocar som de teste' }))
    await waitFor(() => expect(context.oscillators[0]?.start).toHaveBeenCalled())
    meters.computer.level = 0.05
    expect(await screen.findByText('O som de teste foi capturado.')).toBeInTheDocument()
    fireEvent.change(screen.getByRole('combobox', { name: 'Som do computador' }), { target: { value: 'pid:77' } })
    expect(await screen.findByText('Faça som na janela escolhida: a onda verde e o aviso "chegando som" mostram o que chega.')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Tocar som de teste' })).not.toBeInTheDocument()
  })

  it('has no window to pick when nothing of the screen is recorded', async () => {
    await openCheck()
    fireEvent.click(screen.getByRole('radio', { name: /Sem compartilhar a tela/ }))
    expect(screen.queryByRole('button', { name: /Escolher .* agora/ })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('radio', { name: /5 fps/ }))
    expect(screen.getByRole('button', { name: 'Escolher a janela agora' })).toBeInTheDocument()
  })
})
