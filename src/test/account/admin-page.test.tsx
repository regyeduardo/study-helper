import '@/test/account/storage-shim'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

const { mockEnv } = vi.hoisted(() => ({ mockEnv: { apiUrl: 'https://api.example.test', basePath: '/' } }))

vi.mock('@/lib/env', () => ({ env: mockEnv }))

import AdminPage from '@/pages/admin'
import { useServerAccount } from '@/stores/server-account'
import { useUiStore } from '@/stores/ui'

/** Administração (spec 003, história 1, FR-005, FR-058, SC-013; T052; layout 4·A). */

const user = (admin: boolean) => ({ id: 'u1', email: 'dono@exemplo.com', name: 'Dono', photoUrl: null, status: 'enabled', appEnabled: true, admin, deleteAt: null, hasPassword: false, hasGoogle: true })
const me = (admin: boolean) => ({ user: user(admin), requireCode: true, device: { id: 'd1', name: 'Chrome no Linux' }, space: { notes: 0, media: 0, reserved: 0, limit: 10737418240, warnAt: 0.9 } })

const CODES = [
  { id: 'c1', code: 'K7QM3XRT9PWD', maxUses: 3, uses: 1, validUntil: '2026-12-21T00:00:00Z', madeFor: 'Turma de inglês da noite', status: 'active', createdAt: '2026-11-21T10:00:00Z', accounts: [{ id: 'a1', name: 'Ana Souza', email: 'ana@exemplo.com', usedAt: '2026-11-21T11:00:00Z' }] },
  { id: 'c2', code: 'P2VN8HJA4KXE', maxUses: 1, uses: 1, validUntil: '2026-12-10T00:00:00Z', madeFor: 'Primo do Rafael', status: 'used-up', createdAt: '2026-11-20T10:00:00Z', accounts: [{ id: 'a2', name: 'Rafael Lima', email: 'rafa@exemplo.com', usedAt: '2026-11-20T12:00:00Z' }] },
  { id: 'c3', code: '4HJE9WTPKQ2M', maxUses: 1, uses: 0, validUntil: '2026-11-01T00:00:00Z', madeFor: '', status: 'expired', createdAt: '2026-10-01T10:00:00Z', accounts: [] },
]

const ACCOUNTS = [
  { id: 'a1', name: 'Ana Souza', email: 'ana@exemplo.com', status: 'enabled', appEnabled: true, enabledAt: '2026-11-21T11:00:00Z', deleteAt: null, code: 'K7QM3XRT9PWD', seenAt: '2026-11-21T11:30:00Z', space: { notes: 2 * 1024 * 1024, media: 1024 * 1024 * 1024, limit: 10737418240 } },
  { id: 'a3', name: 'Caio Prado', email: 'caio@exemplo.com', status: 'no-code', appEnabled: false, enabledAt: null, deleteAt: null, code: null, seenAt: null, space: { notes: 0, media: 0, limit: 10737418240 } },
]

type Call = { method: string; path: string; body: unknown }
let calls: Call[]
let codes: typeof CODES
let requireCode: boolean

function serve(admin: boolean | null) {
  calls = []
  codes = CODES.map(code => ({ ...code }))
  requireCode = true
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit = {}) => {
      const path = url.replace(mockEnv.apiUrl, '')
      const method = init.method ?? 'GET'
      const body = init.body ? JSON.parse(String(init.body)) : undefined
      calls.push({ method, path, body })
      const json = (status: number, value: unknown) => new Response(JSON.stringify(value), { status })
      if (path === '/v1/me') return admin === null ? json(401, { error: 'no_session' }) : json(200, me(admin))
      if (!admin) return json(404, { error: 'not_found' })
      if (path === '/v1/admin/codes' && method === 'GET') return json(200, { codes })
      if (path === '/v1/admin/codes' && method === 'POST') {
        const made = { id: 'c9', code: 'ZT6WM3QB7CRY', maxUses: body.maxUses ?? 1, uses: 0, validUntil: `${body.validUntil}T00:00:00Z`, madeFor: body.madeFor ?? '', status: 'active', createdAt: '2026-11-21T12:00:00Z', accounts: [] }
        codes = [made, ...codes]
        return json(201, made)
      }
      if (path === '/v1/admin/codes/c1/cancel') {
        codes = codes.map(code => (code.id === 'c1' ? { ...code, status: 'canceled' } : code))
        return json(200, { ok: true })
      }
      if (path === '/v1/admin/accounts') return json(200, { accounts: ACCOUNTS })
      if (path === '/v1/admin/accounts/a1/revoke') return json(200, { deleteAt: '2026-12-21T12:00:00Z' })
      if (path === '/v1/admin/settings' && method === 'GET') return json(200, { requireCode })
      if (path === '/v1/admin/settings' && method === 'PUT') {
        requireCode = body.requireCode
        return json(200, { requireCode })
      }
      return json(404, { error: 'not_found' })
    }),
  )
}

