import '@/test/account/storage-shim'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

// the copies of the Local profile and the owner's calls to the server never run here: the test holds them
vi.mock('@/lib/storage/transfer', () => ({ bringLocalToAccount: vi.fn(), transferLocalToCurrent: vi.fn() }))
vi.mock('@/controllers/api.controller', async importOriginal => ({
  ...(await importOriginal<typeof import('@/controllers/api.controller')>()),
  adminCodes: vi.fn(),
  adminCancelCode: vi.fn(),
  adminAccounts: vi.fn(),
  adminRevoke: vi.fn(),
  adminSettings: vi.fn(),
  adminSetSettings: vi.fn(),
}))

import App from '@/App'
import { AccountMenu } from '@/components/dialogs/AccountMenu'
import { AppStructureSection } from '@/components/dialogs/AppStructure'
import { SendLocalDialog, StorageLimitDialog } from '@/components/dialogs/MoreDialogs'
import { BlockingWindow } from '@/components/ui/BlockingWindow'
import { adminAccounts, adminCancelCode, adminCodes, adminRevoke, adminSetSettings, adminSettings } from '@/controllers/api.controller'
import { bringLocalToAccount, transferLocalToCurrent } from '@/lib/storage/transfer'
import AdminPage from '@/pages/admin'
import { type Account, LOCAL_ACCOUNT, useAccountStore } from '@/stores/account'
import { useBlockingStore } from '@/stores/blocking'
import { useLibraryStore } from '@/stores/library'
import { useServerAccount } from '@/stores/server-account'
import { useSyncStore } from '@/stores/sync'
import { type Overlay, useUiStore } from '@/stores/ui'
import { deferred, settle, slowLibrary, toastsNow } from '@/test/feedback/slow'

// Escolha F do dono (21/11/2026) em Configurações, Conta e Administração: o clique que espera o servidor, o Google ou o Drive trava o
// app na janela do meio até a resposta, e o motivo aparece quando falha.

const GOOGLE: Account = { id: 'google-1', kind: 'google', name: 'Ana', email: 'ana@example.com', picture: '', token: { accessToken: 'at-1', expiresAt: Date.now() + 3600_000 } }

const flush = () => act(async () => await Promise.resolve())
const shown = () => act(async () => vi.advanceTimersByTime(350))
const windowNamed = (name: string) => screen.getByRole('alertdialog', { name })
const noWindow = () => expect(screen.queryByRole('alertdialog')).toBeNull()
const REAL = { library: useLibraryStore.getState(), account: useAccountStore.getState(), server: useServerAccount.getState(), sync: useSyncStore.getState() }

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true })
  useBlockingStore.setState({ ops: [] })
  slowLibrary()
})
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  useLibraryStore.setState({ connect: REAL.library.connect, updateSettings: REAL.library.updateSettings, forgetCurrent: REAL.library.forgetCurrent, hiddenPending: false })
  useAccountStore.setState({ accounts: [LOCAL_ACCOUNT], activeId: LOCAL_ACCOUNT.id, reconnectId: null, reauthorize: REAL.account.reauthorize, forgetAccount: REAL.account.forgetAccount })
  useServerAccount.setState({ me: null, status: 'unknown', setStructure: REAL.server.setStructure, refresh: REAL.server.refresh })
  useSyncStore.setState({ removeThisDevice: REAL.sync.removeThisDevice, start: REAL.sync.start, stop: REAL.sync.stop })
})

type Me = NonNullable<ReturnType<typeof useServerAccount.getState>['me']>
const me = (over: Partial<Me['user']> = {}): Me =>
  ({
    user: { id: 'u1', email: 'ana@exemplo.com', name: 'Ana', photoUrl: null, status: 'enabled', appEnabled: false, admin: false, deleteAt: null, hasPassword: true, hasGoogle: false, ...over },
    requireCode: false,
    device: { id: 'd1', name: 'Chrome no Linux' },
    space: { notes: 0, media: 0, reserved: 0, limit: 10737418240, warnAt: 0.9 },
  }) as Me

