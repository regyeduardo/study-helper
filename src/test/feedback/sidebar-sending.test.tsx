// Spec 007, história 6 (T139, linha "Subir o que esperava sem internet" do inventário): enquanto o que esperava sobe, o pé da lateral
// diz quanto já subiu ("Enviando 2 de 5 mudanças…") e, ao passar o mouse, quando deve terminar e que não travou; parado, desde quando.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, render, screen } from '@testing-library/react'

import { SyncPill } from '@/components/layout/Chrome'
import { type Account, LOCAL_ACCOUNT, useAccountStore } from '@/stores/account'
import { useLibraryStore } from '@/stores/library'
import { useSyncStore } from '@/stores/sync'

const google: Account = { id: 'conta-pe', kind: 'google', name: 'Ana', email: 'ana@example.com', picture: '', token: { accessToken: 'tok', expiresAt: Date.now() + 3600_000 } }
const queue = (pending: number, online = true) => act(() => useLibraryStore.setState({ hierarchySync: { pending, online } }))

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: false })
  vi.setSystemTime(new Date(2026, 10, 24, 10, 0, 0))
  useSyncStore.setState({ busy: false, conflicts: [], error: null, lastSyncAt: Date.now() })
  useAccountStore.setState({ accounts: [LOCAL_ACCOUNT, google], activeId: google.id, reconnectId: null })
})

afterEach(() => {
  vi.useRealTimers()
  useAccountStore.setState({ activeId: LOCAL_ACCOUNT.id })
  useLibraryStore.setState({ hierarchySync: null })
})

describe('o pé da lateral enquanto sobe o que esperava', () => {
  it('conta o que já subiu, diz quando termina e que não travou', () => {
    queue(5, false)
    render(<SyncPill />)
    expect(screen.getByText('5 mudanças esperando conexão')).toBeInTheDocument()
    queue(5)
    expect(screen.getByRole('button')).toHaveTextContent('Enviando 0 de 5 mudanças…')
    act(() => vi.advanceTimersByTime(2000))
    queue(3)
    expect(screen.getByRole('button')).toHaveTextContent('Enviando 2 de 5 mudanças…')
    expect(screen.getByRole('button')).toHaveAttribute('title', 'Enviando as mudanças, sem travar: 2 de 5 já subiram, e deve terminar por volta de 10:00')
  })

  it('parado: diz desde quando nada andou', () => {
    queue(4)
    render(<SyncPill />)
    act(() => vi.advanceTimersByTime(61_000))
    queue(4)
    act(() => vi.advanceTimersByTime(1000))
    expect(screen.getByRole('button').getAttribute('title')).toBe('Nada andou desde 10:00.')
  })

  it('trocar para o perfil Local e voltar não derruba o pé da lateral', () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    queue(2)
    render(<SyncPill />)
    act(() => useAccountStore.setState({ activeId: LOCAL_ACCOUNT.id }))
    expect(screen.getByRole('button')).toHaveTextContent('Local · sem nuvem')
    act(() => useAccountStore.setState({ activeId: google.id }))
    expect(screen.getByRole('button')).toHaveTextContent('Enviando 0 de 2 mudanças…')
    expect(errors).not.toHaveBeenCalled()
    errors.mockRestore()
  })

  it('terminou: volta a "Tudo na conta"', () => {
    queue(2)
    render(<SyncPill />)
    queue(0)
    expect(screen.getByRole('button')).toHaveTextContent(/^Tudo na conta/)
  })
})
