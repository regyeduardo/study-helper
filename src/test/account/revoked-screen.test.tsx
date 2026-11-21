import '@/test/account/storage-shim'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { fireEvent, render, screen, waitFor } from '@testing-library/react'

const { mockEnv } = vi.hoisted(() => ({ mockEnv: { apiUrl: 'https://api.example.test', basePath: '/' } }))

vi.mock('@/lib/env', () => ({ env: mockEnv }))

import { RevokedScreen, ServerAccountGate } from '@/components/account/RevokedScreen'
import { useServerAccount } from '@/stores/server-account'
import { useUiStore } from '@/stores/ui'

/** Acesso retirado (spec 003, história 1, cenário 11; layout 5·A): a tela ao abrir, com a data e as saídas. */

const revoked = (bytes: number) => ({
  user: { id: 'u1', email: 'ana@exemplo.com', name: 'Ana', photoUrl: null, status: 'revoked', appEnabled: false, admin: false, deleteAt: '2026-12-21T12:00:00Z', hasPassword: false, hasGoogle: true },
  requireCode: true,
  device: { id: 'd1', name: 'Chrome no Linux' },
  space: { notes: bytes, media: 0, reserved: 0, limit: 10737418240, warnAt: 0.9 },
})

function serveMe(body: unknown, status = 200) {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(body), { status })))
}

beforeEach(() => {
  useServerAccount.setState({ me: null, status: 'unknown' })
  useUiStore.setState({ overlay: null, toasts: [] })
  sessionStorage.clear()
  window.history.replaceState(null, '', '/')
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('RevokedScreen', () => {
  it('says what happened, the day everything goes, and the ways out', () => {
    const actions = { onToDrive: vi.fn(), onDownload: vi.fn(), onContinue: vi.fn() }
    render(<RevokedScreen deleteAt="2026-12-21T12:00:00Z" hasData {...actions} />)
    expect(screen.getByRole('heading', { name: 'O acesso desta conta à estrutura do app foi retirado' })).toBeTruthy()
    expect(screen.getByText((_, element) => element?.tagName === 'P' && /será apagado em 21\/12\/2026/.test(element.textContent ?? ''))).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Levar a biblioteca para o Google Drive' }))
    fireEvent.click(screen.getByRole('button', { name: 'Baixar tudo num arquivo' }))
    fireEvent.click(screen.getByRole('button', { name: 'Seguir com Google Drive e Local' }))
    expect(actions.onToDrive).toHaveBeenCalledOnce()
    expect(actions.onDownload).toHaveBeenCalledOnce()
    expect(actions.onContinue).toHaveBeenCalledOnce()
  })

  it('starts with the focus on the title and keeps Tab inside the screen', () => {
    render(<RevokedScreen deleteAt="2026-12-21T12:00:00Z" hasData onToDrive={vi.fn()} onDownload={vi.fn()} onContinue={vi.fn()} />)
    expect(document.activeElement).toBe(screen.getByRole('heading', { name: /foi retirado/ }))
    const first = screen.getByRole('button', { name: 'Levar a biblioteca para o Google Drive' })
    const last = screen.getByRole('button', { name: 'Seguir com Google Drive e Local' })
    last.focus()
    fireEvent.keyDown(last, { key: 'Tab' })
    expect(document.activeElement).toBe(first)
    fireEvent.keyDown(first, { key: 'Tab', shiftKey: true })
    expect(document.activeElement).toBe(last)
  })

  it('with nothing kept in the account, says so and only offers to go on', () => {
    render(<RevokedScreen deleteAt="2026-12-21T12:00:00Z" hasData={false} onToDrive={vi.fn()} onDownload={vi.fn()} onContinue={vi.fn()} />)
    expect(screen.getByText((_, element) => element?.tagName === 'P' && /Nada da sua biblioteca está guardado na conta do Estudo/.test(element.textContent ?? ''))).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Levar a biblioteca para o Google Drive' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Baixar tudo num arquivo' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Seguir com Google Drive e Local' })).toBeTruthy()
  })
})

describe('ServerAccountGate (ao abrir o app)', () => {
  it('asks the server who is signed in and shows the screen when the access was taken away', async () => {
    serveMe(revoked(0))
    render(<ServerAccountGate />)
    expect(await screen.findByRole('heading', { name: 'O acesso desta conta à estrutura do app foi retirado' })).toBeTruthy()
    expect(useServerAccount.getState().status).toBe('signed-in')
  })

  it('"Seguir com Google Drive e Local" closes it until the app is opened again', async () => {
    serveMe(revoked(0))
    const { unmount } = render(<ServerAccountGate />)
    fireEvent.click(await screen.findByRole('button', { name: 'Seguir com Google Drive e Local' }))
    expect(screen.queryByRole('heading', { name: /foi retirado/ })).toBeNull()
    unmount()
    render(<ServerAccountGate />)
    await waitFor(() => expect(useServerAccount.getState().status).toBe('signed-in'))
    expect(screen.queryByRole('heading', { name: /foi retirado/ })).toBeNull()
  })

  it('shows nothing for an account in good standing, nor without a server', async () => {
    serveMe({ ...revoked(0), user: { ...revoked(0).user, status: 'enabled', deleteAt: null } })
    render(<ServerAccountGate />)
    await waitFor(() => expect(useServerAccount.getState().status).toBe('signed-in'))
    expect(screen.queryByRole('heading', { name: /foi retirado/ })).toBeNull()

    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new TypeError('Failed to fetch'))))
    useServerAccount.setState({ me: null, status: 'unknown' })
    render(<ServerAccountGate />)
    await waitFor(() => expect(useServerAccount.getState().status).toBe('offline'))
    expect(screen.queryByRole('heading', { name: /foi retirado/ })).toBeNull()
  })

  it('back from a failed Google sign-in, tells why in a notice', async () => {
    serveMe({ error: 'no_session' }, 401)
    window.history.replaceState(null, '', '/biblioteca?login=refused')
    render(<ServerAccountGate />)
    await waitFor(() => expect(useUiStore.getState().toasts.map(toast => toast.text)).toContain('Você não autorizou no Google. Nada mudou.'))
    expect(window.location.search).toBe('')
  })
})