describe('"Usar a estrutura do app"', () => {
  const open = () =>
    render(
      <>
        <AppStructureSection />
        <BlockingWindow />
      </>,
    )
  const switchOf = () => screen.getByRole('switch', { name: 'Usar a estrutura do app' })

  it('ligar: a janela "Ligando a estrutura do app…" fica do clique até o servidor responder', async () => {
    const answer = deferred()
    const setStructure = vi.fn(() => answer.promise)
    useServerAccount.setState({ me: me(), status: 'signed-in', setStructure, refresh: vi.fn(async () => undefined) })
    open()
    fireEvent.click(switchOf())
    await flush()
    await shown()
    expect(windowNamed('Ligando a estrutura do app…')).toBeInTheDocument()
    expect(setStructure).toHaveBeenCalledWith(true)

    await act(async () => {
      answer.resolve()
      await settle()
    })
    noWindow()
    expect(screen.getByRole('status')).toHaveTextContent('A estrutura do app está ligada nesta conta.')
  })

  it('desligar: depois de confirmar, a janela "Desligando a estrutura do app…" até o servidor responder', async () => {
    const answer = deferred()
    const setStructure = vi.fn(() => answer.promise)
    useServerAccount.setState({ me: me({ appEnabled: true }), status: 'signed-in', setStructure, refresh: vi.fn(async () => undefined) })
    open()
    fireEvent.click(switchOf())
    fireEvent.click(within(screen.getByRole('alertdialog', { name: 'Desligar a estrutura do app?' })).getByRole('button', { name: 'Desligar' }))
    await flush()
    await shown()
    expect(windowNamed('Desligando a estrutura do app…')).toBeInTheDocument()

    await act(async () => {
      answer.resolve()
      await settle()
    })
    noWindow()
    expect(setStructure).toHaveBeenCalledWith(false)
  })
})

describe('"Sair desta conta"', () => {
  it('a janela "Saindo da conta…" fica até apagar o login e o cache; no fim, o aviso', async () => {
    const device = deferred()
    useAccountStore.setState({ accounts: [LOCAL_ACCOUNT, GOOGLE], activeId: GOOGLE.id, forgetAccount: vi.fn(async () => undefined) })
    useLibraryStore.setState({ forgetCurrent: vi.fn(async () => undefined) })
    useSyncStore.setState({ removeThisDevice: vi.fn(() => device.promise) })
    useUiStore.setState({ overlay: { kind: 'account' } })
    render(
      <>
        <AccountMenu />
        <BlockingWindow />
      </>,
    )
    fireEvent.click(screen.getByRole('button', { name: /Sair desta conta/ }))
    await flush()
    await shown()
    expect(windowNamed('Saindo da conta…')).toBeInTheDocument()

    await act(async () => {
      device.resolve()
      await settle()
    })
    noWindow()
    expect(toastsNow()).toContain('Saiu da conta; o login e o cache dela foram apagados deste navegador')
  })

  it('não deu para sair: a janela diz o motivo', async () => {
    useAccountStore.setState({ accounts: [LOCAL_ACCOUNT, GOOGLE], activeId: GOOGLE.id, forgetAccount: vi.fn(async () => undefined) })
    useLibraryStore.setState({ forgetCurrent: vi.fn(async () => undefined) })
    useSyncStore.setState({ removeThisDevice: vi.fn(async () => Promise.reject(new Error('Sem conexão com o Drive.'))) })
    useUiStore.setState({ overlay: { kind: 'account' } })
    render(
      <>
        <AccountMenu />
        <BlockingWindow />
      </>,
    )
    fireEvent.click(screen.getByRole('button', { name: /Sair desta conta/ }))
    await act(async () => {
      await settle()
    })
    expect(windowNamed('Saindo da conta…')).toHaveTextContent('Sem conexão com o Drive.')
  })
})

