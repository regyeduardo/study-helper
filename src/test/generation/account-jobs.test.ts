// Spec 007, história 2 (research R10b; T064, T066, T081, T083): com a estrutura ligada e a nota no App, a geração vai para a conta (o
// próprio app num Chromium no servidor) e quem pediu recebe o mesmo valor de antes; senão, roda neste aparelho como sempre.
import '@/test/account/storage-shim'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import 'fake-indexeddb/auto'

const { mockEnv } = vi.hoisted(() => ({ mockEnv: { apiUrl: 'https://api.example.test' } }))
vi.mock('@/lib/env', async importOriginal => ({ env: { ...((await importOriginal()) as { env: object }).env, apiUrl: mockEnv.apiUrl } }))

import type { FileMeta } from '@/types/domain'
import { type AccountJob, createJob, listJobs } from '@/controllers/jobs.controller'
import { newFileMeta } from '@/lib/defaults'
import { routeOf, setWorkerMode } from '@/lib/generation/account-routing'
import { packArgs, runOnAccount, unpackArgs, useAccountJobsStore, WAIT_POLL_MS } from '@/stores/account-jobs'
import { useJobsStore } from '@/stores/jobs'
import { useLibraryStore } from '@/stores/library'
import { useSyncStore } from '@/stores/sync'
import { FakeAppServer } from '@/test/storage/fake-app-server'

let server: FakeAppServer

function library(note: Partial<FileMeta>, side: 'app' | 'drive' | 'local', appOn = true) {
  const meta = { ...newFileMeta({ name: 'Reunião de teste', type: 'explanation', folderId: null }), id: 'n1', ...note }
  useLibraryStore.setState({ appOn, sharedView: null, files: [meta], localMedia: [], repo: { sideOf: () => side } as never })
  return meta
}

beforeEach(() => {
  server = new FakeAppServer()
  vi.stubGlobal('fetch', (input: string | URL | Request, init?: RequestInit) => server.fetch(input, init))
  useAccountJobsStore.setState({ jobs: [] })
  setWorkerMode(false)
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
  setWorkerMode(false)
})

describe('controlador', () => {
  it('cria e lista; a mesma chamada da mesma nota devolve o trabalho que já existe', async () => {
    const job = await createJob({ call: 'generateFromNote', args: ['n1', 'explanation'], fileId: 'n1', title: 'Gerando · Reunião' })
    expect(job.state).toBe('queued')
    const again = await createJob({ call: 'generateFromNote', args: ['n1', 'explanation'], fileId: 'n1', title: 'Gerando · Reunião' })
    expect(again.id).toBe(job.id)
    expect((await listJobs()).map(item => item.id)).toEqual([job.id])
  })

  it('sem a estrutura, a conta recusa', async () => {
    server.appEnabled = false
    await expect(createJob({ call: 'generateFromNote', args: [], fileId: null, title: 'x' })).rejects.toMatchObject({ code: 'structure_off' })
  })
})

describe('quando vai para a conta', () => {
  it('estrutura ligada, nota no App, sem arquivo na mão: vai, com o título da nota', () => {
    library({}, 'app')
    expect(routeOf('generateFromNote', ['n1', 'explanation'])).toEqual({ fileId: 'n1', title: 'Gerando · Reunião de teste' })
    expect(routeOf('generateArtifact', [{ fileId: 'n1', kind: 'mapa' }])?.fileId).toBe('n1')
  })

  it('roda aqui: sem a estrutura, nota no Drive ou em Local, arquivo na mão, mídia só neste navegador, na própria página do servidor', () => {
    library({}, 'app', false)
    expect(routeOf('generateFromNote', ['n1'])).toBeNull()
    library({}, 'drive')
    expect(routeOf('generateFromNote', ['n1'])).toBeNull()
    library({}, 'local')
    expect(routeOf('generateFromNote', ['n1'])).toBeNull()
    library({}, 'app')
    expect(routeOf('generateAta', ['n1', [], undefined, undefined, undefined, undefined, new File(['x'], 'reuniao.webm')])).toBeNull()
    library({ origin: { input: 'recording', name: 'r.webm', mime: 'audio/webm', storage: 'none' } }, 'app')
    useLibraryStore.setState({ localMedia: [{ storedName: 'r', fileIds: ['n1'] } as never] })
    expect(routeOf('generateFromNote', ['n1'])).toBeNull()
    library({ origin: { input: 'file', name: 'v.webm', mime: 'video/webm', storage: 'drive', storedFileId: 'drive-123' } }, 'app')
    expect(routeOf('generateFromNote', ['n1'])).toBeNull()
    library({ origin: { input: 'file', name: 'v.webm', mime: 'video/webm', storage: 'drive', storedFileId: 'app:n1/m1' } }, 'app')
    expect(routeOf('generateFromNote', ['n1'])).not.toBeNull()
    // without internet it runs here, and the local path says "Gerar precisa de internet" (T083)
    const online = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false)
    expect(routeOf('generateFromNote', ['n1'])).toBeNull()
    online.mockRestore()
    setWorkerMode(true)
    expect(routeOf('generateFromNote', ['n1'])).toBeNull()
  })

  it('a gravação que subiu para o App vai, mesmo com a cópia guardada neste navegador (FR-031)', () => {
    library({ origin: { input: 'recording', name: 'r.webm', mime: 'audio/webm', storage: 'drive', storedFileId: 'app:n1/m1' } }, 'app')
    useLibraryStore.setState({ localMedia: [{ storedName: 'r', fileIds: ['n1'] } as never] })
    expect(routeOf('transcribeNote', ['n1', undefined, null])?.fileId).toBe('n1')
  })

  it('uma chamada que não está na lista nunca vai', () => {
    library({}, 'app')
    expect(routeOf('saveRecording', ['n1'])).toBeNull()
    expect(routeOf('startNewContent', [{}])).toBeNull()
  })
})

