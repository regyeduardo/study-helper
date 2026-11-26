// Spec 007, história 2 (research R10b, T073): a página de trabalho que o servidor abre num Chromium sem tela. Ela entra com a sessão
// do trabalho, liga só o App e a hierarquia da conta, roda a chamada pedida e manda o andamento e o fim (o valor, ou o motivo).
import '@/test/account/storage-shim'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import 'fake-indexeddb/auto'

const { mockEnv } = vi.hoisted(() => ({ mockEnv: { apiUrl: 'https://api.example.test' } }))
vi.mock('@/lib/env', async importOriginal => ({ env: { ...((await importOriginal()) as { env: object }).env, apiUrl: mockEnv.apiUrl } }))

import { routeOf, setWorkerMode } from '@/lib/generation/account-routing'
import { inBackground } from '@/lib/generation/background'
import { REPORT_EVERY_MS, runWorker } from '@/lib/generation/worker'
import { appAiConfig, useAppAiStore } from '@/lib/ai/app-ai'
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
  useAppAiStore.setState({ config: null, providers: [] })
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

  // "Não está gerando transcrição" (24/11): a transcrição e as gerações fecham o próprio trabalho com o erro e terminam sem lançar; o
  // servidor dava o trabalho da conta como pronto, e no aparelho nada aparecia
  it('a chamada que fecha o próprio trabalho com erro volta como falha, com o motivo', async () => {
    useJobsStore.setState({
      regenerate: async () => {
        useJobsStore.setState({ jobs: [{ id: 'local-1', kind: 'transcription', title: 'Reunião', fileId: 'n1', status: 'error', message: 'A transcrição não saiu.', fraction: null, error: 'Nenhum modelo de transcrição escolhido.', startedAt: Date.now() }] })
        return undefined as never
      },
    })
    await runWorker('job-1')
    const job = server.jobs.get('job-1')
    expect(job.state).toBe('failed')
    expect(job.error).toBe('A transcrição não saiu. Nenhum modelo de transcrição escolhido.')
  })

  // the app's AI used to be asked without waiting: a call could start before it came and fall back to the person's own AI, with no model
  it('a IA do app chega antes da chamada rodar', async () => {
    let seen: unknown = null
    useJobsStore.setState({
      regenerate: async () => {
        seen = appAiConfig()
        return 'ok' as never
      },
    })
    await runWorker('job-1')
    expect(server.jobs.get('job-1').state).toBe('done')
    expect(seen).toMatchObject({ defaults: { transcricao: 'ouvir' } })
  })

  it('sem a IA do app, falha dizendo por quê, sem rodar a chamada', async () => {
    server.aiConfig = null
    const run = vi.fn(async () => 'ok' as never)
    useJobsStore.setState({ regenerate: run })
    await runWorker('job-1')
    const job = server.jobs.get('job-1')
    expect(run).not.toHaveBeenCalled()
    expect(job.state).toBe('failed')
    expect(job.error).toMatch(/IA do app/)
    expect(job.errorCode).toBe('ai_unavailable')
  })

  // 25/11 ("Explicação: handshake" pronta em Gerações e "ainda não foi escrita" na nota): "Explicar" e "Gerar desta nota" devolvem a
  // nota na hora e escrevem depois; o trabalho acabava ali, a sessão saía e a escrita morria com a página. Agora a nota vai no andamento
  // (o aparelho abre ela como antes) e o fim só vem quando a escrita acaba.
  it('a chamada que devolve a nota e segue escrevendo: a nota vai no andamento, e o fim só vem com a escrita', async () => {
    let write: () => void = () => {}
    useJobsStore.setState({
      regenerate: async () => {
        useJobsStore.setState({ jobs: [{ id: 'local-1', kind: 'generation', title: 'Explicação', fileId: 'nota-nova', status: 'running', message: 'Escrevendo', fraction: 0.2, error: null, startedAt: Date.now() }] })
        void inBackground(
          new Promise<void>(resolve => {
            write = () => {
              useJobsStore.setState({ jobs: [{ id: 'local-1', kind: 'generation', title: 'Explicação', fileId: 'nota-nova', status: 'done', message: 'Pronto', fraction: 1, error: null, startedAt: Date.now() }] })
              resolve()
            }
          }),
        )
        return 'nota-nova' as never
      },
    })
    const working = runWorker('job-1')
    await vi.waitFor(() => expect(server.jobs.get('job-1').result).toBe('nota-nova'))
    expect(server.jobs.get('job-1').state).toBe('running')
    expect(server.calls.some(call => call.path === '/v1/jobs/job-1/finish')).toBe(false)
    write()
    await working
    expect(server.jobs.get('job-1')).toMatchObject({ state: 'done', result: 'nota-nova' })
  })

  it('a escrita que segue depois falha: o trabalho falha com o motivo', async () => {
    useJobsStore.setState({
      regenerate: async () => {
        useJobsStore.setState({ jobs: [{ id: 'local-1', kind: 'generation', title: 'Explicação', fileId: 'nota-nova', status: 'running', message: 'Escrevendo', fraction: 0.2, error: null, startedAt: Date.now() }] })
        // it fails a moment after the call gave the note back
        void inBackground(
          new Promise(resolve => setTimeout(resolve, 50)).then(() =>
            useJobsStore.setState({ jobs: [{ id: 'local-1', kind: 'generation', title: 'Explicação', fileId: 'nota-nova', status: 'error', message: 'A explicação não saiu.', fraction: null, error: 'A IA não respondeu.', startedAt: Date.now() }] }),
          ),
        )
        return 'nota-nova' as never
      },
    })
    await runWorker('job-1')
    expect(server.jobs.get('job-1')).toMatchObject({ state: 'failed', error: 'A explicação não saiu. A IA não respondeu.' })
  })

  it('cancelada lá dentro, também não volta como pronta', async () => {
    useJobsStore.setState({
      regenerate: async () => {
        useJobsStore.setState({ jobs: [{ id: 'local-1', kind: 'transcription', title: 'Reunião', fileId: 'n1', status: 'cancelled', message: 'Cancelado.', fraction: null, error: null, startedAt: Date.now() }] })
        return undefined as never
      },
    })
    await runWorker('job-1')
    expect(server.jobs.get('job-1').state).toBe('failed')
  })
})