const adminCalls = () => calls.filter(call => call.path.startsWith('/v1/admin'))

function open() {
  return render(
    <MemoryRouter initialEntries={['/administracao']}>
      <AdminPage />
    </MemoryRouter>,
  )
}

beforeEach(() => {
  useServerAccount.setState({ me: null, status: 'unknown' })
  useUiStore.setState({ overlay: null, toasts: [] })
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

async function confirmOverlay(ok: string) {
  const overlay = useUiStore.getState().overlay
  expect(overlay).toMatchObject({ kind: 'confirm', ok })
  await (overlay as Extract<typeof overlay, { kind: 'confirm' }>).onConfirm()
}

describe('Administração: só a conta de administração', () => {
  it('another account sees "Página não encontrada" and no owner task is asked', async () => {
    serve(false)
    open()
    expect(await screen.findByRole('heading', { name: 'Página não encontrada' })).toBeTruthy()
    expect(screen.queryByText('Códigos')).toBeNull()
    expect(adminCalls()).toEqual([])
  })

  it('nobody signed in sees the same, and nothing is asked', async () => {
    serve(null)
    open()
    expect(await screen.findByRole('heading', { name: 'Página não encontrada' })).toBeTruthy()
    expect(adminCalls()).toEqual([])
  })
})

describe('Administração › Códigos', () => {
  it('lists each code with uses, validity, situation and who used it', async () => {
    serve(true)
    open()
    expect(await screen.findByRole('heading', { name: 'Administração' })).toBeTruthy()
    expect(screen.getByRole('tab', { name: 'Códigos' }).getAttribute('aria-selected')).toBe('true')
    const row = (await screen.findByText('K7QM 3XRT 9PWD')).closest('tr')!
    expect(within(row).getByText('Turma de inglês da noite')).toBeTruthy()
    expect(within(row).getByText('1 de 3')).toBeTruthy()
    expect(within(row).getByText('21/12/2026')).toBeTruthy()
    expect(within(row).getByText('Ativo')).toBeTruthy()
    expect(within(row).getByText('Ana Souza')).toBeTruthy()
    const used = screen.getByText('P2VN 8HJA 4KXE').closest('tr')!
    expect(within(used).getByText('Esgotado')).toBeTruthy()
    expect(within(used).queryByRole('button', { name: /Cancelar/ })).toBeNull()
  })

  it('filters by situation, with the count of each', async () => {
    serve(true)
    open()
    await screen.findByText('K7QM 3XRT 9PWD')
    fireEvent.click(screen.getByRole('button', { name: /Vencidos 1/ }))
    expect(screen.getByText('4HJE 9WTP KQ2M')).toBeTruthy()
    expect(screen.queryByText('K7QM 3XRT 9PWD')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /Todos 3/ }))
    expect(screen.getByText('K7QM 3XRT 9PWD')).toBeTruthy()
  })

  it('creates a code (1 person and 30 days unless changed) and offers to copy it', async () => {
    serve(true)
    open()
    await screen.findByText('K7QM 3XRT 9PWD')
    expect((screen.getByLabelText('Pessoas') as HTMLInputElement).value).toBe('1')
    const until = screen.getByLabelText('Vale até') as HTMLInputElement
    const expected = new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10)
    expect(until.value).toBe(expected)
    fireEvent.change(screen.getByLabelText('Para quem (opcional)'), { target: { value: 'Grupo do mestrado' } })
    fireEvent.change(screen.getByLabelText('Pessoas'), { target: { value: '10' } })
    fireEvent.change(until, { target: { value: '2027-01-02' } })
    fireEvent.click(screen.getByRole('button', { name: 'Criar código' }))
    await waitFor(() => expect(calls.some(call => call.method === 'POST' && call.path === '/v1/admin/codes')).toBe(true))
    expect(calls.find(call => call.method === 'POST')!.body).toEqual({ madeFor: 'Grupo do mestrado', maxUses: 10, validUntil: '2027-01-02' })
    const made = await screen.findByRole('status', { name: 'Código criado' })
    expect(within(made).getByText('ZT6W M3QB 7CRY')).toBeTruthy()
    expect(within(made).getByRole('button', { name: 'Copiar' })).toBeTruthy()
    expect(screen.getAllByText('ZT6W M3QB 7CRY').length).toBeGreaterThan(1)
  })

  it('cancels an active code only after confirming', async () => {
    serve(true)
    open()
    const row = (await screen.findByText('K7QM 3XRT 9PWD')).closest('tr')!
    fireEvent.click(within(row).getByRole('button', { name: 'Cancelar o código K7QM 3XRT 9PWD' }))
    expect(calls.some(call => call.path.endsWith('/cancel'))).toBe(false)
    await confirmOverlay('Cancelar o código')
    await waitFor(() => expect(within(screen.getByText('K7QM 3XRT 9PWD').closest('tr')!).getByText('Cancelado')).toBeTruthy())
    expect(calls.some(call => call.method === 'POST' && call.path === '/v1/admin/codes/c1/cancel')).toBe(true)
  })
})

