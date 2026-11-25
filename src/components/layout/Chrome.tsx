import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'

import { Icon } from '@/components/ui/Icon'
import { typeInfo } from '@/lib/file-types'
import { paths } from '@/lib/paths'
import { initialsOf, useAccountStore } from '@/stores/account'
import { useLibraryStore } from '@/stores/library'
import { useSyncStore } from '@/stores/sync'
import { useUiStore } from '@/stores/ui'
import { useLiveLibrary, usePathName } from '@/hooks/use-library-view'
import { agoText, formatBytes } from '@/utils/format'
import { useNow } from '@/hooks/use-now'
import { advance, clockOf, estimate, isStalled, startWait, type Wait } from '@/lib/wait'
import { waitEntry } from '@/lib/wait-catalog'

const RECENT_COUNT = 5

export function Avatar({ size }: { size?: number }) {
  const account = useAccountStore(state => state.active())
  const style = size ? { width: size, height: size, fontSize: size * 0.42 } : undefined
  if (account.picture) return <img className="avatar" src={account.picture} alt="" style={style} referrerPolicy="no-referrer" />
  return (
    <span className={`avatar ${account.kind === 'local' ? 'local' : ''}`} style={style}>
      {initialsOf(account)}
    </span>
  )
}

export function AvatarButton() {
  const account = useAccountStore(state => state.active())
  const open = useUiStore(state => state.open)
  return (
    <button className="ibtn" onClick={() => open({ kind: 'account' })} aria-label={`Conta: ${account.name}`} style={{ width: 'auto', padding: '0 2px' }}>
      <Avatar />
    </button>
  )
}

/**
 * What waited without internet going up (spec 007, T139, line "Subir o que esperava sem internet" of the inventory): counted from when
 * it started, so the foot says how much went up, when it should end and that it did not freeze.
 */
function useSendingWait(pending: number, sending: boolean): Wait | null {
  const wait = useRef<Wait | null>(null)
  const now = Date.now()
  if (!sending) wait.current = null
  else if (!wait.current) wait.current = startWait('Enviando as mudanças', { unit: pending === 1 ? 'mudança' : 'mudanças', total: pending, normalStepMs: waitEntry('subir-fila').normalStepMs ?? undefined, now })
  else {
    const current = wait.current
    const done = current.done ?? 0
    // a change made while the others go up joins the count
    const total = Math.max(current.total ?? 0, done + pending)
    if (total - pending !== done || total !== current.total) wait.current = advance(current, { done: total - pending, total, label: 'mudança enviada' }, now)
  }
  return wait.current
}

function sendingTitle(wait: Wait): string {
  if (isStalled(wait)) return `Nada andou desde ${clockOf(wait.lastProgressAt)}.`
  const guess = estimate(wait)
  return `Enviando as mudanças, sem travar: ${wait.done ?? 0} de ${wait.total} já subiram${guess ? `, e deve terminar por volta de ${clockOf(guess.etaAt)}` : ''}`
}

