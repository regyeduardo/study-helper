import '@/test/account/storage-shim'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

const { storageBreakdown } = vi.hoisted(() => ({ storageBreakdown: vi.fn() }))
vi.mock('@/lib/storage/storage-usage', () => ({ storageBreakdown }))
vi.mock('@/lib/transcription', () => ({ ENGINES: [] }))

import { AppStructureSection } from '@/components/dialogs/AppStructure'
import { SettingsDialog } from '@/components/dialogs/SettingsDialog'
import { useServerAccount } from '@/stores/server-account'

type Me = {
  user: { id: string; email: string; name: string | null; photoUrl: null; status: 'no-code' | 'enabled' | 'revoked'; appEnabled: boolean; admin: boolean; deleteAt: null; hasPassword: boolean; hasGoogle: boolean }
  requireCode: boolean
  device: { id: string; name: string }
  space: { notes: number; media: number; reserved: number; limit: number; warnAt: number }
}

function me(over: Partial<Me['user']> = {}, requireCode = true): Me {
  return {
    user: { id: 'u1', email: 'ana@exemplo.com', name: 'Ana', photoUrl: null, status: 'no-code', appEnabled: false, admin: false, deleteAt: null, hasPassword: true, hasGoogle: false, ...over },
    requireCode,
    device: { id: 'd1', name: 'Chrome no Linux' },
    space: { notes: 0, media: 0, reserved: 0, limit: 10737418240, warnAt: 0.9 },
  }
}

type Call = { method: string; path: string; body: unknown }
let calls: Call[] = []

/** The backend for one test: `route` answers each call by method and path. */
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

