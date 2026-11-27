// Spec 005, FR-021 (T051): o servidor recusa um nome que já existe na pasta (409 `name_taken`), mesmo que um app antigo peça. O app diz
// isso com uma frase, nunca "name_taken" cru, e uma nota escrita sem internet que o servidor recusa por isso sai da fila (tentar de novo
// teria a mesma resposta): fica numa cópia neste navegador e o app avisa.
import '@/test/account/storage-shim'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { mockEnv } = vi.hoisted(() => ({ mockEnv: { apiUrl: 'https://api.example.test' } }))
vi.mock('@/lib/env', () => ({ env: mockEnv }))

import { newFileMeta, newSidecar } from '@/lib/defaults'
import { NameTakenError } from '@/lib/names'
import { AppRepository } from '@/lib/storage/app-repository'
import { FakeAppServer } from '@/test/storage/fake-app-server'

let server: FakeAppServer

beforeEach(() => {
  server = new FakeAppServer()
  vi.stubGlobal('fetch', server.fetch)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('o servidor recusa um nome que já existe na pasta', () => {
  it('a gravação falha com a frase que diz qual, sem tentar de novo', async () => {
    const repo = new AppRepository('acc1')
    await repo.load()
    const note = newSidecar(newFileMeta({ name: 'resumo', type: 'class', folderId: null }))
    server.nameTakenFor = { id: note.meta.id, taken: { id: 'outra', name: 'Resumo' } }
    const saving = repo.saveFile(note, '# Resumo')
    await expect(saving).rejects.toBeInstanceOf(NameTakenError)
    await expect(saving).rejects.toThrow('Já existe um item chamado "Resumo" nesta pasta.')
    expect(server.calls.filter(call => call.method === 'PUT' && call.path === `/v1/library/items/${note.meta.id}`)).toHaveLength(1)
  })
})