describe('Google: "Reconectar" e "Autorizar"', () => {
  const open = () => {
    useLibraryStore.setState({ connect: vi.fn(async () => undefined), ready: true, loadError: null })
    useSyncStore.setState({ start: vi.fn(), stop: vi.fn() })
    useServerAccount.setState({ refresh: vi.fn(async () => undefined) })
    render(
      <MemoryRouter>
        <App />
      </MemoryRouter>,
    )
  }

  it('"Reconectar": a janela "Conectando ao Google…" fica enquanto o Google responde', async () => {
    const google = deferred()
    useAccountStore.setState({ accounts: [LOCAL_ACCOUNT, GOOGLE], activeId: GOOGLE.id, reconnectId: GOOGLE.id, reauthorize: vi.fn(() => google.promise) as never })
    open()
    fireEvent.click(within(screen.getAllByRole('alert').find(bar => bar.classList.contains('reconnect-bar'))!).getByRole('button', { name: 'Reconectar' }))
    await flush()
    await shown()
    expect(windowNamed('Conectando ao Google…')).toBeInTheDocument()
    await act(async () => {
      google.resolve()
      await settle()
    })
    noWindow()
  })

  it('"Autorizar" a pasta oculta: a janela "Autorizando a pasta oculta…" até a biblioteca abrir de novo', async () => {
    const google = deferred()
    useAccountStore.setState({ accounts: [LOCAL_ACCOUNT, GOOGLE], activeId: GOOGLE.id, reconnectId: null, reauthorize: vi.fn(() => google.promise) as never })
    useLibraryStore.setState({ hiddenPending: true })
    open()
    fireEvent.click(within(screen.getByRole('status', { name: 'Pasta oculta do Drive' })).getByRole('button', { name: 'Autorizar' }))
    await flush()
    await shown()
    expect(windowNamed('Autorizando a pasta oculta…')).toBeInTheDocument()
    await act(async () => {
      google.resolve()
      await settle()
    })
    noWindow()
  })
})

