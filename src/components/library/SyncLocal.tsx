import { useMemo, useState } from 'react'

import type { Place } from '@/types/domain'
import { Dialog } from '@/components/ui/Dialog'
import { Icon } from '@/components/ui/Icon'
import { folderBytes } from '@/lib/storage/file-sizes'
import { useLibraryStore } from '@/stores/library'
import { localItems, placesApply, placeSizeOf, sideOfItem, usePlacesStore } from '@/stores/places'
import { useUiStore } from '@/stores/ui'
import { formatBytes } from '@/utils/format'

import '@/styles/places.css'

const notesText = (count: number) => (count === 1 ? '1 nota' : `${count.toLocaleString('pt-BR')} notas`)

/** Re-reads the places whenever the library changes (a move ends with a new snapshot). */
function useLocalItems() {
  const files = useLibraryStore(state => state.files)
  const folders = useLibraryStore(state => state.folders)
  const repo = useLibraryStore(state => state.repo)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useMemo(() => localItems(), [files, folders, repo])
}

/** "Só neste navegador" on a row (FR-055), in a library that mixes the Google Drive and this browser. */
export function LocalMark({ id }: { id: string }) {
  useLibraryStore(state => state.files)
  if (!placesApply() || sideOfItem(id) !== 'local') return null
  return <span className="ex-place pl-local">Só neste navegador</span>
}

/** A Drive note or folder whose real folder is in Local in another browser: it sits in the nearest Drive folder above, saying so (R16). */
export function AwayMark({ awayId }: { awayId?: string }) {
  const known = useLibraryStore(state => Boolean(awayId) && state.folders.some(folder => folder.id === awayId))
  if (!awayId || known) return null
  return <span className="ex-place">A pasta dela está em outro navegador</span>
}

export function useIsLocal(id: string): boolean {
  useLibraryStore(state => state.files)
  return placesApply() && sideOfItem(id) === 'local'
}

/**
 * The "Sincronizar" banner (spec 003, opção S1): at the top of the library while something is only in this browser, with the risk said;
 * on a note's page, only about that note. It goes away by itself when nothing is left in Local (FR-056).
 */
export function SyncLocalBanner({ fileId }: { fileId?: string }) {
  const open = useUiStore(state => state.open)
  const { notes } = useLocalItems()
  const running = usePlacesStore(state => state.running)
  const progress = usePlacesStore(state => state.progress)
  if (!placesApply()) return null
  const mine = fileId ? notes.filter(note => note.id === fileId) : notes
  if (!mine.length) return null
  const bytes = mine.reduce((sum, note) => sum + placeSizeOf(note), 0)
  const text = fileId
    ? 'Esta nota está só neste navegador. Limpar os dados do navegador apaga ela.'
    : `${notesText(mine.length)} ${mine.length === 1 ? 'está' : 'estão'} só neste navegador (${formatBytes(bytes)}). Limpar os dados do navegador apaga ${mine.length === 1 ? 'ela' : 'elas'}.`
  return (
    <div className="pl-banner" role="region" aria-label="Só neste navegador">
      <Icon name="cloud" />
      <span>{running && progress ? `Sincronizando: ${progress.done} de ${progress.total}.` : text}</span>
      <button className="btn primary" onClick={() => open({ kind: 'sync-local', ...(fileId ? { ids: [fileId] } : {}) })} disabled={running}>
        Sincronizar
      </button>
    </div>
  )
}

