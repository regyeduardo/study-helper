// 23/11/2026, escolha A do dono: com a estrutura do app ligada, "Onde salvar" da gravação tem App, e o App vem marcado.
// Gravando de dentro de uma pasta da biblioteca, essa pasta já vem escolhida no fim. Pasta não tem lugar (spec 005): ela não decide o lugar marcado.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

const { saveRecording } = vi.hoisted(() => ({ saveRecording: vi.fn(async (..._args: unknown[]) => 'n1') }))

vi.mock('@/stores/jobs', async () => {
  const { create } = await import('zustand')
  return { useJobsStore: create(() => ({ jobs: [], saveRecording, trackTask: () => ({ update: () => undefined, done: () => undefined, fail: () => undefined, drop: () => undefined }) })) }
})

vi.mock('@/routes', () => ({ router: { navigate: vi.fn() } }))

import type { FolderMeta } from '@/types/domain'
import { RecordDialog, RecordingDoneDialog } from '@/components/dialogs/RecordDialogs'
import { newFolderMeta } from '@/lib/defaults'
import type { RecordingDestination } from '@/lib/recording/recorder'
import { LOCAL_ACCOUNT, useAccountStore } from '@/stores/account'
import { useLibraryStore } from '@/stores/library'
import { useRecorderStore } from '@/stores/recorder'
import { useIntegrationStore } from '@/lib/recording/integration'
import { installIntegration } from '@/test/recording/integration-fakes'
import { installMediaEnvironment } from '@/test/recording/media-fakes'

const GOOGLE = { id: 'g-1', kind: 'google' as const, name: 'Ana', email: 'ana@example.com', picture: '' }

const faculdade: FolderMeta = { ...newFolderMeta({ name: 'Faculdade' }), place: 'app' }
const trabalho: FolderMeta = { ...newFolderMeta({ name: 'Trabalho' }), place: 'drive' }

function placeRadios(): string[] {
  const field = screen.getByText('Onde salvar').closest('.field')!
  return [...field.querySelectorAll<HTMLElement>('[role=radio]')].map(radio => radio.querySelector('b')!.textContent ?? '')
}

const checked = () =>
  screen
    .getAllByRole('radio')
    .filter(radio => radio.getAttribute('aria-checked') === 'true')
    .map(radio => radio.querySelector('b')?.textContent ?? '')

async function startFrom(path: string) {
  window.history.pushState({}, '', path)
  const start = vi.fn(async () => undefined)
  useRecorderStore.setState({ start })
  render(<RecordDialog />)
  await screen.findByText('Onde salvar')
  return start
}

function recording(destination: RecordingDestination, folderId: string | null) {
  const file = new File(['x'], 'Reunião.webm', { type: 'video/webm' })
  return { file, mime: 'video/webm', durationSeconds: 65, storedName: 'gravacao-1.webm', destination, folderId }
}

function renderDone() {
  render(
    <MemoryRouter>
      <RecordingDoneDialog />
    </MemoryRouter>,
  )
}

beforeEach(() => {
  installMediaEnvironment()
  installIntegration({ available: false })
  useIntegrationStore.setState({ status: 'unknown', hello: null })
  saveRecording.mockClear()
  useAccountStore.setState({ accounts: [LOCAL_ACCOUNT, GOOGLE], activeId: GOOGLE.id })
  useLibraryStore.setState({ appOn: true, folders: [faculdade, trabalho] })
  useRecorderStore.setState({ active: false, seconds: 0, mode: null, result: null, resultPlace: 'dialog', floating: null, live: null, error: null })
})

afterEach(() => {
  window.history.pushState({}, '', '/')
  useLibraryStore.setState({ appOn: false, folders: [] })
  vi.restoreAllMocks()
})

describe('Onde salvar a gravação, com a estrutura do app ligada', () => {
  it('tem App ao lado de Neste computador e Google Drive, e o App vem marcado', async () => {
    const start = await startFrom('/')
    expect(placeRadios()).toEqual(['Neste computador', 'Google Drive', 'App'])
    expect(checked()).toContain('App')
    fireEvent.click(screen.getByRole('button', { name: /Começar a gravar/ }))
    await waitFor(() => expect(start).toHaveBeenCalledWith('tab', 'auto', expect.objectContaining({ destination: 'app', folderId: null })))
  })

  it('com a estrutura desligada, não aparece App', async () => {
    useLibraryStore.setState({ appOn: false })
    await startFrom('/')
    expect(placeRadios()).toEqual(['Neste computador', 'Google Drive'])
  })

  it('gravando de dentro de uma pasta do App, a pasta vai junto e o App vem marcado', async () => {
    const start = await startFrom(`/biblioteca/${faculdade.id}`)
    expect(checked()).toContain('App')
    fireEvent.click(screen.getByRole('button', { name: /Começar a gravar/ }))
    await waitFor(() => expect(start).toHaveBeenCalledWith('tab', 'auto', expect.objectContaining({ destination: 'app', folderId: faculdade.id })))
  })

  it('de dentro de uma pasta cujas notas estão no Google Drive, o App continua marcado: a pasta não decide o lugar', async () => {
    const start = await startFrom(`/biblioteca/${trabalho.id}`)
    expect(checked()).toContain('App')
    fireEvent.click(screen.getByRole('button', { name: /Começar a gravar/ }))
    await waitFor(() => expect(start).toHaveBeenCalledWith('tab', 'auto', expect.objectContaining({ destination: 'app', folderId: trabalho.id })))
  })
})

describe('Gravação pronta', () => {
  it('vem com o App marcado e a pasta de onde começou; Salvar leva a nota e a mídia para o App', async () => {
    useRecorderStore.setState({ result: recording('app', faculdade.id) })
    renderDone()
    expect(checked()).toContain('App')
    expect(screen.getByRole('group', { name: 'Pasta' })).toHaveTextContent('Faculdade')
    fireEvent.click(screen.getByRole('button', { name: 'Salvar' }))
    await waitFor(() => expect(saveRecording).toHaveBeenCalled())
    expect(saveRecording.mock.calls[0][0]).toMatchObject({ storage: 'drive', place: 'app', folderId: faculdade.id })
  })

  it('trocar para Google Drive leva para o Drive mesmo numa pasta do App', async () => {
    useRecorderStore.setState({ result: recording('app', faculdade.id) })
    renderDone()
    fireEvent.click(screen.getByRole('radio', { name: /Google Drive/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Salvar' }))
    await waitFor(() => expect(saveRecording).toHaveBeenCalled())
    expect(saveRecording.mock.calls[0][0]).toMatchObject({ storage: 'drive', place: 'drive', folderId: faculdade.id })
  })

  it('"Só neste computador" deixa a mídia em Mídias e a nota no lugar da pasta', async () => {
    useRecorderStore.setState({ result: recording('app', faculdade.id) })
    renderDone()
    fireEvent.click(screen.getByRole('radio', { name: /Neste computador/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Salvar' }))
    await waitFor(() => expect(saveRecording).toHaveBeenCalled())
    const request = saveRecording.mock.calls[0][0] as Record<string, unknown>
    expect(request).toMatchObject({ storage: 'none', folderId: faculdade.id })
    expect(request.place).toBeUndefined()
  })
})