describe('Limite do Drive e o perfil sem login', () => {
  it('"Salvar" o limite: a janela "Salvando o limite…" até gravar; só então a pergunta fecha', async () => {
    const saving = deferred()
    useLibraryStore.setState({ updateSettings: vi.fn(() => saving.promise) })
    useUiStore.setState({ overlay: { kind: 'storage-limit' } })
    render(
      <>
        <StorageLimitDialog />
        <BlockingWindow />
      </>,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Salvar' }))
    await flush()
    await shown()
    expect(windowNamed('Salvando o limite…')).toBeInTheDocument()
    expect(useUiStore.getState().overlay).toEqual({ kind: 'storage-limit' })
    await act(async () => {
      saving.resolve()
      await settle()
    })
    noWindow()
    expect(useUiStore.getState().overlay).toBeNull()
  })

  const openSendLocal = () => {
    useAccountStore.setState({ accounts: [LOCAL_ACCOUNT, GOOGLE], activeId: GOOGLE.id })
    useUiStore.setState({ overlay: { kind: 'send-local' } as Overlay })
    render(
      <>
        <SendLocalDialog />
        <BlockingWindow />
      </>,
    )
  }

  it('"Trazer para esta conta": a janela conta "3 de 12" com o item da vez, e o botão de enviar não muda', async () => {
    const copying = deferred<number>()
    vi.mocked(bringLocalToAccount).mockImplementationOnce(async progress => {
      progress?.({ done: 3, total: 12, current: 'Aula 4' })
      return copying.promise
    })
    openSendLocal()
    fireEvent.click(screen.getByRole('button', { name: 'Trazer para esta conta, só neste navegador' }))
    await flush()
    await shown()
    const window_ = windowNamed('Trazendo para esta conta…')
    expect(window_).toHaveTextContent('3 de 12')
    expect(window_).toHaveTextContent('Aula 4')
    // behind the window the page is hidden from the screen reader (aria-hidden): the button is looked for there too
    expect(screen.getByRole('button', { name: 'Enviar para o Drive', hidden: true })).toBeDisabled()

    await act(async () => {
      copying.resolve(12)
      await settle()
    })
    noWindow()
    expect(screen.getByText(/12 item\(ns\) agora estão no Local desta conta/)).toBeInTheDocument()
  })

  it('"Enviar para o Drive": o próprio botão conta "Enviando 3 de 12…" (a janela de conflito pode precisar da pessoa), e o outro não muda', async () => {
    const sending = deferred<number>()
    vi.mocked(transferLocalToCurrent).mockImplementationOnce(async progress => {
      progress?.({ done: 3, total: 12, current: 'Aula 4' })
      return sending.promise
    })
    openSendLocal()
    fireEvent.click(screen.getByRole('button', { name: 'Enviar para o Drive' }))
    await flush()
    expect(screen.getByRole('button', { name: 'Enviando 3 de 12…' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Trazer para esta conta, só neste navegador' })).toBeDisabled()
    await act(async () => {
      sending.resolve(12)
      await settle()
    })
    expect(screen.getByText(/12 item\(ns\) enviados para o seu Drive/)).toBeInTheDocument()
  })
})

describe('Administração', () => {
  const CODE = { id: 'c1', code: 'K7QM3XRT9PWD', maxUses: 3, uses: 1, validUntil: '2026-12-21T00:00:00Z', madeFor: '', status: 'active', createdAt: '2026-11-21T10:00:00Z', accounts: [] }
  const ACCOUNT = { id: 'a1', name: 'Ana Souza', email: 'ana@exemplo.com', status: 'enabled', appEnabled: true, enabledAt: '2026-11-21T11:00:00Z', deleteAt: null, code: null, seenAt: null, space: { notes: 0, media: 0, limit: 10737418240 } }
  const confirm = async () => {
    const overlay = useUiStore.getState().overlay as Extract<Overlay, { kind: 'confirm' }>
    void overlay.onConfirm()
    await flush()
    await shown()
  }
  const open = () => {
    useServerAccount.setState({ me: me({ admin: true }), status: 'signed-in' })
    vi.mocked(adminCodes).mockResolvedValue([CODE] as never)
    vi.mocked(adminAccounts).mockResolvedValue([ACCOUNT] as never)
    vi.mocked(adminSettings).mockResolvedValue({ requireCode: true } as never)
    render(
      <MemoryRouter initialEntries={['/administracao']}>
        <AdminPage />
        <BlockingWindow />
      </MemoryRouter>,
    )
  }

  it('"Cancelar o código": a janela "Cancelando o código…" até a lista voltar', async () => {
    const answer = deferred()
    vi.mocked(adminCancelCode).mockReturnValueOnce(answer.promise as never)
    open()
    fireEvent.click(await screen.findByRole('button', { name: 'Cancelar o código K7QM 3XRT 9PWD' }))
    await confirm()
    expect(windowNamed('Cancelando o código…')).toBeInTheDocument()
    await act(async () => {
      answer.resolve()
      await settle()
    })
    noWindow()
  })

  it('"Retirar o acesso": a janela "Retirando o acesso…" até o servidor responder', async () => {
    const answer = deferred<{ deleteAt: string }>()
    vi.mocked(adminRevoke).mockReturnValueOnce(answer.promise as never)
    open()
    fireEvent.click(await screen.findByRole('tab', { name: 'Contas' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Retirar o acesso de Ana Souza' }))
    await confirm()
    expect(windowNamed('Retirando o acesso…')).toBeInTheDocument()
    await act(async () => {
      answer.resolve({ deleteAt: '2026-12-21T12:00:00Z' })
      await settle()
    })
    noWindow()
    expect(screen.getByText(/Acesso retirado/)).toBeInTheDocument()
  })

  it('"Exigir código": a janela "Salvando a configuração…" até o servidor responder', async () => {
    const answer = deferred<{ requireCode: boolean }>()
    vi.mocked(adminSetSettings).mockReturnValueOnce(answer.promise as never)
    open()
    fireEvent.click(await screen.findByRole('tab', { name: 'Configuração' }))
    fireEvent.click(await screen.findByRole('switch', { name: 'Exigir código para usar a estrutura do app' }))
    await flush()
    await shown()
    expect(windowNamed('Salvando a configuração…')).toBeInTheDocument()
    await act(async () => {
      answer.resolve({ requireCode: false })
      await settle()
    })
    noWindow()
    expect(screen.getByRole('switch', { name: 'Exigir código para usar a estrutura do app' })).toHaveAttribute('aria-checked', 'false')
  })
})