/** The "Sincronizar" window (opção T): where to (Google Drive; App off, with the way to free it), which ones, how much, and the progress. */
export function SyncLocalDialog({ ids }: { ids?: string[] }) {
  const ui = useUiStore()
  const folders = useLibraryStore(state => state.folders)
  const files = useLibraryStore(state => state.files)
  const { notes, tops } = useLocalItems()
  const { running, progress, failed, syncLocal, retry } = usePlacesStore()
  const offered = ids ? tops.filter(top => ids.includes(top.id)).concat(ids.filter(id => !tops.some(top => top.id === id)).map(id => ({ id, kind: 'file' as const }))) : tops
  const [chosen, setChosen] = useState<Set<string>>(() => new Set(offered.map(top => top.id)))
  // with the structure on, the App is the default place (spec 005, FR-006): each note goes there with its media (US5/AC6)
  const appOn = useLibraryStore(state => state.appOn)
  const [to, setTo] = useState<Place>(() => (appOn ? 'app' : 'drive'))
  const toName = to === 'app' ? 'o App' : 'o Google Drive'
  const [done, setDone] = useState<number | null>(null)
  const live = files.filter(file => !file.deletedAt)
  const pathOf = (folderId: string | null): string => {
    const names: string[] = []
    let current = folderId ? folders.find(folder => folder.id === folderId) : undefined
    while (current && names.length < 32) {
      names.unshift(current.name)
      current = current.parentId ? folders.find(folder => folder.id === current!.parentId) : undefined
    }
    return names.join(' › ')
  }
  const notesUnder = (folderId: string): number => live.filter(file => file.folderId === folderId).length + folders.filter(folder => folder.parentId === folderId && !folder.deletedAt).reduce((sum, folder) => sum + notesUnder(folder.id), 0)
  const items = offered.map(top => {
    if (top.kind === 'folder') {
      const folder = folders.find(item => item.id === top.id)
      return { ...top, name: [pathOf(folder?.parentId ?? null), folder?.name].filter(Boolean).join(' › '), notes: notesUnder(top.id), bytes: folderBytes(top.id, folders, live, placeSizeOf) }
    }
    const file = live.find(item => item.id === top.id)
    return { ...top, name: [pathOf(file?.folderId ?? null), file?.name].filter(Boolean).join(' › '), notes: 1, bytes: file ? placeSizeOf(file) : 0 }
  })
  const picked = items.filter(item => chosen.has(item.id))
  const count = picked.reduce((sum, item) => sum + item.notes, 0)
  const bytes = picked.reduce((sum, item) => sum + item.bytes, 0)
  const totalBytes = notes.reduce((sum, note) => sum + placeSizeOf(note), 0)
  const folderCount = new Set(notes.map(note => note.folderId).filter(Boolean)).size

  const start = async () => {
    const before = count
    await syncLocal(picked.map(item => item.id), to)
    setDone(before)
  }

  return (
    <Dialog
      title="Sincronizar"
      onClose={ui.close}
      footer={
        done !== null && !running ? (
          <button className="btn primary" onClick={ui.close}>
            Fechar
          </button>
        ) : (
          <>
            <button className="btn" onClick={ui.close} disabled={running}>
              Cancelar
            </button>
            <button className="btn primary" onClick={() => void start()} disabled={running || !count}>
              {running ? 'Sincronizando…' : `Sincronizar ${notesText(count)}`}
            </button>
          </>
        )
      }
    >
      <div className="db pl pl-sync">
        <p className="muted">{notes.length ? `${notesText(notes.length)}${folderCount ? ` em ${folderCount === 1 ? '1 pasta' : `${folderCount} pastas`}` : ''} ${notes.length === 1 ? 'está' : 'estão'} só neste navegador · ${formatBytes(totalBytes)}` : 'Nada está só neste navegador.'}</p>
        <fieldset className="pl-dest">
          <legend>Para onde vão?</legend>
          <label className="pl-choice">
            <input type="radio" name="destino" checked={to === 'drive'} onChange={() => setTo('drive')} disabled={running} />
            <span>
              <b>Google Drive</b>
              <span className="muted">Aparecem em todos os seus aparelhos com esta conta Google.</span>
            </span>
          </label>
          {appOn ? (
            <label className="pl-choice">
              <input type="radio" name="destino" checked={to === 'app'} onChange={() => setTo('app')} disabled={running} />
              <span>
                <b>App</b>
                <span className="muted">Guardadas na conta do Estudo, cada uma com a sua mídia. Aparecem em todos os seus aparelhos.</span>
              </span>
            </label>
          ) : (
            <label className="pl-choice off">
              <input type="radio" name="destino" disabled />
              <span>
                <b>App · desligado</b>
                <span className="muted">Guardado na conta do Estudo. Liberar com um código (em breve).</span>
              </span>
            </label>
          )}
        </fieldset>
        {items.length > 0 && (
          <fieldset className="pl-which">
            <legend>Quais</legend>
            {items.map(item => (
              <label key={item.id} className="pl-choice">
                <input
                  type="checkbox"
                  checked={chosen.has(item.id)}
                  disabled={running}
                  onChange={() =>
                    setChosen(current => {
                      const next = new Set(current)
                      if (next.has(item.id)) next.delete(item.id)
                      else next.add(item.id)
                      return next
                    })
                  }
                />
                <span>
                  <b>{item.name}</b>
                  <span className="muted">{`${notesText(item.notes)} · ${formatBytes(item.bytes)}`}</span>
                </span>
              </label>
            ))}
          </fieldset>
        )}
        {count > 0 && done === null && !running && <p className="muted">{`Vão ${notesText(count)} e ${formatBytes(bytes)} para ${toName}. Cada item só sai deste navegador depois de chegar inteiro.`}</p>}
        {running && progress && (
          <p className="pl-progress" role="status">
            {`Andamento: ${progress.done} de ${progress.total}${progress.totalBytes ? ` · ${formatBytes(progress.doneBytes)} de ${formatBytes(progress.totalBytes)}` : ''}. Pode fechar a janela: continua de onde parou.`}
          </p>
        )}
        {done !== null && !running && !failed.length && (
          <p className="pl-progress" role="status">
            {`Pronto: ${notesText(done)} ${to === 'app' ? 'no App' : 'no Google Drive'}.`}
          </p>
        )}
        {failed.length > 0 && !running && (
          <div className="pl-failed" role="alert">
            <b>{failed.length === 1 ? '1 item não foi' : `${failed.length} itens não foram`}</b>
            <span className="muted">Nada foi apagado deste navegador.</span>
            <button className="btn" onClick={() => void retry()}>
              Tentar de novo
            </button>
          </div>
        )}
      </div>
    </Dialog>
  )
}
