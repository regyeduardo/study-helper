import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import 'fake-indexeddb/auto'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

import type { ShareRecord } from '@/types/domain'
import { ShareDialog } from '@/components/dialogs/ShareDialog'
import { env } from '@/lib/env'
import { LocalRepository } from '@/lib/storage/local-repository'
import { type Account, LOCAL_ACCOUNT, useAccountStore } from '@/stores/account'
import { useLibraryStore } from '@/stores/library'
import { useUiStore } from '@/stores/ui'
import { dateTime } from '@/utils/format'

import { installMemoryStorage } from '../storage/fake-drive'

const GOOGLE: Account = { id: 'google-1', kind: 'google', name: 'Ana', email: 'ana@example.com', picture: '', token: { accessToken: 'at-1', expiresAt: Date.now() + 3600_000 } }
const DAY = 24 * 3600_000

let posts = 0

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

async function noteShared(expiresAt: string) {
  const library = useLibraryStore.getState()
  const meta = await library.createFile({ name: 'Frações', type: 'class' }, '# Frações\n\nMetade é 1/2.')
  const record: ShareRecord = { id: 'LinkAntigoLinkAntigo12', kind: 'file', itemId: meta.id, title: 'Frações', bytes: 300, withExams: false, createdAt: new Date(Date.now() - DAY).toISOString(), expiresAt }
  await library.saveShare(record)
  return meta.id
}

const open = (id: string) => render(<MemoryRouter><ShareDialog target="file" id={id} /></MemoryRouter>)

beforeEach(async () => {
  installMemoryStorage()
  env.shareWorkerUrl = 'https://share.test'
  env.sharedFilesUrl = 'https://files.test'
  env.turnstileSiteKey = '1x00000000000000000000AA'
  posts = 0
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string, init: RequestInit = {}) => {
      if (`${init.method ?? 'GET'} ${String(input)}` === 'POST https://share.test/shares') return json({ id: `LinkNovoLinkNovoLink${++posts}0`, createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 3 * DAY).toISOString(), bytes: 300 }, 201)
      return new Response('not found', { status: 404 })
    }),
  )
  window.turnstile = { render: (_element, options) => (options.callback('turnstile-ok'), 'widget-1'), remove: vi.fn() }
  useUiStore.setState({ overlay: null, toasts: [] })
  const repo = new LocalRepository(`study-helper-share-again-${crypto.randomUUID()}`)
  const snapshot = await repo.load()
  useLibraryStore.setState({ repo, index: snapshot.index, folders: [], files: [], opened: {}, ready: true, loadError: null })
  useAccountStore.setState({ accounts: [LOCAL_ACCOUNT, GOOGLE], activeId: GOOGLE.id, reconnectId: null })
})

afterEach(() => {
  vi.unstubAllGlobals()
  delete window.turnstile
  useAccountStore.setState({ activeId: LOCAL_ACCOUNT.id })
})

describe('compartilhar de novo o que já está compartilhado', () => {
  it('com o link ainda no prazo: mostra o link que já existe, para copiar, sem criar outro', async () => {
    const id = await noteShared(new Date(Date.now() + 2 * DAY).toISOString())
    open(id)
    expect(await screen.findByText(/Já compartilhado/)).toBeInTheDocument()
    expect(screen.getByDisplayValue('https://share.test/s/LinkAntigoLinkAntigo12')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Copiar link' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^Compartilhar$/ })).not.toBeInTheDocument()
    expect(posts).toBe(0)
  })

  it('diz quando foi compartilhado e até quando vale; "Copiar link" é a ação principal e "Renovar" fica ao lado de "Fechar"', async () => {
    const id = await noteShared(new Date(Date.now() + 2 * DAY).toISOString())
    const [record] = useLibraryStore.getState().index.shares
    const timeZone = useLibraryStore.getState().index.settings.timezone
    open(id)
    const state = (await screen.findByText('Já compartilhado')).closest('p')
    expect(state).toHaveTextContent(`Já compartilhado em ${dateTime(record.createdAt, timeZone)}. Vale até ${dateTime(record.expiresAt, timeZone)} e mostra a versão daquele dia.`)
    expect(screen.getByText(/^“Renovar” cria outro link/)).toHaveTextContent('“Renovar” cria outro link, com a versão de agora, por mais 3 dias. Este continua valendo até vencer.')
    expect(screen.getByRole('button', { name: 'Copiar link' })).toHaveClass('primary')
    expect(screen.getByRole('button', { name: 'Renovar' })).not.toHaveClass('primary')
  })

  it('"Renovar" compartilha a versão de agora num link novo, de mais 3 dias, e o antigo continua até vencer', async () => {
    const id = await noteShared(new Date(Date.now() + 2 * DAY).toISOString())
    open(id)
    fireEvent.click(await screen.findByRole('button', { name: 'Renovar' }))
    const share = await screen.findByRole('button', { name: /^Compartilhar$/ })
    await waitFor(() => expect(share).toBeEnabled())
    fireEvent.click(share)
    expect(await screen.findByDisplayValue('https://share.test/s/LinkNovoLinkNovoLink10')).toBeInTheDocument()
    expect(posts).toBe(1)
    expect(useLibraryStore.getState().index.shares.map(share => share.id)).toEqual(['LinkNovoLinkNovoLink10', 'LinkAntigoLinkAntigo12'])
  })

  it('com o link vencido: abre direto para compartilhar, como da primeira vez', async () => {
    const id = await noteShared(new Date(Date.now() - DAY).toISOString())
    open(id)
    expect(await screen.findByRole('button', { name: /^Compartilhar$/ })).toBeInTheDocument()
    expect(screen.queryByText(/Já compartilhado/)).not.toBeInTheDocument()
  })
})