describe('o valor volta para quem pediu', () => {
  it('argumentos ausentes continuam ausentes na volta', () => {
    expect(unpackArgs(JSON.parse(JSON.stringify(packArgs(['n1', undefined, null, 'x']))))).toEqual(['n1', undefined, null, 'x'])
  })

  it('espera o fim pela conta e devolve o resultado; a falha volta com o motivo', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const running = runOnAccount('generateFromNote', ['n1', 'explanation'], 'n1', 'Gerando · Reunião')
    await vi.waitFor(() => expect(server.jobs.size).toBe(1))
    const job = [...server.jobs.values()][0]
    Object.assign(job, { state: 'done', result: 'nota-nova' })
    await vi.advanceTimersByTimeAsync(WAIT_POLL_MS + 10)
    await expect(running).resolves.toBe('nota-nova')
    const failing = runOnAccount('createQuestions', ['n2'], 'n2', 'Prova · Outra')
    const failed = expect(failing).rejects.toThrow('A IA do app está fora do ar agora.')
    await vi.waitFor(() => expect(server.jobs.size).toBe(2))
    Object.assign([...server.jobs.values()][1], { state: 'failed', error: 'A IA do app está fora do ar agora.' })
    await vi.advanceTimersByTimeAsync(WAIT_POLL_MS + 10)
    await failed
  })

  it('o evento do canal ao vivo encerra a espera sem perguntar ao servidor', async () => {
    const running = runOnAccount('generateFromNote', ['n1'], 'n1', 'Gerando')
    await vi.waitFor(() => expect(server.jobs.size).toBe(1))
    const job = [...server.jobs.values()][0]
    useAccountJobsStore.getState().apply({ ...job, state: 'done', result: { id: 'mapa-1' } })
    await expect(running).resolves.toEqual({ id: 'mapa-1' })
  })
})