beforeEach(() => {
  storageBreakdown.mockReset()
  storageBreakdown.mockResolvedValue({ mediaBytes: 0, appBytes: 0, totalBytes: 0 })
  useServerAccount.setState({ me: null, status: 'unknown' })
  try {
    sessionStorage.clear()
  } catch {
    /* no storage */
  }
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

const switchOf = () => screen.getByRole('switch', { name: 'Usar a estrutura do app' })

describe('Configurações › Outros › Usar a estrutura do app (T051)', () => {
  it('asks for the code and says what the structure is for; "Agora não" leaves everything as it was', async () => {
    serve(() => ({ status: 200, body: me() }))
    useServerAccount.setState({ me: me() as never, status: 'signed-in' })
    render(<AppStructureSection />)
    expect(switchOf()).toHaveAttribute('aria-checked', 'false')
    expect(screen.getByText(/Conectado como/)).toHaveTextContent('Conectado como ana@exemplo.com')

    await userEvent.click(switchOf())
    const dialog = await screen.findByRole('dialog', { name: 'Usar a estrutura do app' })
    expect(within(dialog).getByText('A biblioteca fica na sua conta e abre igual em todos os aparelhos.')).toBeInTheDocument()
    expect(within(dialog).getByText('A mídia não ocupa este aparelho; a geração segue com a aba fechada.')).toBeInTheDocument()
    expect(within(dialog).getByText('Por enquanto o acesso é por convite: digite o código que você recebeu.')).toBeInTheDocument()
    expect(within(dialog).getByRole('textbox', { name: 'Código' })).toBeInTheDocument()

    await userEvent.click(within(dialog).getByRole('button', { name: 'Agora não' }))
    expect(screen.queryByRole('dialog', { name: 'Usar a estrutura do app' })).not.toBeInTheDocument()
    expect(switchOf()).toHaveAttribute('aria-checked', 'false')
    expect(calls.filter(call => call.method !== 'GET')).toEqual([])
  })

  it.each([
    [404, { error: 'code_not_found' }, 'Código não encontrado. Confira as letras e tente de novo.'],
    [410, { error: 'code_expired', expiredAt: '2026-11-14T00:00:00Z' }, 'Este código venceu em 14/11/2026. Peça um novo a quem te enviou.'],
    [409, { error: 'code_used_up' }, 'Este código já foi usado por todas as pessoas que ele permite. Peça um novo a quem te enviou.'],
    [410, { error: 'code_canceled' }, 'Este código foi cancelado. Peça um novo a quem te enviou.'],
  ])('shows each refusal under the field (%s %o)', async (status, body, sentence) => {
    serve(call => (call.path === '/v1/code/use' ? { status, body } : { status: 200, body: me() }))
    useServerAccount.setState({ me: me() as never, status: 'signed-in' })
    render(<AppStructureSection />)
    await userEvent.click(switchOf())
    const dialog = await screen.findByRole('dialog', { name: 'Usar a estrutura do app' })
    await userEvent.type(within(dialog).getByRole('textbox', { name: 'Código' }), 'k7qm 3xrt 9pwd')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Liberar' }))
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(sentence)
    expect(within(dialog).getByRole('textbox', { name: 'Código' })).toHaveFocus()
    expect(calls.find(call => call.path === '/v1/code/use')?.body).toEqual({ code: 'k7qm 3xrt 9pwd' })
    expect(switchOf()).toHaveAttribute('aria-checked', 'false')
  })

  it('frees the account with a good code and turns the switch on', async () => {
    let freed = false
    serve(call => {
      if (call.path === '/v1/code/use') {
        freed = true
        return { status: 200, body: { status: 'enabled' } }
      }
      return { status: 200, body: freed ? me({ status: 'enabled', appEnabled: true }) : me() }
    })
    useServerAccount.setState({ me: me() as never, status: 'signed-in' })
    render(<AppStructureSection />)
    await userEvent.click(switchOf())
    const dialog = await screen.findByRole('dialog', { name: 'Usar a estrutura do app' })
    await userEvent.type(within(dialog).getByRole('textbox', { name: 'Código' }), 'K7QM3XRT9PWD')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Liberar' }))
    await waitFor(() => expect(switchOf()).toHaveAttribute('aria-checked', 'true'))
    expect(screen.queryByRole('dialog', { name: 'Usar a estrutura do app' })).not.toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveTextContent('A estrutura do app está ligada nesta conta.')
  })

  it('turns on without a code when the code is not required, or the account was already freed', async () => {
    let on = false
    serve(call => {
      if (call.path === '/v1/structure') {
        on = (call.body as { on: boolean }).on
        return { status: 200, body: { appEnabled: on } }
      }
      return { status: 200, body: me({ appEnabled: on }, false) }
    })
    useServerAccount.setState({ me: me({}, false) as never, status: 'signed-in' })
    render(<AppStructureSection />)
    await userEvent.click(switchOf())
    await waitFor(() => expect(switchOf()).toHaveAttribute('aria-checked', 'true'))
    expect(calls.find(call => call.path === '/v1/structure')?.body).toEqual({ on: true })
    expect(screen.queryByRole('dialog', { name: 'Usar a estrutura do app' })).not.toBeInTheDocument()
  })

  it('says what happens before turning off, and turns off only when confirmed', async () => {
    let on = true
    serve(call => {
      if (call.path === '/v1/structure') {
        on = (call.body as { on: boolean }).on
        return { status: 200, body: { appEnabled: on } }
      }
      return { status: 200, body: me({ status: 'enabled', appEnabled: on }) }
    })
    useServerAccount.setState({ me: me({ status: 'enabled', appEnabled: true }) as never, status: 'signed-in' })
    render(<AppStructureSection />)
    expect(switchOf()).toHaveAttribute('aria-checked', 'true')
    await userEvent.click(switchOf())
    const ask = await screen.findByRole('alertdialog', { name: 'Desligar a estrutura do app?' })
    expect(ask).toHaveTextContent('Nada é apagado')
    expect(ask).toHaveTextContent('Google Drive e Local')
    await userEvent.click(within(ask).getByRole('button', { name: 'Cancelar' }))
    expect(switchOf()).toHaveAttribute('aria-checked', 'true')
    expect(calls.some(call => call.path === '/v1/structure')).toBe(false)

    await userEvent.click(switchOf())
    await userEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Desligar' }))
    await waitFor(() => expect(switchOf()).toHaveAttribute('aria-checked', 'false'))
    expect(calls.find(call => call.path === '/v1/structure')?.body).toEqual({ on: false })
  })

  it('without an account, turning on asks to sign in first, then goes on to the code', async () => {
    let signedIn = false
    serve(call => {
      if (call.path === '/v1/auth/password/login') {
        signedIn = true
        return { status: 200, body: { user: { id: 'u1', email: 'ana@exemplo.com' } } }
      }
      if (call.path === '/v1/me') return signedIn ? { status: 200, body: me() } : { status: 401, body: { error: 'no_session' } }
      return { status: 404, body: { error: 'not_found' } }
    })
    useServerAccount.setState({ me: null, status: 'signed-out' })
    render(<AppStructureSection />)
    await userEvent.click(switchOf())
    const signIn = await screen.findByRole('dialog', { name: 'Entrar no Estudo' })
    await userEvent.type(within(signIn).getByLabelText('E-mail'), 'ana@exemplo.com')
    await userEvent.type(within(signIn).getByLabelText('Senha'), 'uma-senha-boa')
    await userEvent.click(within(signIn).getByRole('button', { name: 'Entrar' }))
    expect(await screen.findByRole('dialog', { name: 'Usar a estrutura do app' })).toBeInTheDocument()
    expect(screen.queryByRole('dialog', { name: 'Entrar no Estudo' })).not.toBeInTheDocument()
  })

  it('says the server is out of reach without breaking the tab', async () => {
    useServerAccount.setState({ me: null, status: 'offline' })
    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new TypeError('Failed to fetch'))))
    render(<AppStructureSection />)
    expect(screen.getByText('Não deu para falar com o servidor. Confira a internet e tente de novo.')).toBeInTheDocument()
    expect(switchOf()).toBeDisabled()
  })

  it('signs out of the Estudo account', async () => {
    serve(call => (call.path === '/v1/auth/logout' ? { status: 200, body: { ok: true } } : { status: 200, body: me() }))
    useServerAccount.setState({ me: me() as never, status: 'signed-in' })
    render(<AppStructureSection />)
    await userEvent.click(screen.getByRole('button', { name: 'Sair' }))
    await waitFor(() => expect(useServerAccount.getState().status).toBe('signed-out'))
    expect(screen.queryByText(/Conectado como/)).not.toBeInTheDocument()
  })
})

describe('Configurações with the structure on (FR-032)', () => {
  it('hides the AI section and says the app gives the AI', async () => {
    serve(() => ({ status: 200, body: me({ status: 'enabled', appEnabled: true }) }))
    useServerAccount.setState({ me: me({ status: 'enabled', appEnabled: true }) as never, status: 'signed-in' })
    render(<SettingsDialog initial="ai" />)
    expect(screen.queryByRole('button', { name: 'Inteligência artificial' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Outros' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByText(/o app fornece a IA/)).toBeInTheDocument()
  })

  it('keeps the AI section while the structure is off', () => {
    useServerAccount.setState({ me: me() as never, status: 'signed-in' })
    serve(() => ({ status: 200, body: me() }))
    render(<SettingsDialog initial="others" />)
    expect(screen.getByRole('button', { name: 'Inteligência artificial' })).toBeInTheDocument()
  })
})