export function SyncPill() {
  const account = useAccountStore(state => state.active())
  const { busy, lastSyncAt, conflicts, error, syncNow, showConflicts } = useSyncStore()
  const hierarchy = useLibraryStore(state => state.hierarchySync)
  const open = useUiStore(state => state.open)
  useNow()
  const sending = Boolean(account.kind !== 'local' && hierarchy && hierarchy.pending > 0 && hierarchy.online)
  // before the return of the Local profile: a hook after it would change their count when the profile changes
  const sendingWait = useSendingWait(hierarchy?.pending ?? 0, sending)
  if (account.kind === 'local') {
    return (
      <button className="sync" onClick={() => open({ kind: 'account' })} title="Perfil local: nada vai para a nuvem">
        <Icon name="cloud" />
        <span className="lbl">Local · sem nuvem</span>
      </button>
    )
  }
  const conflict = conflicts.length > 0 && !busy
  // with the hierarchy on the account (spec 005, escolha C): what waits for the connection, or "Tudo na conta"
  const changes = hierarchy ? `${hierarchy.pending} ${hierarchy.pending === 1 ? 'mudança' : 'mudanças'}` : ''
  const waiting = Boolean(hierarchy && hierarchy.pending > 0 && !hierarchy.online)
  const idle = hierarchy ? `Tudo na conta · ${agoText(lastSyncAt)}` : `Atualizado ${agoText(lastSyncAt)}`
  return (
    <button
      className={`sync ${busy || sending ? 'busy' : ''} ${conflict || error || waiting ? 'warn' : ''}`}
      onClick={() => (conflict ? showConflicts() : void syncNow())}
      title={waiting ? 'Sem conexão com a conta: o que você mudar sobe quando voltar' : sendingWait && !conflict ? sendingTitle(sendingWait) : (error ?? (conflict ? 'Resolver o conflito' : 'Sincronizar agora'))}
    >
      <span className="dot" />
      {conflict ? (
        <span className="lbl">{`${conflicts.length} conflito${conflicts.length > 1 ? 's' : ''} · resolver`}</span>
      ) : waiting ? (
        <>
          <Icon name="warn" />
          <span className="lbl">{`${changes} esperando conexão`}</span>
        </>
      ) : busy || sending ? (
        <>
          <Icon name="sync" />
          {sendingWait ? `Enviando ${sendingWait.done ?? 0} de ${sendingWait.total} ${sendingWait.unit}…` : 'Sincronizando…'}
        </>
      ) : (
        <span className="lbl">{error ? 'Falhou · tentar de novo' : idle}</span>
      )}
    </button>
  )
}

export function UsageLine() {
  const account = useAccountStore(state => state.active())
  const usage = useSyncStore(state => state.usage)
  const limit = useLibraryStore(state => state.index.settings.storageLimitBytes)
  const appOn = useLibraryStore(state => state.appOn)
  // spec 007 (história 5): with the structure on, "App" is the account's space (of 10 GB), the same number as Armazenamento; asked again
  // when the usage changes (after a sync), not the Drive's limit chosen for the app's files
  const [space, setSpace] = useState<{ used: number; limit: number } | null>(null)
  useEffect(() => {
    if (!appOn || account.kind === 'local') return setSpace(null)
    let live = true
    void import('@/controllers/space.controller')
      .then(({ getSpace }) => getSpace())
      .then(answer => live && setSpace({ used: answer.notes + answer.media, limit: answer.limit }))
      .catch(() => undefined)
    return () => {
      live = false
    }
  }, [appOn, account.kind, usage])
  if (!usage) return null
  if (account.kind === 'local') return <span className="usage">Navegador: {formatBytes(usage.appBytes)} usados</span>
  return (
    <span className="usage">
      {appOn ? (space ? `App ${formatBytes(space.used)} de ${formatBytes(space.limit)} · ` : '') : `App ${formatBytes(usage.appBytes)}${limit ? ` de ${formatBytes(limit)}` : ''} · `}
      Drive {formatBytes(usage.cloudUsedBytes)} de {formatBytes(usage.cloudTotalBytes)}
    </span>
  )
}

export function RecentList({ currentId }: { currentId: string | null }) {
  const { files } = useLiveLibrary()
  const openedAt = useLibraryStore(state => state.openedAt)
  const pathName = usePathName()
  const navigate = useNavigate()
  const markOpened = useLibraryStore(state => state.markOpened)
  const recent = useMemo(
    () =>
      files
        .filter(file => file.status !== 'pending')
        .sort((a, b) => (openedAt[b.id] ?? Date.parse(b.updated.at)) - (openedAt[a.id] ?? Date.parse(a.updated.at)))
        .slice(0, RECENT_COUNT),
    [files, openedAt],
  )
  return (
    <>
      {recent.map(file => (
        <button
          key={file.id}
          className="rec"
          draggable
          onDragStart={event => event.dataTransfer.setData('application/x-study-file', file.id)}
          aria-current={currentId === file.id}
          title={pathName(file.folderId)}
          onClick={() => {
            markOpened(file.id)
            navigate(paths.file(file.id))
          }}
        >
          <span className={`rec-ic ${typeInfo(file.type).tone}`}>
            <Icon name="file" />
          </span>
          <span className="rec-t">{file.name}</span>
        </button>
      ))}
    </>
  )
}