describe('Administração › Contas', () => {
  it('lists the accounts and takes the access away after confirming, with the date of deletion', async () => {
    serve(true)
    open()
    await screen.findByText('K7QM 3XRT 9PWD')
    fireEvent.click(screen.getByRole('tab', { name: 'Contas' }))
    const row = (await screen.findByText('ana@exemplo.com')).closest('tr')!
    expect(within(row).getByText('Liberada')).toBeTruthy()
    expect(within(row).getByText(/1 GB/)).toBeTruthy()
    const other = screen.getByText('caio@exemplo.com').closest('tr')!
    expect(within(other).getByText('Sem código')).toBeTruthy()
    fireEvent.click(within(row).getByRole('button', { name: 'Retirar o acesso de Ana Souza' }))
    await confirmOverlay('Retirar o acesso')
    await waitFor(() => expect(within(screen.getByText('ana@exemplo.com').closest('tr')!).getByText(/Acesso retirado/)).toBeTruthy())
    expect(within(screen.getByText('ana@exemplo.com').closest('tr')!).getByText(/21\/12\/2026/)).toBeTruthy()
  })
})

describe('Administração › Configuração', () => {
  it('turns the code requirement off and on', async () => {
    serve(true)
    open()
    await screen.findByText('K7QM 3XRT 9PWD')
    fireEvent.click(screen.getByRole('tab', { name: 'Configuração' }))
    const toggle = (await screen.findByRole('switch', { name: 'Exigir código para usar a estrutura do app' })) as HTMLButtonElement
    expect(toggle.getAttribute('aria-checked')).toBe('true')
    fireEvent.click(toggle)
    await waitFor(() => expect(toggle.getAttribute('aria-checked')).toBe('false'))
    expect(calls.find(call => call.method === 'PUT')!.body).toEqual({ requireCode: false })
  })
})

describe('Administração › teclado', () => {
  it('the tabs move with the arrow keys, and only the open one is in the Tab order', async () => {
    serve(true)
    open()
    await screen.findByText('K7QM 3XRT 9PWD')
    const codes = screen.getByRole('tab', { name: 'Códigos' })
    expect(codes.tabIndex).toBe(0)
    expect(screen.getByRole('tab', { name: 'Contas' }).tabIndex).toBe(-1)
    fireEvent.keyDown(codes, { key: 'ArrowRight' })
    const accounts = screen.getByRole('tab', { name: 'Contas' })
    expect(accounts.getAttribute('aria-selected')).toBe('true')
    expect(document.activeElement).toBe(accounts)
    fireEvent.keyDown(accounts, { key: 'End' })
    expect(screen.getByRole('tab', { name: 'Configuração' }).getAttribute('aria-selected')).toBe('true')
    fireEvent.keyDown(screen.getByRole('tab', { name: 'Configuração' }), { key: 'ArrowRight' })
    expect(screen.getByRole('tab', { name: 'Códigos' }).getAttribute('aria-selected')).toBe('true')
  })
})
