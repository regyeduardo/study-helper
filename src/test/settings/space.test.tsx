// Spec 007, história 5 (T124, T126): o espaço da conta no App em Configurações › Armazenamento (notas, mídia, Lixeira, quanto falta),
// o aviso a partir de 9 GB, "Liberar espaço" com os maiores primeiro (escolha C) e as ações; ao guardar, o motivo e as saídas no limite.
import '@/test/account/storage-shim'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'

import { AccountSpace } from '@/components/dialogs/AccountSpace'
import { ApiError } from '@/controllers/api.controller'
import { env } from '@/lib/env'
import { AppSpaceFullError } from '@/lib/storage/repository'
import { uploadMedia } from '@/lib/storage/uploads'
import { useLibraryStore } from '@/stores/library'
import { useUiStore } from '@/stores/ui'

const GB = 1024 ** 3
const API = 'https://api.test'
let space: Record<string, number | null>
let largest: unknown[]

beforeEach(() => {
  env.apiUrl = API
  space = { notes: 1 * GB, media: 3 * GB, trash: 0.5 * GB, reserved: 0, used: 4.5 * GB, limit: 10 * GB, free: 5.5 * GB, warnAt: 9 * GB, checkedAt: null }
  largest = [
    { id: 'v1', name: 'Reunião longa', kind: 'file', noteType: 'video', noteBytes: 1000, mediaBytes: 2 * GB, trashed: false, folderPath: 'Biblioteca › Reuniões' },
    { id: 'n9', name: 'Nota velha', kind: 'file', noteType: 'explanation', noteBytes: 5000, mediaBytes: 0, trashed: true, folderPath: 'Biblioteca' },
  ]
  vi.stubGlobal('fetch', vi.fn(async (input: string) => {
    const url = String(input)
    const body = url.endsWith('/v1/space') ? space : url.endsWith('/v1/space/largest') ? { items: largest } : { error: 'not_found' }
    return new Response(JSON.stringify(body), { status: url.includes('/v1/space') ? 200 : 404, headers: { 'Content-Type': 'application/json' } })
  }))
  useUiStore.setState({ toasts: [] })
})
afterEach(() => vi.unstubAllGlobals())

describe('o espaço no App', () => {
  it('mostra notas, mídia, Lixeira e quanto falta', async () => {
    render(<AccountSpace onMove={vi.fn()} />)
    expect(await screen.findByText(/faltam 5,5 GB/)).toBeInTheDocument()
    expect(screen.getByText('Notas').closest('li')).toHaveTextContent('1 GB')
    expect(screen.getByText('Mídia').closest('li')).toHaveTextContent('3 GB')
    expect(screen.getByText('Lixeira').closest('li')).toHaveTextContent('512 MB')
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('a partir de 9 GB avisa; no limite diz o motivo e as saídas', async () => {
    space = { ...space, used: 9.3 * GB, free: 0.7 * GB }
    const { unmount } = render(<AccountSpace onMove={vi.fn()} />)
    expect(await screen.findByText(/quase cheio: faltam 716,8 MB/)).toBeInTheDocument()
    unmount()
    space = { ...space, used: 10 * GB, free: 0 }
    render(<AccountSpace onMove={vi.fn()} />)
    expect(await screen.findByRole('alert')).toHaveTextContent('guarde no Google Drive ou em Local, ou libere espaço')
  })

  it('"Liberar espaço" lista os maiores primeiro, com as ações de cada um', async () => {
    const onMove = vi.fn()
    const removeMedia = vi.fn(async () => undefined)
    const trashFiles = vi.fn(async () => undefined)
    const emptyTrash = vi.fn(async () => undefined)
    useLibraryStore.setState({ removeMedia, trashFiles, emptyTrash } as never)
    render(<AccountSpace onMove={onMove} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Liberar espaço' }))
    const list = await screen.findByLabelText('O que mais ocupa no App')
    const rows = within(list).getAllByRole('listitem')
    expect(rows[0]).toHaveTextContent('Reunião longa')
    expect(rows[0]).toHaveTextContent('Biblioteca › Reuniões')
    fireEvent.click(within(rows[0]).getByRole('button', { name: 'Mover…' }))
    expect(onMove).toHaveBeenCalledWith('v1')
    fireEvent.click(within(rows[0]).getByRole('button', { name: 'Apagar só a mídia' }))
    await waitFor(() => expect(removeMedia).toHaveBeenCalledWith('v1'))
    // the one in the Lixeira has no "Apagar" nor media to take out
    expect(within(rows[1]).queryByRole('button', { name: 'Apagar' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /Esvaziar a Lixeira/ }))
    await waitFor(() => expect(emptyTrash).toHaveBeenCalled())
  })
})

describe('ao guardar no App', () => {
  it('no limite, o envio para com o motivo e as saídas', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'no_space', missing: 300 * 1024 ** 2, free: 0 }), { status: 413, headers: { 'Content-Type': 'application/json' } })))
    const sending = uploadMedia({ item: 'n1', media: 'm1', file: new Blob(['x'.repeat(10)]), name: 'r.webm', mime: 'audio/webm' })
    await expect(sending).rejects.toBeInstanceOf(AppSpaceFullError)
    await expect(sending).rejects.toThrow('Guarde no Google Drive ou em Local, ou libere espaço')
  })

  it('perto do limite, diz quanto falta', async () => {
    space = { ...space, used: 9.5 * GB, free: 0.5 * GB }
    const { warnNearLimit } = await import('@/lib/storage/uploads')
    await warnNearLimit()
    expect(useUiStore.getState().toasts.map(toast => toast.text)).toContain('O App da sua conta está quase cheio: faltam 512 MB.')
  })
})

void ApiError
