// Spec 007, história 2 (research R10b, T073): a página de trabalho que o servidor abre num Chromium sem tela. Ela entra com a sessão
// do trabalho, liga só o App e a hierarquia da conta, roda a chamada pedida e manda o andamento e o fim (o valor, ou o motivo).
import '@/test/account/storage-shim'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import 'fake-indexeddb/auto'

const { mockEnv } = vi.hoisted(() => ({ mockEnv: { apiUrl: 'https://api.example.test' } }))
vi.mock('@/lib/env', async importOriginal => ({ env: { ...((await importOriginal()) as { env: object }).env, apiUrl: mockEnv.apiUrl } }))

import { routeOf, setWorkerMode } from '@/lib/generation/account-routing'
import { REPORT_EVERY_MS, runWorker } from '@/lib/generation/worker'
import { useJobsStore } from '@/stores/jobs'
import { useLibraryStore } from '@/stores/library'
import { FakeAppServer } from '@/test/storage/fake-app-server'
import { installMemoryStorage } from '@/test/storage/fake-drive'

let server: FakeAppServer
const realRegenerate = useJobsStore.getState().regenerate

beforeEach(() => {
  installMemoryStorage()
  server = new FakeAppServer()
  server.hierarchyAt = '2026-11-23T12:00:00Z'
  vi.stubGlobal('fetch', (input: string | URL | Request, init?: RequestInit) => server.fetch(input, init))
  vi.stubGlobal('WebSocket', class { send() {} close() {} })
  server.jobs.set('job-1', { id: 'job-1', call: 'regenerate', args: ['n1', { $indefinido: true }], state: 'running', attempt: 1 })
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
  useJobsStore.setState({ regenerate: realRegenerate, jobs: [] })
  setWorkerMode(false)
})

describe('a página de trabalho', () => {
  it('liga a biblioteca da conta, roda a chamada, manda o andamento e o valor', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const seen: unknown[][] = []
    useJobsStore.setState({
      regenerate: async (...args: unknown[]) => {
        seen.push(args)
        // the call makes its own job in the store, as the real ones do, and moves it
        useJobsStore.setState({ jobs: [{ id: 'local-1', kind: 'generation', title: 'Gerando', fileId: 'n1', status: 'running', message: 'Escrevendo', fraction: 0.5, error: null, startedAt: Date.now() }] })
        await vi.advanceTimersByTimeAsync(REPORT_EVERY_MS + 50)
        return 'nota-nova' as never
      },
    })
    await runWorker('job-1')
    expect(useLibraryStore.getState().appOn).toBe(true)
    expect(useLibraryStore.getState().ready).toBe(true)
    // the absent argument came back absent
    expect(seen).toEqual([['n1', undefined]])
    const job = server.jobs.get('job-1')
    expect(job.state).toBe('done')
    expect(job.result).toBe('nota-nova')
    expect(server.calls.some(call => call.path === '/v1/jobs/job-1/progress')).toBe(true)
    // on the job page, nothing goes back to the account
    expect(routeOf('regenerate', ['n1'])).toBeNull()
  })

  it('a falha volta com o motivo; a IA fora do ar tem o seu código', async () => {
    useJobsStore.setState({
      regenerate: async () => {
        throw new Error('A IA do app está fora do ar agora.')
      },
    })
    await runWorker('job-1')
    const job = server.jobs.get('job-1')
    expect(job.state).toBe('failed')
    expect(job.error).toBe('A IA do app está fora do ar agora.')
    expect(job.errorCode).toBe('ai_unavailable')
  })
})
