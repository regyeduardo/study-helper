import { useEffect, useState } from 'react'

import { getFreeAiBalanceController } from '@/controllers/ai.controller'
import { type FreeAiBalance, freeAiToken } from '@/lib/ai/free'
import { useAccountStore } from '@/stores/account'
import { useLibraryStore } from '@/stores/library'

export type FreeAiCheck = { kind: 'off' } | { kind: 'loading' } | { kind: 'failed'; message: string } | { kind: 'ready'; balance: FreeAiBalance }

export function useFreeAi(): FreeAiCheck {
  const account = useAccountStore(state => state.active())
  const provider = useLibraryStore(state => state.index.settings.ai.provider)
  const [check, setCheck] = useState<FreeAiCheck>({ kind: 'loading' })
  const active = account.kind === 'google' && provider === 'free'

  useEffect(() => {
    if (!active) return
    let current = true
    setCheck({ kind: 'loading' })
    freeAiToken()
      .then(token => getFreeAiBalanceController(token ?? ''))
      .then(balance => current && setCheck({ kind: 'ready', balance }))
      .catch(error => current && setCheck({ kind: 'failed', message: error instanceof Error ? error.message : 'Não consegui ver a IA grátis de hoje.' }))
    return () => {
      current = false
    }
  }, [active, account.id])

  return active ? check : { kind: 'off' }
}
