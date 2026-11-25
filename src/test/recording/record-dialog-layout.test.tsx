// Spec 007, FR-023 (T154): a janela "Gravar reunião" conforme mocks/gravar-reuniao/decisoes.md: larga, duas colunas, sem rolar;
// "Gravar a tela" com as 4 opções e quanto cada uma ocupa por hora, e a "Gravação otimizada".
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'

vi.mock('@/stores/jobs', async () => {
  const { create } = await import('zustand')
  return { useJobsStore: create(() => ({ jobs: [], startNewContent: vi.fn() })) }
})

import { RecordDialog } from '@/components/dialogs/RecordDialogs'
import { IntegrationCapture, useIntegrationStore } from '@/lib/recording/integration'
import { LOCAL_ACCOUNT, useAccountStore } from '@/stores/account'
import { useLibraryStore } from '@/stores/library'
import { useRecorderStore } from '@/stores/recorder'
import { useUiStore } from '@/stores/ui'
import { installIntegration } from '@/test/recording/integration-fakes'
import { FakeAudioContext, installMediaEnvironment } from '@/test/recording/media-fakes'

const GOOGLE = { id: 'g-1', kind: 'google' as const, name: 'Ana', email: 'ana@example.com', picture: '' }

function radiosOf(label: string): HTMLElement[] {
  const field = screen.getByText(label, { selector: '.lab' }).closest('.field')!
  return [...field.querySelectorAll<HTMLElement>('[role=radio]')]
}

const names = (radios: HTMLElement[]) => radios.map(radio => radio.querySelector('b')!.textContent)

async function openDialog() {
  render(<RecordDialog />)
  await screen.findByText('Gravar a tela', { selector: '.lab' })
}

beforeEach(() => {
  installMediaEnvironment({ computerInput: true, displayAudio: false })
  installIntegration({ available: false })
  useIntegrationStore.setState({ status: 'unknown', hello: null })
  useAccountStore.setState({ accounts: [LOCAL_ACCOUNT, GOOGLE], activeId: GOOGLE.id })
  useLibraryStore.setState({ appOn: true })
  useRecorderStore.setState({ active: false, seconds: 0, mode: null, result: null, resultPlace: 'dialog', floating: null, live: null, error: null })
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  useLibraryStore.setState({ appOn: false })
})

describe('"Gravar a tela": as quatro opções', () => {
  it('Não, 5 fps, 30 fps e Gravação otimizada, cada uma com quanto ocupa por hora', async () => {
    await openDialog()
    const radios = radiosOf('Gravar a tela')
    expect(names(radios)).toEqual(['Não', '5 fps', '30 fps', 'Gravação otimizada'])
    expect(radios[0]).toHaveTextContent('cerca de 14 MB por hora')
    expect(radios[1]).toHaveTextContent('até ~150 MB por hora')
    expect(radios[2]).toHaveTextContent('até ~600 MB por hora')
    expect(radios[3]).toHaveTextContent(/até ~\d+ MB por hora/)
    expect(radios[3]).toHaveTextContent('novo')
  })

  it('a Gravação otimizada diz para que serve e grava a 30 fps, só quando a tela muda', async () => {
    const start = vi.fn(async () => undefined)
    useRecorderStore.setState({ start })
    await openDialog()
    expect(screen.queryByText(/Para rever trechos/)).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('radio', { name: /Gravação otimizada/ }))
    expect(screen.getByRole('radio', { name: /Gravação otimizada/ })).toHaveAttribute('aria-checked', 'true')
    expect(screen.getByText(/Para rever trechos: guarda só o que muda na tela/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /Começar a gravar/ }))
    await waitFor(() => expect(start).toHaveBeenCalledWith('tab', 'auto', expect.objectContaining({ video: { fps: 30, optimized: true } })))
  })

  it('a de 30 fps continua a de sempre', async () => {
    const start = vi.fn(async () => undefined)
    useRecorderStore.setState({ start })
    await openDialog()
    fireEvent.click(radiosOf('Gravar a tela')[2])
    fireEvent.click(screen.getByRole('button', { name: /Começar a gravar/ }))
    await waitFor(() => expect(start).toHaveBeenCalledWith('tab', 'auto', expect.objectContaining({ video: { fps: 30 } })))
  })
})

