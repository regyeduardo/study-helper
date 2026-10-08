import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

const { startNewContent } = vi.hoisted(() => ({ startNewContent: vi.fn(async (..._args: unknown[]) => null) }))

vi.mock('@/stores/jobs', async () => {
  const { create } = await import('zustand')
  return { useJobsStore: create(() => ({ jobs: [], startNewContent })) }
})

import { RecordDialog, RecordingDoneDialog } from '@/components/dialogs/RecordDialogs'
import { LOCAL_ACCOUNT, useAccountStore } from '@/stores/account'
import { useRecorderStore } from '@/stores/recorder'
import { useIntegrationStore } from '@/lib/recording/integration'
import { installIntegration } from '@/test/recording/integration-fakes'
import { installMediaEnvironment } from '@/test/recording/media-fakes'
import type { SourceStorage } from '@/types/domain'

const GOOGLE = { id: 'g-1', kind: 'google' as const, name: 'Ana', email: 'ana@example.com', picture: '' }
const OTHERS = /Gofile|Litterbox|filebin|tmpfiles|OnlyFiles/

function recording(destination: SourceStorage) {
  const file = new File(['x'], 'Reunião.webm', { type: 'video/webm' })
  return { file, mime: 'video/webm;codecs=vp9,opus', durationSeconds: 65, storedName: 'gravacao-1.webm', destination }
}

function renderDone() {
  render(
    <MemoryRouter>
      <RecordingDoneDialog />
    </MemoryRouter>,
  )
}

const checked = () =>
  screen
    .getAllByRole('radio')
    .filter(radio => radio.getAttribute('aria-checked') === 'true')
    .map(radio => radio.textContent ?? '')

beforeEach(() => {
  installMediaEnvironment()
  installIntegration({ available: false })
  useIntegrationStore.setState({ status: 'unknown', hello: null })
  startNewContent.mockClear()
  useAccountStore.setState({ accounts: [LOCAL_ACCOUNT, GOOGLE], activeId: GOOGLE.id })
  useRecorderStore.setState({ active: false, seconds: 0, mode: null, result: null, resultPlace: 'dialog', floating: null, live: null, error: null })
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('where the recording goes, chosen before recording', () => {
  it('offers only this computer and Google Drive, and starts with the chosen place and screen rate', async () => {
    const start = vi.fn(async () => undefined)
    useRecorderStore.setState({ start })
    render(<RecordDialog />)
    await screen.findByText('Onde salvar')
    const place = within('Onde salvar')
    expect(place.map(radio => radio.querySelector('b')!.textContent)).toEqual(['Neste computador', 'Google Drive'])
    fireEvent.click(screen.getByRole('radio', { name: /Google Drive/ }))
    fireEvent.click(screen.getByRole('radio', { name: /5 fps/ }))
    fireEvent.click(screen.getByRole('button', { name: /Começar a gravar/ }))
    await waitFor(() => expect(start).toHaveBeenCalledWith('tab', 'auto', expect.objectContaining({ destination: 'drive', video: { fps: 5 } })))
  })

  it('without Google, Drive cannot be chosen and the place is this computer', async () => {
    useAccountStore.setState({ accounts: [LOCAL_ACCOUNT], activeId: LOCAL_ACCOUNT.id })
    const start = vi.fn(async () => undefined)
    useRecorderStore.setState({ start })
    render(<RecordDialog />)
    expect(await screen.findByRole('radio', { name: /Google Drive/ })).toHaveAttribute('aria-disabled', 'true')
    fireEvent.click(screen.getByRole('button', { name: /Começar a gravar/ }))
    await waitFor(() => expect(start).toHaveBeenCalledWith('tab', 'auto', expect.objectContaining({ destination: 'none', video: null })))
  })

  it('the end screen comes with the place chosen before, and lets you change it', async () => {
    useRecorderStore.setState({ result: recording('none') })
    renderDone()
    expect(checked().some(text => text.startsWith('Não, só neste computador'))).toBe(true)
    expect(screen.queryByText(OTHERS)).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('radio', { name: /Google Drive/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Transcrever e gerar' }))
    await waitFor(() => expect(startNewContent).toHaveBeenCalled())
    expect(startNewContent.mock.calls[0][0]).toMatchObject({ storage: 'drive' })
  })

  it('Drive chosen before comes already marked at the end', () => {
    useRecorderStore.setState({ result: recording('drive') })
    renderDone()
    expect(checked().some(text => text.startsWith('Google Drive'))).toBe(true)
  })
})

function within(label: string): HTMLElement[] {
  const field = screen.getByText(label).closest('.field')!
  return [...field.querySelectorAll<HTMLElement>('[role=radio]')]
}
