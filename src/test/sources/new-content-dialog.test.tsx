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
  it('lists every host that fits with its expiry and defaults to OnlyFiles on Local', async () => {
    const group = await openWithFile(sizedFile('notes.txt', 20))
    const names = group.getAllByRole('radio').map(radio => radio.querySelector('b')!.textContent)
    expect(names).toEqual(['Google Drive', 'Gofile', 'Litterbox (temporário)', 'filebin', 'tmpfiles', 'OnlyFiles', 'Não guardar'])
    expect(group.getByText(/10 dias sem ninguém baixar/)).toBeInTheDocument()
    expect(group.getByText(/1 h a 72 h/)).toBeInTheDocument()
    expect(group.getByText(/fica 7 dias/i)).toBeInTheDocument()
    expect(group.getByText(/fica 1 hora/i)).toBeInTheDocument()
    expect(group.getByText(/Fica para sempre, mas o OnlyFiles pode apagar por falta de espaço/)).toBeInTheDocument()
    expect(checkedName(group)).toBe('OnlyFiles')
    expect(group.getByText('Entre com o Google para guardar no Drive.')).toBeInTheDocument()
    expect(screen.getByText(/Serviço de terceiro, sem garantia de guardar/)).toBeInTheDocument()
  })

  it('hides hosts where the file does not fit and says which ones', async () => {
    const group = await openWithFile(sizedFile('lecture.txt', 150 * MB))
    const names = group.getAllByRole('radio').map(radio => radio.querySelector('b')!.textContent)
    expect(names).not.toContain('tmpfiles')
    expect(names).not.toContain('OnlyFiles')
    expect(names).toContain('Litterbox (temporário)')
    expect(screen.getByText(/Não cabem .*: tmpfiles, OnlyFiles\./)).toBeInTheDocument()
    expect(checkedName(group)).toBe('Gofile')
  })

  it('defaults to Litterbox between 200 MB and 1 GB on Local', async () => {
    const group = await openWithFile(sizedFile('lecture.txt', 500 * MB))
    expect(checkedName(group)).toBe('Litterbox (temporário)')
    expect(screen.getByLabelText('Prazo do Litterbox')).toBeInTheDocument()
  })

  it('defaults to Gofile above 1 GB on Local and hides Litterbox', async () => {
    const group = await openWithFile(sizedFile('lecture.txt', 2 * GB))
    const names = group.getAllByRole('radio').map(radio => radio.querySelector('b')!.textContent)
    expect(names).not.toContain('Litterbox (temporário)')
    expect(checkedName(group)).toBe('Gofile')
  })

  it('defaults to Drive when logged in, without the third-party warning', async () => {
    useAccountStore.setState({ accounts: [LOCAL_ACCOUNT, GOOGLE], activeId: GOOGLE.id })
    const group = await openWithFile(sizedFile('lecture.txt', 5 * GB))
    expect(checkedName(group)).toBe('Google Drive')
    expect(screen.queryByText(/Serviço de terceiro/)).toBeNull()
  })

  it('passes the chosen host and Litterbox expiry to the generation', async () => {
    const group = await openWithFile(sizedFile('lecture.txt', 20))
    fireEvent.click(group.getByText('Litterbox (temporário)'))
    fireEvent.change(screen.getByLabelText('Prazo do Litterbox'), { target: { value: '1h' } })
    fireEvent.click(screen.getByRole('button', { name: 'Gerar aula' }))
    await waitFor(() => expect(startNewContent).toHaveBeenCalled())
    expect(startNewContent.mock.calls[0][0]).toMatchObject({ storage: 'litterbox', litterboxTime: '1h' })
  })

  it('does not let Drive be picked while logged out', async () => {
    const group = await openWithFile(sizedFile('lecture.txt', 20))
    fireEvent.click(group.getByText('Google Drive'))
    expect(checkedName(group)).toBe('OnlyFiles')
  })
})
