import '@/test/account/storage-shim'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { SignInDialog } from '@/components/dialogs/SignIn'
import { page } from '@/controllers/google-redirect.controller'
import { useServerAccount } from '@/stores/server-account'

const ME = {
  user: { id: 'u1', email: 'ana@exemplo.com', name: 'Ana', photoUrl: null, status: 'no-code', appEnabled: false, admin: false, deleteAt: null, hasPassword: true, hasGoogle: false },
  requireCode: true,
  device: { id: 'd1', name: 'Chrome no Linux' },
  space: { notes: 0, media: 0, reserved: 0, limit: 10737418240, warnAt: 0.9 },
}

type Call = { method: string; path: string; body: unknown }
let calls: Call[] = []

function serve(route: (call: Call) => { status: number; body?: unknown }) {
  calls = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit = {}) => {
      const call = { method: init.method ?? 'GET', path: new URL(url).pathname, body: init.body ? JSON.parse(String(init.body)) : undefined }
      calls.push(call)
      const next = route(call)
      return new Response(next.body === undefined ? null : JSON.stringify(next.body), { status: next.status })
    }),
  )
}

beforeEach(() => useServerAccount.setState({ me: null, status: 'signed-out' }))
afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('Entrar no Estudo (opção C: tudo à vista)', () => {
  it('shows Google, "ou", e-mail and password at once', () => {
    render(<SignInDialog onClose={() => {}} onDone={() => {}} />)
    const dialog = screen.getByRole('dialog', { name: 'Entrar no Estudo' })
    expect(within(dialog).getByRole('button', { name: 'Entrar com o Google' })).toBeInTheDocument()
    expect(within(dialog).getByText('ou')).toBeInTheDocument()
    expect(within(dialog).getByLabelText('E-mail')).toBeInTheDocument()
    expect(within(dialog).getByLabelText('Senha')).toBeInTheDocument()
    expect(within(dialog).getByRole('button', { name: 'Entrar' })).toBeInTheDocument()
  })

  it('goes to Google in this same tab, coming back to where the person was', async () => {
    const go = vi.spyOn(page, 'go').mockImplementation(() => undefined)
    window.history.replaceState(null, '', '/biblioteca?x=1')
    render(<SignInDialog onClose={() => {}} onDone={() => {}} />)
    await userEvent.click(screen.getByRole('button', { name: 'Entrar com o Google' }))
    expect(go).toHaveBeenCalledTimes(1)
    const url = new URL(go.mock.calls[0][0])
    expect(url.pathname).toBe('/v1/auth/google/start')
    expect(url.searchParams.get('return_to')).toBe('/biblioteca?x=1')
  })

  it('signs in with e-mail and password', async () => {
    serve(call => (call.path === '/v1/auth/password/login' ? { status: 200, body: { user: { id: 'u1', email: 'ana@exemplo.com' } } } : { status: 200, body: ME }))
    const done = vi.fn()
    render(<SignInDialog onClose={() => {}} onDone={done} />)
    await userEvent.type(screen.getByLabelText('E-mail'), 'ana@exemplo.com')
    await userEvent.type(screen.getByLabelText('Senha'), 'uma-senha-boa{Enter}')
    await vi.waitFor(() => expect(done).toHaveBeenCalledTimes(1))
    expect(calls[0]).toEqual({ method: 'POST', path: '/v1/auth/password/login', body: { email: 'ana@exemplo.com', password: 'uma-senha-boa' } })
    expect(useServerAccount.getState().status).toBe('signed-in')
  })

  it('says when the e-mail or the password is wrong, and puts the cursor back in the password', async () => {
    serve(() => ({ status: 401, body: { error: 'wrong_credentials' } }))
    const done = vi.fn()
    render(<SignInDialog onClose={() => {}} onDone={done} />)
    await userEvent.type(screen.getByLabelText('E-mail'), 'ana@exemplo.com')
    await userEvent.type(screen.getByLabelText('Senha'), 'errada12')
    await userEvent.click(screen.getByRole('button', { name: 'Entrar' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('E-mail ou senha errados.')
    expect(screen.getByLabelText('Senha')).toHaveFocus()
    expect(done).not.toHaveBeenCalled()
  })

  it('shows and hides the password', async () => {
    render(<SignInDialog onClose={() => {}} onDone={() => {}} />)
    expect(screen.getByLabelText('Senha')).toHaveAttribute('type', 'password')
    await userEvent.click(screen.getByRole('button', { name: 'Mostrar' }))
    expect(screen.getByLabelText('Senha')).toHaveAttribute('type', 'text')
    expect(screen.getByRole('button', { name: 'Ocultar' })).toHaveAttribute('aria-pressed', 'true')
  })

  it('creates an account with name, e-mail and password, and says when the password is short', async () => {
    serve(call => {
      if (call.path === '/v1/auth/password/register') {
        return (call.body as { password: string }).password.length < 8 ? { status: 400, body: { error: 'weak_password', minLength: 8 } } : { status: 201, body: { user: { id: 'u1', email: 'ana@exemplo.com' } } }
      }
      return { status: 200, body: ME }
    })
    const done = vi.fn()
    render(<SignInDialog onClose={() => {}} onDone={done} />)
    await userEvent.click(screen.getByRole('button', { name: 'Não tem conta? Criar com e-mail e senha' }))
    await userEvent.type(screen.getByLabelText('Nome'), 'Ana')
    await userEvent.type(screen.getByLabelText('E-mail'), 'ana@exemplo.com')
    await userEvent.type(screen.getByLabelText('Senha'), 'curta')
    await userEvent.click(screen.getByRole('button', { name: 'Criar conta' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('A senha precisa de pelo menos 8 caracteres.')

    await userEvent.clear(screen.getByLabelText('Senha'))
    await userEvent.type(screen.getByLabelText('Senha'), 'uma-senha-boa')
    await userEvent.click(screen.getByRole('button', { name: 'Criar conta' }))
    await vi.waitFor(() => expect(done).toHaveBeenCalledTimes(1))
    expect(calls.filter(call => call.path === '/v1/auth/password/register').at(-1)?.body).toEqual({ email: 'ana@exemplo.com', password: 'uma-senha-boa', name: 'Ana' })

    await userEvent.click(screen.getByRole('button', { name: 'Já tem conta? Entrar' }))
    expect(screen.queryByLabelText('Nome')).not.toBeInTheDocument()
  })
})
