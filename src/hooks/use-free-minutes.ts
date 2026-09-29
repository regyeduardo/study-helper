import { useEffect, useState } from 'react'

import { freeBalanceSeconds, speechSecondsOf } from '@/lib/transcription/free'
import { useAccountStore } from '@/stores/account'
import { useLibraryStore } from '@/stores/library'

export type FreeMinutesCheck =
  | { kind: 'off' }
  | { kind: 'invite' }
  | { kind: 'loading'; measuring: boolean }
  | { kind: 'failed'; message: string }
  | { kind: 'ready'; remainingSeconds: number; speechSeconds: number | null; short: boolean }

export function useFreeMinutes(audio: Blob | null): FreeMinutesCheck {
  const account = useAccountStore(state => state.active())
  const engine = useLibraryStore(state => state.index.settings.transcription.engine)
  const [check, setCheck] = useState<FreeMinutesCheck>({ kind: 'off' })
  const active = account.kind === 'google' && engine === 'free'

  useEffect(() => {
    if (!active) return
    let current = true
    setCheck({ kind: 'loading', measuring: Boolean(audio) })
    Promise.all([freeBalanceSeconds(), audio ? speechSecondsOf(audio) : null])
      .then(([remainingSeconds, speechSeconds]) => {
        if (current) setCheck({ kind: 'ready', remainingSeconds, speechSeconds, short: speechSeconds !== null && speechSeconds > remainingSeconds })
      })
      .catch(error => {
        if (current) setCheck({ kind: 'failed', message: error instanceof Error ? error.message : 'Não consegui ver os minutos grátis de hoje.' })
      })
    return () => {
      current = false
    }
  }, [active, account.id, audio])

  if (account.kind !== 'google') return { kind: 'invite' }
  return active ? check : { kind: 'off' }
}
