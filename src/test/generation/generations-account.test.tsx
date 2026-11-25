// Spec 007, história 2 (T085): Gerações mostra os trabalhos da conta, em qualquer aparelho, com o WaitStatus (na fila, a posição;
// rodando, o quanto já foi e o horário previsto que o servidor calculou); Cancelar, Tentar de novo e Dispensar vão para a conta.
import '@/test/account/storage-shim'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import 'fake-indexeddb/auto'
import { act, render, screen } from '@testing-library/react'

const { mockEnv } = vi.hoisted(() => ({ mockEnv: { apiUrl: 'https://api.example.test' } }))
vi.mock('@/lib/env', async importOriginal => ({ env: { ...((await importOriginal()) as { env: object }).env, apiUrl: mockEnv.apiUrl } }))

import type { AccountJob } from '@/controllers/jobs.controller'
import { WaitStatus } from '@/components/ui/WaitStatus'
import { useAccountJobsStore } from '@/stores/account-jobs'
import { useGenerationsStore } from '@/stores/generations'
import { FakeAppServer } from '@/test/storage/fake-app-server'

let server: FakeAppServer

const job = (fields: Partial<AccountJob>): AccountJob => ({
  id: 'j1', call: 'generateFromNote', kind: 'generateFromNote', fileId: 'n1', title: 'Gerando · Reunião', state: 'running', queuePosition: null, stage: 'Escrevendo a explicação',
  fraction: 0.5, etaAt: null, etaBasis: null, lastProgress: 'Escrevendo a explicação', lastProgressAt: new Date().toISOString(), stalledSince: null, args: [], result: null,
  error: null, errorCode: null, attempt: 1, createdAt: new Date().toISOString(), startedAt: new Date().toISOString(), finishedAt: null, ...fields,
})

beforeEach(() => {
  server = new FakeAppServer()
  vi.stubGlobal('fetch', (input: string | URL | Request, init?: RequestInit) => server.fetch(input, init))
  useAccountJobsStore.setState({ jobs: [] })
})
afterEach(() => vi.unstubAllGlobals())

const line = () => useGenerationsStore.getState().items.find(item => item.accountJob === 'j1')

describe('Gerações com os trabalhos da conta', () => {
  it('rodando: a linha mostra o quanto já foi e o horário que o servidor previu', () => {
    const eta = new Date(Date.now() + 6 * 60_000)
    act(() => useAccountJobsStore.getState().apply(job({ etaAt: eta.toISOString(), etaBasis: 'parts' })))
    expect(line()?.state).toBe('running')
    render(<WaitStatus wait={line()!.wait!} />)
    expect(screen.getByText('Escrevendo a explicação')).toBeInTheDocument()
    expect(screen.getByText('50%')).toBeInTheDocument()
    const clock = `${String(eta.getHours()).padStart(2, '0')}:${String(eta.getMinutes()).padStart(2, '0')}`
    expect(screen.getByText(`deve terminar por volta de ${clock}`)).toBeInTheDocument()
  })

  it('na fila: a posição; parado: o aviso do servidor', () => {
    act(() => useAccountJobsStore.getState().apply(job({ state: 'queued', queuePosition: 2, fraction: null, stage: null })))
    expect(line()?.wait?.what).toBe('Na fila da conta: 2º')
    const since = new Date(Date.now() - 10 * 60_000).toISOString()
    act(() => useAccountJobsStore.getState().apply(job({ stalledSince: since })))
    render(<WaitStatus wait={line()!.wait!} />)
    expect(screen.getByRole('alert')).toHaveTextContent('Nada andou desde')
  })

  it('pronta abre a nota que saiu; falha e cancelada', () => {
    act(() => useAccountJobsStore.getState().apply(job({ state: 'done', result: 'nota-nova', finishedAt: new Date().toISOString() })))
    expect(line()).toMatchObject({ state: 'ready', fileId: 'nota-nova' })
    act(() => useAccountJobsStore.getState().apply(job({ state: 'failed', error: 'A IA do app está fora do ar agora.' })))
    expect(line()).toMatchObject({ state: 'failed', error: 'A IA do app está fora do ar agora.' })
    act(() => useAccountJobsStore.getState().apply(job({ state: 'cancelled' })))
    expect(line()).toBeUndefined()
  })

  it('Cancelar, Tentar de novo e Dispensar vão para a conta', async () => {
    server.jobs.set('j1', job({}))
    act(() => useAccountJobsStore.getState().apply(job({})))
    useGenerationsStore.getState().cancel('conta:j1')
    await vi.waitFor(() => expect(server.jobs.get('j1').state).toBe('cancelled'))
    Object.assign(server.jobs.get('j1'), { state: 'failed' })
    act(() => useAccountJobsStore.getState().apply(job({ state: 'failed' })))
    useGenerationsStore.getState().retry('conta:j1')
    await vi.waitFor(() => expect(server.jobs.get('j1').state).toBe('queued'))
    Object.assign(server.jobs.get('j1'), { state: 'failed' })
    act(() => useAccountJobsStore.getState().apply(job({ state: 'failed' })))
    useGenerationsStore.getState().dismiss('conta:j1')
    await vi.waitFor(() => expect(server.jobs.get('j1').state).toBe('dismissed'))
  })

  it('as linhas da conta não ficam guardadas no aparelho (o servidor é quem tem)', () => {
    act(() => useAccountJobsStore.getState().apply(job({})))
    const kept = Object.keys(localStorage).filter(key => key.startsWith('study-helper:generations')).map(key => localStorage.getItem(key) ?? '')
    expect(kept.join('')).not.toContain('conta:j1')
  })
})