// 25/11 ("Explicação: handshake" pronta em Gerações e "ainda não foi escrita" na nota): a conta manda a nota que a chamada devolveu
// assim que ela existe, e segue escrevendo; quem pediu recebe a nota nessa hora, como quando roda aqui. Quando o trabalho acaba, este
// aparelho lê a biblioteca de novo, para o que foi escrito aparecer mesmo se o canal ao vivo perdeu a mudança.
describe('a nota que a conta devolve antes de acabar de escrever', () => {
  it('quem pediu recebe a nota quando ela chega no andamento, sem esperar a escrita', async () => {
    const running = runOnAccount('explainSelection', ['n1', 'handshake'], 'n1', 'Explicação · Aula')
    await vi.waitFor(() => expect(server.jobs.size).toBe(1))
    const job = [...server.jobs.values()][0]
    let got: unknown = 'nada'
    void running.then(value => (got = value))
    useAccountJobsStore.getState().apply({ ...job, state: 'running', stage: 'Lendo a Aula' })
    await Promise.resolve()
    expect(got).toBe('nada')
    useAccountJobsStore.getState().apply({ ...job, state: 'running', stage: 'Escrevendo', result: 'explicacao-1' })
    await expect(running).resolves.toBe('explicacao-1')
  })

  it('quando um trabalho acaba na conta, a biblioteca é lida de novo; um que já tinha acabado, não', async () => {
    const syncNow = vi.fn(async () => undefined)
    const realSync = useSyncStore.getState().syncNow
    useSyncStore.setState({ syncNow })
    try {
      const job: AccountJob = { id: 'j1', call: 'explainSelection', kind: 'generation', fileId: 'n1', title: 'Explicação · Aula', state: 'running', queuePosition: null, stage: 'Escrevendo', fraction: 0.5, etaAt: null, etaBasis: null,
        lastProgress: null, lastProgressAt: null, stalledSince: null, args: [], result: 'explicacao-1', error: null, errorCode: null, attempt: 1, createdAt: '2026-11-25T22:52:16Z', startedAt: '2026-11-25T22:52:16Z', finishedAt: null }
      useAccountJobsStore.setState({ jobs: [{ ...job, id: 'velho', state: 'done' }] })
      useAccountJobsStore.getState().apply({ ...job })
      expect(syncNow).not.toHaveBeenCalled()
      useAccountJobsStore.getState().apply({ ...job, state: 'done', finishedAt: '2026-11-25T22:53:00Z' })
      await vi.waitFor(() => expect(syncNow).toHaveBeenCalledTimes(1))
    } finally {
      useSyncStore.setState({ syncNow: realSync })
    }
  })
})

describe('a store de gerações', () => {
  it('com a nota no App, a chamada vai para a conta e não roda nada aqui', async () => {
    library({}, 'app')
    const result = useJobsStore.getState().createQuestions('n1')
    await vi.waitFor(() => expect(server.jobs.size).toBe(1))
    const job = [...server.jobs.values()][0]
    expect(job.call).toBe('createQuestions')
    expect(useJobsStore.getState().jobs).toEqual([])
    useAccountJobsStore.getState().apply({ ...job, state: 'done', result: { count: 12, web: null } })
    await expect(result).resolves.toEqual({ count: 12, web: null })
  })
})

// "Mando transcrever e não acontece nada, não abre um loading" (dono, 24/11): o app publicado manda a transcrição para a conta, mas a API
// publicada ainda não tinha a rota de trabalhos (404); o erro sumia e nada aparecia. Sem trabalhos na conta, roda aqui, como antes;
// qualquer outra falha ao pedir à conta aparece, nunca some.
describe('quando a conta não recebe o trabalho', () => {
  it('o serviço sem a rota de trabalhos (404): roda aqui, como antes', async () => {
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ error: 'not_found' }), { status: 404, headers: { 'Content-Type': 'application/json' } }))
    const here = vi.fn(async () => 'feito aqui')
    await expect(runOnAccount('transcribeNote', ['n1'], 'n1', 'Transcrição · Reunião', here)).resolves.toBe('feito aqui')
    expect(here).toHaveBeenCalledTimes(1)
  })

  it('sem internet ou com a estrutura desligada no serviço: roda aqui', async () => {
    const here = vi.fn(async () => 'feito aqui')
    vi.stubGlobal('fetch', async () => {
      throw new TypeError('Failed to fetch')
    })
    await expect(runOnAccount('transcribeNote', ['n1'], 'n1', 'Transcrição', here)).resolves.toBe('feito aqui')
    server.appEnabled = false
    vi.stubGlobal('fetch', (input: string | URL | Request, init?: RequestInit) => server.fetch(input, init))
    await expect(runOnAccount('transcribeNote', ['n1'], 'n1', 'Transcrição', here)).resolves.toBe('feito aqui')
    expect(here).toHaveBeenCalledTimes(2)
  })

  it('outra recusa da conta não some: aparece um trabalho com falha e o motivo, e quem pediu recebe o erro', async () => {
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ error: 'internal_error' }), { status: 500, headers: { 'Content-Type': 'application/json' } }))
    const here = vi.fn(async () => 'feito aqui')
    await expect(runOnAccount('transcribeNote', ['n1'], 'n1', 'Transcrição · Reunião', here)).rejects.toThrow()
    expect(here).not.toHaveBeenCalled()
    const failed = useJobsStore.getState().jobs.find(job => job.fileId === 'n1' && job.status === 'error')
    expect(failed?.title).toBe('Transcrição · Reunião')
    expect(failed?.error).toMatch(/conta/)
  })
})
