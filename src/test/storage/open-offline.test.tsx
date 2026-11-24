// Spec 003, história 6 (T146, US6/AC1): a biblioteca de uma conta Google com a hierarquia na conta abre sem internet. O aparelho guarda a
// última sessão da conta e onde fica a biblioteca no Drive; ao abrir sem rede, mostra a biblioteca do cache (a árvore da conta, as notas
// do App e as de Local) e diz que está sem internet. Com a internet de volta, a sessão de verdade toma o lugar da guardada.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import 'fake-indexeddb/auto'
import { waitFor } from '@testing-library/react'

const { mockEnv } = vi.hoisted(() => ({ mockEnv: { apiUrl: 'https://api.example.test' } }))
vi.mock('@/lib/env', async importOriginal => ({ env: { ...((await importOriginal()) as { env: object }).env, apiUrl: mockEnv.apiUrl } }))

import { CombinedRepository } from '@/lib/storage/combined-repository'
import { type Account, LOCAL_ACCOUNT, useAccountStore } from '@/stores/account'
import { useLibraryStore } from '@/stores/library'
import { useServerAccount } from '@/stores/server-account'
import { useUiStore } from '@/stores/ui'
import { API, FakeAppServer } from '@/test/storage/fake-app-server'
import { FakeDrive, installMemoryStorage, uniqueAccount } from '@/test/storage/fake-drive'

const token = vi.fn(async () => 'tok')
const library = () => useLibraryStore.getState()
const repo = () => library().repo as CombinedRepository

let account: string
let server: FakeAppServer
let offline: boolean

const google = (id: string): Account => ({ id, kind: 'google', name: 'Ana', email: 'ana@example.com', picture: '', token: { accessToken: 'tok', expiresAt: Date.now() + 3600_000 } })

/** The page opened again: nothing in memory, the browser's storage as it was. */
async function reopen() {
  useServerAccount.setState({ me: null, status: 'unknown' })
  useUiStore.setState({ toasts: [] })
  await library().connect(account, token)
}

beforeEach(async () => {
  installMemoryStorage()
  new FakeDrive().install()
  const driveFetch = globalThis.fetch
  server = new FakeAppServer()
  server.hierarchyAt = '2026-11-23T12:00:00Z'
  offline = false
  vi.stubGlobal('fetch', (input: string | URL | Request, init?: RequestInit) => {
    // without internet nothing gets out: neither the account nor the Google Drive
    if (offline) return Promise.reject(new TypeError('Failed to fetch'))
    return String(input).startsWith(API) ? server.fetch(input, init) : driveFetch(input, init)
  })
  vi.stubGlobal('WebSocket', class { send() {} close() {} })
  account = uniqueAccount()
  useUiStore.setState({ overlay: null, toasts: [] })
  useAccountStore.setState({ accounts: [LOCAL_ACCOUNT, google(account)], activeId: account, reconnectId: null })
  // the first opening, with internet: the session comes from the server
  await reopen()
  await waitFor(() => expect(library().appOn && Boolean(repo().hierarchy)).toBe(true))
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  useAccountStore.setState({ activeId: LOCAL_ACCOUNT.id })
  useServerAccount.setState({ me: null, status: 'unknown' })
})

describe('abrir sem internet', () => {
  it('abre a biblioteca do cache, com as notas do App e de Local, e diz que está sem internet', async () => {
    const aula = await library().createFile({ name: 'Aula 1', type: 'class', folderId: null }, 'derivadas')
    await library().createFile({ name: 'Rascunho', type: 'class', folderId: null, place: 'local' }, 'só aqui')
    expect(repo().sideOf(aula.id)).toBe('app')

    offline = true
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false)
    await reopen()

    expect(library().loadError).toBeNull()
    expect(library().files.map(file => file.name).sort()).toEqual(['Aula 1', 'Rascunho'])
    expect(library().appOn).toBe(true)
    expect(repo().hierarchy).toBeTruthy()
    expect(await repo().readContent(aula.id)).toBe('derivadas')
    expect(useUiStore.getState().toasts.map(toast => toast.text)).toContain('Sem internet: a biblioteca abriu com o que está neste aparelho. O que está no Google Drive abre quando a conexão voltar.')
  })

  it('com a internet de volta, a sessão de verdade toma o lugar da guardada', async () => {
    offline = true
    await reopen()
    expect(repo().hierarchy).toBeTruthy()

    // meanwhile the person left the account on another device: the server says so as soon as it answers
    server.signedIn = false
    offline = false
    window.dispatchEvent(new Event('online'))
    await waitFor(() => expect(useServerAccount.getState().status).toBe('signed-out'))
    await waitFor(() => expect(library().appOn).toBe(false))
  })

  it('com a biblioteca aberta, conferir a sessão sem internet não desliga a hierarquia nem o App', async () => {
    offline = true
    await useServerAccount.getState().refresh()
    expect(useServerAccount.getState().status).toBe('offline')
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(repo().hierarchy).toBeTruthy()
    expect(library().appOn).toBe(true)
  })

  it('sem nunca ter aberto com internet neste navegador, diz o motivo em vez de abrir vazio', async () => {
    localStorage.clear()
    offline = true
    await reopen()
    expect(library().loadError).not.toBeNull()
    expect(library().files).toEqual([])
  })

  it('sair da conta esquece a sessão guardada', async () => {
    await useServerAccount.getState().signOut()
    offline = true
    await reopen()
    expect(library().appOn).toBe(false)
  })
})