describe('o resto da janela, sem rolar', () => {
  it('larga, em duas colunas', async () => {
    await openDialog()
    expect(screen.getByRole('dialog', { name: 'Gravar reunião' })).toHaveClass('wide')
    expect(document.querySelectorAll('.rd-cols > .rd-col')).toHaveLength(2)
  })

  it('"O que gravar" lado a lado, com a explicação da escolhida', async () => {
    await openDialog()
    expect(names(radiosOf('O que gravar'))).toEqual(['Aba da reunião', 'Tela inteira', 'Sem compartilhar'])
    expect(screen.getByText('Meet, Teams ou Zoom no navegador. Grava o som da aba.')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('radio', { name: 'Tela inteira' }))
    expect(screen.getByText(/Para reunião em app instalado/)).toBeInTheDocument()
    expect(screen.queryByText('Meet, Teams ou Zoom no navegador. Grava o som da aba.')).not.toBeInTheDocument()
  })

  it('"Onde salvar" lado a lado, com a explicação da escolhida', async () => {
    await openDialog()
    expect(names(radiosOf('Onde salvar'))).toEqual(['Neste computador', 'Google Drive', 'App'])
    expect(screen.getByText('A nota e a mídia ficam no App. Dá para trocar no fim.')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('radio', { name: 'Neste computador' }))
    expect(screen.getByText('Fica em Mídias, neste navegador.')).toBeInTheDocument()
  })

  it('sem o Google, o Drive fica apagado e diz por quê', async () => {
    useAccountStore.setState({ accounts: [LOCAL_ACCOUNT], activeId: LOCAL_ACCOUNT.id })
    await openDialog()
    expect(screen.getByRole('radio', { name: 'Google Drive' })).toHaveAttribute('aria-disabled', 'true')
    expect(screen.getByText('Entre com o Google para guardar no Drive.')).toBeInTheDocument()
  })

  it('o microfone numa linha: a caixa e a lista juntas', async () => {
    await openDialog()
    const row = screen.getByRole('checkbox', { name: /Gravar o meu microfone/ }).closest('.rd-mic')!
    expect(row).toContainElement(screen.getByRole('combobox', { name: 'Microfone' }))
  })

  it('"Ver as gravações deste computador" fica no rodapé e abre as mídias', async () => {
    const open = vi.spyOn(useUiStore.getState(), 'open')
    await openDialog()
    const link = screen.getByRole('button', { name: /Ver as gravações deste computador/ })
    expect(link.closest('.df')).not.toBeNull()
    fireEvent.click(link)
    expect(open).toHaveBeenCalledWith({ kind: 'media' })
  })
})

describe('com a integração', () => {
  it('as mesmas quatro opções, e a otimizada vai para a gravação da integração', async () => {
    installIntegration({ available: true, windows: [] })
    useIntegrationStore.setState({ status: 'connected', hello: { version: '0.1.0', os: 'linux' } })
    const context = new FakeAudioContext()
    const meters = { microphone: context.createAnalyser(), computer: context.createAnalyser() }
    vi.spyOn(IntegrationCapture, 'start').mockImplementation(async () => ({ stop: vi.fn(async () => undefined), context, meters, label: 'todo o som do computador' }) as unknown as IntegrationCapture)
    const startIntegration = vi.fn(async () => undefined)
    useRecorderStore.setState({ startIntegration })
    await openDialog()
    expect(names(radiosOf('Gravar a tela'))).toEqual(['Não', '5 fps', '30 fps', 'Gravação otimizada'])
    expect(document.querySelectorAll('.rd-cols > .rd-col')).toHaveLength(2)
    fireEvent.click(screen.getByRole('radio', { name: /Gravação otimizada/ }))
    await screen.findByRole('group', { name: 'Confira antes de gravar' })
    fireEvent.click(screen.getByRole('button', { name: /Começar a gravar/ }))
    await waitFor(() => expect(startIntegration).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ video: { fps: 30, optimized: true } })))
  })
})
