import { useCallback, useEffect, useState } from 'react'

import { Icon } from '@/components/ui/Icon'
import { type AccountSpace as Space, getSpace, type LargeItem, largestItems } from '@/controllers/space.controller'
import { working } from '@/lib/working'
import { useLibraryStore } from '@/stores/library'
import { formatBytes } from '@/utils/format'

import '@/styles/account-space.css'

/**
 * The space of the account in the App (spec 007, história 5, FR-050 to FR-053; owner's choice C of 21/11, "maiores primeiro"): notes,
 * media and the Lixeira apart, what is left of the 10 GB, the warning from 9 GB, and "Liberar espaço" with the biggest first and what
 * can be done with each. Every action uses what the library already does (Locais, apagar só a mídia, Lixeira).
 */
export function AccountSpace({ onMove }: { onMove(id: string): void }) {
  const [space, setSpace] = useState<Space | null>(null)
  const [items, setItems] = useState<LargeItem[] | null>(null)
  const [open, setOpen] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const library = useLibraryStore.getState

  const refresh = useCallback(async () => {
    try {
      setSpace(await getSpace())
      setError(null)
    } catch {
      setError('Não deu para ler o espaço da conta agora.')
    }
  }, [])
  const loadItems = useCallback(async () => setItems(await largestItems().catch(() => [])), [])

  useEffect(() => void refresh(), [refresh])
  useEffect(() => {
    if (open) void loadItems()
  }, [open, loadItems])

  // after an action the space shown changes (FR-053), and the list follows
  const after = async () => {
    await refresh()
    if (open) await loadItems()
  }
  const act = (title: string, run: () => Promise<unknown>) => void working(title, run).then(ok => {
    if (ok) void after()
  })

  if (error) return <p className="muted">{error}</p>
  if (!space) return <p className="muted" role="status">Lendo o espaço da conta…</p>
  const share = (bytes: number) => `${Math.max(0, Math.min(100, (bytes / space.limit) * 100))}%`
  const near = space.used >= space.warnAt
  const full = space.free <= 0

  return (
    <div className="field acc-space">
      <span className="lab">Espaço no App</span>
      <div className="acc-bar" role="img" aria-label={`${formatBytes(space.used)} de ${formatBytes(space.limit)} usados`}>
        <i className="notes" style={{ width: share(space.notes) }} />
        <i className="media" style={{ width: share(space.media) }} />
        <i className="trash" style={{ width: share(space.trash) }} />
      </div>
      <ul className="acc-legend">
        <li>
          <i className="notes" /> Notas <b>{formatBytes(space.notes)}</b>
        </li>
        <li>
          <i className="media" /> Mídia <b>{formatBytes(space.media)}</b>
        </li>
        <li>
          <i className="trash" /> Lixeira <b>{formatBytes(space.trash)}</b>
        </li>
      </ul>
      <span className="usage">
        {formatBytes(space.used)} de {formatBytes(space.limit)} · faltam {formatBytes(space.free)}
      </span>
      {(near || full) && (
        <div className={`banner ${full ? '' : 'info'}`} role={full ? 'alert' : 'status'}>
          <Icon name="warn" />
          <span>
            {full
              ? 'O App da sua conta está cheio. Arquivos e mídias novas não vão para o App: guarde no Google Drive ou em Local, ou libere espaço. O texto que você escreve continua sendo guardado.'
              : `O App da sua conta está quase cheio: faltam ${formatBytes(space.free)}.`}
          </span>
        </div>
      )}
      <div className="acc-actions">
        <button className="btn" aria-expanded={open} onClick={() => setOpen(value => !value)}>
          <Icon name="trash" />
          Liberar espaço
        </button>
        {space.trash > 0 && (
          <button className="btn quiet" onClick={() => act('Esvaziando a Lixeira…', () => library().emptyTrash())}>
            Esvaziar a Lixeira ({formatBytes(space.trash)})
          </button>
        )}
      </div>
      {open && (
        <div className="acc-largest" aria-label="O que mais ocupa no App">
          {items === null ? (
            <p className="muted" role="status">
              Procurando o que mais ocupa…
            </p>
          ) : !items.length ? (
            <p className="muted">Nada guardado no App ainda.</p>
          ) : (
            <ol>
              {items.map(item => (
                <li key={item.id}>
                  <div className="acc-item">
                    <b>{item.name}</b>
                    <span className="faint">
                      {item.folderPath}
                      {item.trashed ? ' · na Lixeira' : ''}
                    </span>
                  </div>
                  <span className="acc-size">{formatBytes(item.noteBytes + item.mediaBytes)}</span>
                  <div className="acc-item-actions">
                    <button className="btn quiet" onClick={() => onMove(item.id)}>
                      Mover…
                    </button>
                    {item.mediaBytes > 0 && (
                      <button className="btn quiet" onClick={() => act(`Apagando a mídia de "${item.name}"…`, () => library().removeMedia(item.id))}>
                        Apagar só a mídia
                      </button>
                    )}
                    {!item.trashed && (
                      <button className="btn quiet danger" onClick={() => act(`Apagando "${item.name}"…`, () => library().trashFiles([item.id]))}>
                        Apagar
                      </button>
                    )}
                  </div>
                </li>
              ))}
            </ol>
          )}
        </div>
      )}
    </div>
  )
}
