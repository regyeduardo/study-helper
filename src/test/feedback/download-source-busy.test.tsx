import { act, fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { MemoryRouter } from 'react-router-dom'

const { download } = vi.hoisted(() => ({ download: { calls: 0, current: null as null | { resolve(blob: Blob): void; reject(error: Error): void } } }))

vi.mock('@/lib/storage/source-storage', async importOriginal => ({
  ...(await importOriginal<typeof import('@/lib/storage/source-storage')>()),
  downloadStoredSource: vi.fn(
    () =>
      new Promise<Blob>((resolve, reject) => {
        download.calls++
        download.current = { resolve, reject }
      }),
  ),
}))
vi.mock('@/utils/download', async importOriginal => ({ ...(await importOriginal<typeof import('@/utils/download')>()), downloadBlob: vi.fn() }))

import { InfoPanel } from '@/components/reader/Inspector'
import { Toasts } from '@/components/ui/Toasts'
import { useLibraryStore } from '@/stores/library'
import { settle, slowLibrary } from '@/test/feedback/slow'
import { downloadBlob } from '@/utils/download'

// "Baixar a fonte" brings a file from the Drive: the button must show it is working.

let id: string

beforeEach(async () => {
  slowLibrary()
  download.calls = 0
  vi.mocked(downloadBlob).mockClear()
  const origin = { input: 'file' as const, name: 'contrato.pdf', mime: 'application/pdf', sizeBytes: 9, storage: 'drive' as const, storedFileId: 'drv-1', expiresAt: null }
  id = (await useLibraryStore.getState().createFile({ name: 'Contrato', type: 'reading', status: 'ready', folderId: null, origin }, 'texto')).id
})

const open = () =>
  render(
    <MemoryRouter>
      <InfoPanel fileId={id} />
      <Toasts />
    </MemoryRouter>,
  )

describe('Baixar a fonte', () => {
  it('no clique o botão vira "Baixando…", fica desligado e o clique repetido não baixa de novo', async () => {
    open()
    fireEvent.click(await screen.findByRole('button', { name: 'Baixar a fonte' }))
    const busy = screen.getByRole('button', { name: /Baixando/ })
    expect(busy).toBeDisabled()
    expect(busy.querySelector('.spinning')).not.toBeNull()
    fireEvent.click(busy)
    expect(download.calls).toBe(1)

    await act(async () => {
      download.current!.resolve(new Blob(['x']))
      await settle()
    })
    expect(downloadBlob).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('button', { name: 'Baixar a fonte' })).toBeEnabled()
  })

  it('se não deu para baixar, o botão volta e um aviso diz o motivo', async () => {
    open()
    fireEvent.click(await screen.findByRole('button', { name: 'Baixar a fonte' }))
    await act(async () => {
      download.current!.reject(new Error('O Drive não respondeu.'))
      await settle()
    })
    expect(screen.getByRole('button', { name: 'Baixar a fonte' })).toBeEnabled()
    expect(screen.getByText('O Drive não respondeu.')).toBeInTheDocument()
  })
})
