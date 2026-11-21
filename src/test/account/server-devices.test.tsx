import '@/test/account/storage-shim'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

vi.mock('@/lib/transcription', () => ({ ENGINES: [] }))

import { ServerDevices } from '@/components/dialogs/ServerDevices'
import { SettingsDialog } from '@/components/dialogs/SettingsDialog'
import { useServerAccount } from '@/stores/server-account'

const ME = {
  user: { id: 'u1', email: 'ana@exemplo.com', name: 'Ana', photoUrl: null, status: 'enabled', appEnabled: false, admin: false, deleteAt: null, hasPassword: true, hasGoogle: true },
  requireCode: true,
  device: { id: 'd1', name: 'Chrome no Linux' },
  space: { notes: 0, media: 0, reserved: 0, limit: 10737418240, warnAt: 0.9 },
}

const HOUR = 3600_000
const DEVICES = () => [
  { id: 'd1', name: 'Chrome no Linux', seenAt: new Date().toISOString(), current: true },
  { id: 'd2', name: 'Safari no iPhone', seenAt: new Date(Date.now() - 3 * HOUR).toISOString(), current: false },
  { id: 'd3', name: 'Firefox no Windows', seenAt: new Date(Date.now() - 72 * HOUR).toISOString(), current: false },
]

type Call = { method: string; path: string }
let calls: Call[] = []
let devices = DEVICES()

function serve() {
  calls = []
  devices = DEVICES()
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit = {}) => {
      const call = { method: init.method ?? 'GET', path: new URL(url).pathname }
      calls.push(call)
      if (call.path === '/v1/devices') return new Response(JSON.stringify({ devices }), { status: 200 })
      if (call.method === 'DELETE' && call.path.startsWith('/v1/devices/')) {
        const id = decodeURIComponent(call.path.split('/').pop() ?? '')
        devices = devices.filter(device => device.id !== id)
        return new Response(JSON.stringify({ ok: true }), { status: 200 })
      }
      return new Response(JSON.stringify(ME), { status: 200 })
    }),
  )
}

beforeEach(() => {
  serve()
  useServerAccount.setState({ me: ME as never, status: 'signed-in' })
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

const rowOf = (name: RegExp) => screen.getByRole('row', { name })

describe('Aparelhos da conta do Estudo (opção B)', () => {
  it('lists the devices, this one marked and without "Sair"', async () => {
    render(<ServerDevices />)
    expect(await screen.findByRole('row', { name: /Chrome no Linux/ })).toHaveTextContent('este aparelho')
    expect(within(rowOf(/Chrome no Linux/)).queryByRole('button', { name: /Sair/ })).not.toBeInTheDocument()
    expect(within(rowOf(/Safari no iPhone/)).getByRole('button', { name: 'Sair de Safari no iPhone' })).toBeInTheDocument()
    expect(rowOf(/Safari no iPhone/)).toHaveTextContent('há 3 h')
    expect(screen.getByText('Os aparelhos encerrados vão pedir para entrar de novo.')).toBeInTheDocument()
  })

  it('signs one device out', async () => {
    render(<ServerDevices />)
    await userEvent.click(await screen.findByRole('button', { name: 'Sair de Safari no iPhone' }))
    await waitFor(() => expect(screen.queryByRole('row', { name: /Safari no iPhone/ })).not.toBeInTheDocument())
    expect(calls).toContainEqual({ method: 'DELETE', path: '/v1/devices/d2' })
    expect(screen.getByRole('row', { name: /Firefox no Windows/ })).toBeInTheDocument()
  })

  it('signs all the others out after saying they will ask to sign in again', async () => {
    render(<ServerDevices />)
    await userEvent.click(await screen.findByRole('button', { name: 'Sair de todos os outros' }))
    const ask = await screen.findByRole('alertdialog', { name: 'Sair de todos os outros aparelhos?' })
    expect(ask).toHaveTextContent('Os aparelhos encerrados vão pedir para entrar de novo.')
    await userEvent.click(within(ask).getByRole('button', { name: 'Sair de todos' }))
    await waitFor(() => expect(screen.queryByRole('row', { name: /Safari no iPhone/ })).not.toBeInTheDocument())
    expect(screen.queryByRole('row', { name: /Firefox no Windows/ })).not.toBeInTheDocument()
    expect(calls.filter(call => call.method === 'DELETE').map(call => call.path).sort()).toEqual(['/v1/devices/d2', '/v1/devices/d3'])
    expect(screen.getByRole('button', { name: 'Sair de todos os outros' })).toBeDisabled()
  })
})

describe('Configurações › Dispositivos', () => {
  it('shows the devices of the Estudo account when there is a session', async () => {
    render(<SettingsDialog initial="devices" />)
    expect(await screen.findByText('Aparelhos conectados')).toBeInTheDocument()
  })

  it('stays as it is without a session on the server', () => {
    useServerAccount.setState({ me: null, status: 'signed-out' })
    render(<SettingsDialog initial="devices" />)
    expect(screen.queryByText('Aparelhos conectados')).not.toBeInTheDocument()
  })
})
