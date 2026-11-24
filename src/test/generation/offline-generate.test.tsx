// Spec 003, história 6 (T145, US6/AC4): sem internet, pedir uma geração ou uma transcrição diz que gerar precisa de internet, e a falha
// fica guardada em Gerações para "Tentar de novo" quando a conexão voltar (escolha B das gerações).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useJobsStore } from '@/stores/jobs'
import { useLibraryStore } from '@/stores/library'
import { flowLibrary } from '@/test/generation/flow-fixture'

const OFFLINE = 'Gerar precisa de internet. Quando a conexão voltar, use “Tentar de novo” em Gerações.'

beforeEach(() => {
  // no request gets out: the network is off
  flowLibrary(() => Promise.reject(new TypeError('Failed to fetch')))
  vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false)
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('gerar sem internet', () => {
  it('pedir a aula de uma nota pendente diz que gerar precisa de internet', async () => {
    const aula = await useLibraryStore.getState().createFile({ name: 'Aula 2', type: 'class', folderId: null, status: 'pending', pendingExcerpt: 'limites laterais' }, '')

    await useJobsStore.getState().generatePending(aula.id)

    const job = useJobsStore.getState().jobs.find(item => item.fileId === aula.id)
    expect(job).toMatchObject({ status: 'error', error: OFFLINE })
    // nothing was lost: the note waits as it was
    expect(useLibraryStore.getState().files.find(file => file.id === aula.id)).toMatchObject({ status: 'pending' })
  })

  it('com internet, a falha continua dizendo o que houve', async () => {
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true)
    flowLibrary(() => new Response(JSON.stringify({ error: { message: 'chave recusada' } }), { status: 401, headers: { 'Content-Type': 'application/json' } }))
    const aula = await useLibraryStore.getState().createFile({ name: 'Aula 3', type: 'class', folderId: null, status: 'pending', pendingExcerpt: 'limites laterais' }, '')
    await useJobsStore.getState().generatePending(aula.id)
    const job = useJobsStore.getState().jobs.find(item => item.fileId === aula.id)
    expect(job?.status).toBe('error')
    expect(job?.error).not.toBe(OFFLINE)
  })
})
