import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'

import { AccountMenu } from '@/components/dialogs/AccountMenu'
import { env } from '@/lib/env'
import { LOCAL_ACCOUNT, useAccountStore } from '@/stores/account'
import { useUiStore } from '@/stores/ui'

const GOOGLE = { id: 'g-1', kind: 'google' as const, name: 'Ana Souza', email: 'ana@example.com', picture: '', token: { accessToken: 'google-token', expiresAt: Date.now() + 3600_000 } }
let unlocks: { authorization: string | null; body: unknown }[]

function photo(container: HTMLElement) {
  return container.querySelector('.who .avatar') as HTMLElement
}

beforeEach(() => {
  env.transcriptionWorkerUrl = 'https://free-ai.test'
  unlocks = []
  vi.useFakeTimers({ toFake: ['Date'] })
  useAccountStore.setState({ accounts: [LOCAL_ACCOUNT, GOOGLE], activeId: GOOGLE.id, reconnectId: null })
  useUiStore.setState({ toasts: [] })
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init: RequestInit = {}) => {
      const body = JSON.parse(String(init.body))
      unlocks.push({ authorization: new Headers(init.headers).get('Authorization'), body })
      return new Response('{}', { status: body.code === 'segredo' ? 200 : 403 })
    }),
  )
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('secret code in the account menu', () => {
  it('five quick taps on the photo open the code field and the right code shows only "Uau"', async () => {
    const { container } = render(<AccountMenu />)
    for (let i = 0; i < 5; i++) fireEvent.click(photo(container))
    fireEvent.change(screen.getByLabelText('Código'), { target: { value: 'segredo' } })
    fireEvent.submit(screen.getByLabelText('Código'))
    await waitFor(() => expect(useUiStore.getState().toasts.map(toast => toast.text)).toEqual(['Uau']))
    expect(unlocks[0]).toEqual({ authorization: 'Bearer google-token', body: { code: 'segredo' } })
    expect(screen.queryByLabelText('Código')).not.toBeInTheDocument()
  })

  it('a wrong code closes the field without any message', async () => {
    const { container } = render(<AccountMenu />)
    for (let i = 0; i < 5; i++) fireEvent.click(photo(container))
    fireEvent.change(screen.getByLabelText('Código'), { target: { value: 'errado' } })
    fireEvent.submit(screen.getByLabelText('Código'))
    await waitFor(() => expect(screen.queryByLabelText('Código')).not.toBeInTheDocument())
    expect(useUiStore.getState().toasts).toEqual([])
  })

  it('taps spread over more than 2 seconds do not open it', () => {
    const { container } = render(<AccountMenu />)
    for (let i = 0; i < 5; i++) {
      vi.setSystemTime(new Date(Date.now() + 600))
      fireEvent.click(photo(container))
    }
    expect(screen.queryByLabelText('Código')).not.toBeInTheDocument()
  })

  it('never opens in the Local profile', () => {
    useAccountStore.setState({ activeId: LOCAL_ACCOUNT.id })
    const { container } = render(<AccountMenu />)
    for (let i = 0; i < 6; i++) fireEvent.click(photo(container))
    expect(screen.queryByLabelText('Código')).not.toBeInTheDocument()
  })
})
