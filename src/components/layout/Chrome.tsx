import { useMemo } from 'react'
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

export function SyncPill() {
  const account = useAccountStore(state => state.active())
  const { busy, lastSyncAt, conflicts, error, syncNow, showConflicts } = useSyncStore()
  const open = useUiStore(state => state.open)
  useNow()
  if (account.kind === 'local') {
    return (
      <button className="sync" onClick={() => open({ kind: 'account' })} title="Perfil local: nada vai para a nuvem">
        <Icon name="cloud" />
        Local · sem nuvem
      </button>
    )
  }
  const conflict = conflicts.length > 0 && !busy
  return (
    <button
      className={`sync ${busy ? 'busy' : ''} ${conflict || error ? 'warn' : ''}`}
      onClick={() => (conflict ? showConflicts() : void syncNow())}
      title={error ?? (conflict ? 'Resolver o conflito' : 'Sincronizar agora')}
    >
      <span className="dot" />
      {busy ? (
        <>
          <Icon name="sync" />
          Sincronizando…
        </>
      ) : conflict ? (
        `${conflicts.length} conflito${conflicts.length > 1 ? 's' : ''} · resolver`
      ) : error ? (
        'Falhou · tentar de novo'
      ) : (
        `Atualizado ${agoText(lastSyncAt)}`
      )}
    </button>
  )
}

export function UsageLine() {
  const account = useAccountStore(state => state.active())
  const usage = useSyncStore(state => state.usage)
  const limit = useLibraryStore(state => state.index.settings.storageLimitBytes)
  if (!usage) return null
  if (account.kind === 'local') return <span className="usage">Navegador: {formatBytes(usage.appBytes)} usados</span>
  return (
    <span className="usage">
      App {formatBytes(usage.appBytes)}
      {limit ? ` de ${formatBytes(limit)}` : ''} · Drive {formatBytes(usage.cloudUsedBytes)} de {formatBytes(usage.cloudTotalBytes)}
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
