import { useEffect, useRef, useState } from 'react'

import { WaitStatus } from '@/components/ui/WaitStatus'
import { startWait } from '@/lib/wait'
import { waitEntry } from '@/lib/wait-catalog'
import { historyOf, recordWait } from '@/lib/wait-history'
import { useAccountStore } from '@/stores/account'

/**
 * A wait with no parts to count (opening the library, opening a link): what happens, when it should end by the last openings of this
 * device (said so), and that it did not freeze (spec 007, FR-060, FR-062). When it ends, its time joins the history.
 */
export function OpeningWait({ kind, what, history }: { kind: string; what: string; history: string }) {
  const accountId = useAccountStore(state => state.activeId)
  const [wait] = useState(() => {
    const entry = waitEntry(kind)
    const usual = historyOf(accountId, kind)
    return startWait(what, { normalStepMs: entry.normalStepMs ?? undefined, ...(usual ? { history: { ms: usual, label: history } } : {}) })
  })
  const started = useRef(wait.startedAt)
  useEffect(() => () => recordWait(accountId, kind, Date.now() - started.current), [accountId, kind])
  return <WaitStatus wait={wait} />
}
