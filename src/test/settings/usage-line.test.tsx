// Spec 007, história 5 (revisão de design, 24/11): com a estrutura ligada, o pé da lateral diz o espaço da conta no App (de 10 GB), o
// mesmo número de Configurações › Armazenamento; antes ele dizia "App … de 1 GB" com o limite escolhido para o Google Drive.
import '@/test/account/storage-shim'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'

import { UsageLine } from '@/components/layout/Chrome'
import { env } from '@/lib/env'
import { type Account, LOCAL_ACCOUNT, useAccountStore } from '@/stores/account'
import { useLibraryStore } from '@/stores/library'
import { useSyncStore } from '@/stores/sync'

const GB = 1024 ** 3
const google: Account = { id: 'conta-uso', kind: 'google', name: 'Ana', email: 'ana@example.com', picture: '', token: { accessToken: 'tok', expiresAt: Date.now() + 3600_000 } }

beforeEach(() => {
  env.apiUrl = 'https://api.test'
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ notes: 1 * GB, media: 3 * GB, trash: 0, reserved: 0, used: 4 * GB, limit: 10 * GB, free: 6 * GB, warnAt: 9 * GB, checkedAt: null }), { status: 200, headers: { 'Content-Type': 'application/json' } })))
  useAccountStore.setState({ accounts: [LOCAL_ACCOUNT, google], activeId: google.id, reconnectId: null })
  useSyncStore.setState({ usage: { appBytes: 1024, limitBytes: null, cloudUsedBytes: 1 * GB, cloudTotalBytes: 15 * GB } } as never)
  useLibraryStore.setState({ index: { ...useLibraryStore.getState().index, settings: { ...useLibraryStore.getState().index.settings, storageLimitBytes: 1 * GB } } })
})
afterEach(() => {
  vi.unstubAllGlobals()
  useAccountStore.setState({ activeId: LOCAL_ACCOUNT.id })
  useLibraryStore.setState({ appOn: false })
})

describe('o uso no pé da lateral', () => {
  it('com a estrutura: o App é o espaço da conta, de 10 GB', async () => {
    useLibraryStore.setState({ appOn: true })
    render(<UsageLine />)
    expect(await screen.findByText(/App 4 GB de 10 GB/)).toBeInTheDocument()
    expect(screen.getByText(/Drive 1 GB de 15 GB/)).toBeInTheDocument()
  })

  it('sem a estrutura, como antes: o que o app guarda no Drive, diante do limite escolhido', () => {
    useLibraryStore.setState({ appOn: false })
    render(<UsageLine />)
    expect(screen.getByText(/App 1 KB de 1 GB/)).toBeInTheDocument()
  })
})
