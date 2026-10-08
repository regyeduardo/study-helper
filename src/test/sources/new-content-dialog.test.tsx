import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

const { startNewContent } = vi.hoisted(() => ({ startNewContent: vi.fn(async (..._args: unknown[]) => null) }))

vi.mock('@/lib/transcription', () => ({ ENGINES: [{ id: 'groq', name: 'Groq', where: 'cloud', limits: 'limits' }] }))
vi.mock('@/stores/jobs', async () => {
  const { create } = await import('zustand')
  return { useJobsStore: create(() => ({ jobs: [], cancel: vi.fn(), startNewContent })) }
})

import { NewContentDialog } from '@/components/dialogs/NewContentDialog'
import { LOCAL_ACCOUNT, useAccountStore } from '@/stores/account'
import { useSyncStore } from '@/stores/sync'
import { installBlobShim } from '@/test/imports/blob-shim'

installBlobShim()

const MB = 1024 * 1024
const GB = 1024 * MB
const GOOGLE = { id: 'g-1', kind: 'google' as const, name: 'Ana Souza', email: 'ana@example.com', picture: '', token: { accessToken: 'a', expiresAt: Date.now() + 3600_000 } }

function sizedFile(name: string, size: number): File {
  const file = new File(['hello world'], name, { type: 'text/plain' })
  Object.defineProperty(file, 'size', { value: size })
  return file
}

async function openWithFile(file: File) {
  render(
    <MemoryRouter>
      <NewContentDialog />
    </MemoryRouter>,
  )
  fireEvent.click(screen.getByRole('button', { name: /Arquivo/ }))
  const input = document.getElementById('nc-file') as HTMLInputElement
  fireEvent.change(input, { target: { files: [file] } })
  await screen.findByText('Onde guardar o arquivo original')
  return within(screen.getAllByRole('radiogroup')[0])
}

function checkedName(group: ReturnType<typeof within>): string {
  return group.getAllByRole('radio').find((radio: HTMLElement) => radio.getAttribute('aria-checked') === 'true')!.querySelector('b')!.textContent!
}

beforeEach(() => {
  startNewContent.mockClear()
  useSyncStore.setState({ usage: null })
  useAccountStore.setState({ accounts: [LOCAL_ACCOUNT], activeId: LOCAL_ACCOUNT.id })
})

describe('NewContentDialog storage choice', () => {
  it('offers only Google Drive and not keeping, and keeps nothing on Local by default', async () => {
    const group = await openWithFile(sizedFile('notes.txt', 20))
    const names = group.getAllByRole('radio').map(radio => radio.querySelector('b')!.textContent)
    expect(names).toEqual(['Google Drive', 'Não guardar'])
    expect(checkedName(group)).toBe('Não guardar')
    expect(group.getByText('Entre com o Google para guardar no Drive.')).toBeInTheDocument()
    expect(screen.queryByText(/Serviço de terceiro/)).toBeNull()
  })

  it('for a video, the option without cloud says it stays in Mídias, on this computer', async () => {
    const group = await openWithFile(sizedFile('aula.mp4', 20))
    expect(await group.findByText('Só neste computador')).toBeInTheDocument()
    expect(group.queryByText('Não guardar')).not.toBeInTheDocument()
    expect(group.getByText(/Fica em Mídias, neste navegador/)).toBeInTheDocument()
  })

  it('defaults to Drive when logged in, without the third-party warning', async () => {
    useAccountStore.setState({ accounts: [LOCAL_ACCOUNT, GOOGLE], activeId: GOOGLE.id })
    const group = await openWithFile(sizedFile('lecture.txt', 5 * GB))
    expect(checkedName(group)).toBe('Google Drive')
    expect(screen.queryByText(/Serviço de terceiro/)).toBeNull()
  })

  it('does not let Drive be picked while logged out', async () => {
    const group = await openWithFile(sizedFile('lecture.txt', 20))
    fireEvent.click(group.getByText('Google Drive'))
    expect(checkedName(group)).toBe('Não guardar')
  })
})
