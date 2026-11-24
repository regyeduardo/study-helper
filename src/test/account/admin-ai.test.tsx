import '@/test/account/storage-shim'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

const { mockEnv } = vi.hoisted(() => ({ mockEnv: { apiUrl: 'https://api.example.test', basePath: '/' } }))
vi.mock('@/lib/env', () => ({ env: mockEnv }))

import AdminPage from '@/pages/admin'
import { useServerAccount } from '@/stores/server-account'
import { useUiStore } from '@/stores/ui'

// Spec 006: Administração › "IA do app" é a tela de IA de Configurações, para todos da estrutura, sem campo de chave (as chaves ficam
// na env do servidor); só os provedores com chave no servidor podem entrar; salvar manda a escolha sem nenhuma chave.

const me = { user: { id: 'u1', email: 'dono@exemplo.com', name: 'Dono', photoUrl: null, status: 'enabled', appEnabled: true, admin: true, deleteAt: null, hasPassword: false, hasGoogle: true }, requireCode: true, device: { id: 'd1', name: 'Chrome' }, space: { notes: 0, media: 0, reserved: 0, limit: 10737418240, warnAt: 0.9 } }
const USES = {
  providers: [{ id: 'p-deep', type: 'deepinfra', name: 'DeepInfra', key: '', base: '' }],
  models: [{ uid: 'm-whisper', pid: 'p-deep', mid: 'openai/whisper-large-v3-turbo', name: 'whisper-large-v3-turbo' }],
  defaults: { transcricao: 'm-whisper' },
  steps: {},
}

let puts: unknown[]

beforeEach(() => {
  puts = []
  useServerAccount.setState({ me: null, status: 'unknown' })
  useUiStore.setState({ overlay: null, toasts: [] })
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit = {}) => {
      const path = url.replace(mockEnv.apiUrl, '')
      const json = (status: number, value: unknown) => new Response(JSON.stringify(value), { status })
      if (path === '/v1/me') return json(200, me)
      if (path === '/v1/admin/codes') return json(200, { codes: [] })
      if (path === '/v1/admin/ai' && (init.method ?? 'GET') === 'GET') return json(200, { providers: ['deepinfra', 'openrouter'], known: ['deepinfra', 'openai', 'openrouter'], uses: USES })
      if (path === '/v1/admin/ai' && init.method === 'PUT') {
        puts.push(JSON.parse(String(init.body)))
        return json(200, JSON.parse(String(init.body)))
      }
      return json(200, { data: [] })
    }),
  )
})

afterEach(() => vi.unstubAllGlobals())

describe('Administração › IA do app', () => {
  it('mostra a tela de IA sem chave e diz quais provedores têm chave no servidor', async () => {
    render(
      <MemoryRouter initialEntries={['/administracao']}>
        <AdminPage />
      </MemoryRouter>,
    )
    fireEvent.click(await screen.findByRole('tab', { name: 'IA do app' }))
    expect(await screen.findByText(/com chave: deepinfra, openrouter/)).toBeInTheDocument()
    expect(screen.getAllByText('DeepInfra').length).toBeGreaterThan(0)
    expect(screen.queryByLabelText('Chave')).toBeNull()
    // the providers are the server's: no adding, editing or removing, only testing the connection
    expect(screen.queryByRole('button', { name: /Adicionar provedor/ })).toBeNull()
    expect(screen.queryByRole('button', { name: /Editar/ })).toBeNull()
    expect(screen.getAllByRole('button', { name: 'Testar conexão' })).toHaveLength(2)
  })

  it('salvar manda a escolha para todos, sem nenhuma chave', async () => {
    render(
      <MemoryRouter initialEntries={['/administracao']}>
        <AdminPage />
      </MemoryRouter>,
    )
    fireEvent.click(await screen.findByRole('tab', { name: 'IA do app' }))
    await screen.findByText(/com chave: deepinfra/)
    // choosing the model of a use is what this screen is for
    fireEvent.click(screen.getByRole('tab', { name: 'Padrões por uso' }))
    fireEvent.change(await screen.findByLabelText('Transcrição'), { target: { value: '' } })
    await waitFor(() => expect(puts.length).toBeGreaterThan(0))
    expect(JSON.stringify(puts.at(-1))).not.toMatch(/"key":"(?!")/)
    expect(screen.getByRole('status')).toHaveTextContent('vale para todos que usam a estrutura do app')
  })
})
