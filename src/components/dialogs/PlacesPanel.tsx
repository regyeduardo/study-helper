import { useEffect, useMemo, useRef, useState } from 'react'

import type { FileMeta, FolderMeta, Place } from '@/types/domain'
import { Icon } from '@/components/ui/Icon'
import { fileBytes, folderBytes } from '@/lib/storage/file-sizes'
import { filePlaceOf, folderPlaceOf, mixedFolderIds } from '@/lib/storage/place'
import { useAccountStore } from '@/stores/account'
import { useLibraryStore } from '@/stores/library'
import { placesApply, previewMove, sideOfItem, usePlacesStore } from '@/stores/places'
import { useUiStore } from '@/stores/ui'
import { formatBytes } from '@/utils/format'

import '@/styles/places.css'

export const PLACE_LABEL: Record<Place, string> = { drive: 'Google Drive', local: 'Local', app: 'App' }
const FOLLOW = 'segue'
const LOCAL_WARNING = 'O que fica em Local está só neste navegador: não aparece nos seus outros aparelhos, e limpar os dados do navegador apaga.'
const SAFARI_WARNING = 'No Safari do iPhone, fora da tela de início, o navegador apaga o que ficar 7 dias sem abrir.'

/** Safari on an iPhone or iPad opened as a page (not from the home screen) clears a site's data after 7 days unused. */
function safariPage(): boolean {
  const standalone = (navigator as Navigator & { standalone?: boolean }).standalone === true || window.matchMedia?.('(display-mode: standalone)').matches
  return /iPhone|iPad/.test(navigator.userAgent) && !standalone
}

interface Row {
  kind: 'folder' | 'file'
  id: string
  name: string
  depth: number
  own?: Place
  place: Place
  above: Place
  bytes: number
  mixed: boolean
  hasChildren: boolean
}

interface Ask {
  id: string
  kind: 'folder' | 'file'
  name: string
  place: Place
}

/**
 * "Locais", in Configurações › Armazenamento (spec 003, história 9, opção A; once the window "Onde fica cada coisa"): the whole library,
 * each folder and note with its place on its own line; without an own choice it follows the folder above. Changing the place asks first
 * (how many notes, how much space, what Local means) and then moves for real, with the progress in view (FR-052 a FR-055).
 */
export function PlacesPanel({ focusId }: { focusId?: string }) {
  const ui = useUiStore()
  const account = useAccountStore(state => state.active())
  const allFolders = useLibraryStore(state => state.folders)
  const allFiles = useLibraryStore(state => state.files)
  const sizes = useLibraryStore(state => state.sizes)
  const localMedia = useLibraryStore(state => state.localMedia)
  const { running, progress, failed, choosePlace, retry } = usePlacesStore()
  const mixesPlaces = placesApply()
  const signedIn = account.kind === 'google'
  const root: Place = mixesPlaces || signedIn ? 'drive' : 'local'
  const folders = useMemo(() => allFolders.filter(folder => !folder.deletedAt), [allFolders])
  const files = useMemo(() => allFiles.filter(file => !file.deletedAt), [allFiles])
  const [query, setQuery] = useState('')
  const [open, setOpen] = useState<Set<string>>(() => {
    const start = new Set(folders.filter(folder => !folder.parentId).map(folder => folder.id))
    // the item asked for comes with its folders open
    let current = focusId ? (folders.find(folder => folder.id === focusId)?.parentId ?? files.find(file => file.id === focusId)?.folderId) : null
    while (current) {
      start.add(current)
      current = folders.find(folder => folder.id === current)?.parentId ?? null
    }
    return start
  })
  const tree = useRef<HTMLUListElement>(null)
  // opened from "Onde fica…" of an item: that item comes into view
  useEffect(() => {
    tree.current?.querySelector('.pl-focus')?.scrollIntoView?.({ block: 'center' })
  }, [])
  const [ask, setAsk] = useState<Ask | null>(null)
  const [error, setError] = useState<string | null>(null)

  const sizeOf = (file: FileMeta) => fileBytes(file, sizes[file.id], localMedia)
  const mixed = useMemo(() => mixedFolderIds(folders, files, root), [folders, files, root])
  const placeOf = (kind: 'folder' | 'file', item: FolderMeta | FileMeta): Place => (kind === 'folder' ? folderPlaceOf(item.id, folders, root) : filePlaceOf(item as FileMeta, folders, root))
  const term = query.trim().toLocaleLowerCase('pt-BR')
  const matches = (name: string) => !term || name.toLocaleLowerCase('pt-BR').includes(term)

  const rows = useMemo(() => {
    const out: Row[] = []
    const childFolders = (parentId: string | null) => folders.filter(folder => folder.parentId === parentId).sort((a, b) => a.position - b.position || a.name.localeCompare(b.name, 'pt-BR'))
    const childFiles = (folderId: string | null) => files.filter(file => file.folderId === folderId).sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'))
    // with a search, a folder shows when it or something inside it has the term
    const holds = (folderId: string): boolean => matches(folders.find(folder => folder.id === folderId)!.name) || childFiles(folderId).some(file => matches(file.name)) || childFolders(folderId).some(folder => holds(folder.id))
    const walk = (parentId: string | null, depth: number) => {
      for (const folder of childFolders(parentId)) {
        if (term && !holds(folder.id)) continue
        out.push({ kind: 'folder', id: folder.id, name: folder.name, depth, own: folder.place, place: placeOf('folder', folder), above: folderPlaceOf(folder.parentId, folders, root), bytes: folderBytes(folder.id, folders, files, sizeOf), mixed: mixed.has(folder.id), hasChildren: childFolders(folder.id).length + childFiles(folder.id).length > 0 })
        if (term || open.has(folder.id)) walk(folder.id, depth + 1)
      }
      for (const file of childFiles(parentId)) {
        if (!matches(file.name)) continue
        out.push({ kind: 'file', id: file.id, name: file.name, depth, own: file.place, place: placeOf('file', file), above: folderPlaceOf(file.folderId, folders, root), bytes: sizeOf(file), mixed: false, hasChildren: false })
      }
    }
    walk(null, 0)
    return out
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [folders, files, open, term, mixed, sizes, localMedia, root])

  const total = files.length
  const here = files.filter(file => sideOfItem(file.id) === 'local').length
  const totalBytes = files.reduce((sum, file) => sum + sizeOf(file), 0)

  const choose = (row: Row, value: string) => {
    setError(null)
    const place = value === FOLLOW ? row.above : (value as Place)
    if (place === row.place && (value === FOLLOW) === !row.own) return
    setAsk({ id: row.id, kind: row.kind, name: row.name, place })
  }

  const confirm = async () => {
    if (!ask) return
    const target = ask
    setAsk(null)
    try {
      await choosePlace([target.id], target.place)
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Não deu para mudar o lugar.')
    }
  }

  const toggle = (id: string) =>
    setOpen(current => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  const summary = `${total.toLocaleString('pt-BR')} ${total === 1 ? 'nota' : 'notas'} · ${formatBytes(totalBytes)}${mixesPlaces ? `. ${(total - here).toLocaleString('pt-BR')} no Google Drive, ${here.toLocaleString('pt-BR')} só neste navegador` : signedIn ? '' : '. Tudo só neste navegador'}`

  return (
      <section className="pl" aria-label="Locais">
        <p className="muted pl-lead">Cada pasta ou nota fica no lugar escolhido. Sem escolha própria, segue a pasta de cima.</p>
        {!signedIn && (
          <p className="pl-note" role="note">
            Sem login, tudo fica em Local, só neste navegador.{' '}
            <button className="pl-link" onClick={() => ui.open({ kind: 'account' })}>
              Entre com o Google
            </button>{' '}
            para guardar no Google Drive.
          </p>
        )}
        {running && progress && (
          <p className="pl-progress" role="status">
            {`Mudando de lugar: ${progress.done} de ${progress.total}${progress.totalBytes ? ` · ${formatBytes(progress.doneBytes)} de ${formatBytes(progress.totalBytes)}` : ''}. Pode fechar: continua de onde parou.`}
          </p>
        )}
        {failed.length > 0 && !running && (
          <div className="pl-failed" role="alert">
            <b>{failed.length === 1 ? '1 item não mudou de lugar' : `${failed.length} itens não mudaram de lugar`}</b>
            <ul>
              {failed.slice(0, 5).map(record => (
                <li key={record.id}>{`${record.name}: ${record.reason ?? 'falhou'}`}</li>
              ))}
            </ul>
            <span className="muted">Nada foi apagado: cada um continua inteiro onde estava.</span>
            <button className="btn" onClick={() => void retry()}>
              Tentar de novo
            </button>
          </div>
        )}
        {error && (
          <p className="pl-failed" role="alert">
            {error}
          </p>
        )}
        {ask && <AskMove ask={ask} signedIn={signedIn} onCancel={() => setAsk(null)} onConfirm={() => void confirm()} onSignIn={() => ui.open({ kind: 'account' })} />}
        <input className="input pl-search" type="search" placeholder="Buscar pasta ou nota" aria-label="Buscar pasta ou nota" value={query} onChange={event => setQuery(event.target.value)} />
        <div className="pl-head" aria-hidden="true">
          <span>Pasta ou nota</span>
          <span>Fica em</span>
          <span>Tamanho</span>
        </div>
        <ul className="pl-tree" role="tree" aria-label="Biblioteca inteira" ref={tree}>
          {rows.map(row => (
            <li key={row.id} role="treeitem" aria-level={row.depth + 1} aria-expanded={row.kind === 'folder' && row.hasChildren ? open.has(row.id) || Boolean(term) : undefined} aria-label={row.name} className={`pl-row ${focusId === row.id ? 'pl-focus' : ''}`} style={{ '--depth': row.depth } as React.CSSProperties}>
              <span className="pl-name">
                {row.kind === 'folder' ? (
                  // the whole name opens the folder: a target the finger hits on the phone
                  <button className="pl-open" onClick={() => toggle(row.id)} aria-label={`${open.has(row.id) ? 'Fechar' : 'Abrir'} ${row.name}`} disabled={!row.hasChildren}>
                    <span className={`pl-caret ${open.has(row.id) || term ? 'on' : ''}`} aria-hidden="true" />
                    <Icon name="folder" />
                    <span className="pl-title">{row.name}</span>
                  </button>
                ) : (
                  <>
                    <Icon name="file" className="pl-file" />
                    <span className="pl-title">{row.name}</span>
                  </>
                )}
                {row.mixed && (
                  <span className="pl-mixed" title="Tem itens no Google Drive e em Local">
                    2 lugares
                  </span>
                )}
              </span>
              <span className="pl-place">
                <select className={row.own ? 'own' : 'follow'} aria-label={`Onde fica ${row.name}`} value={row.own ?? FOLLOW} onChange={event => choose(row, event.target.value)} disabled={running}>
                  <option value={FOLLOW}>{`Segue: ${PLACE_LABEL[row.above]}`}</option>
                  <option value="drive">Google Drive</option>
                  <option value="local">Local (só neste navegador)</option>
                  <option value="app" disabled>
                    App · liberar com um código
                  </option>
                </select>
              </span>
              <span className="pl-size">{formatBytes(row.bytes)}</span>
            </li>
          ))}
          {!rows.length && <li className="pl-empty muted">{term ? `Nada com “${query.trim()}”.` : 'A biblioteca está vazia.'}</li>}
        </ul>
        <p className="pl-summary muted">{summary}</p>
      </section>
  )
}

function AskMove({ ask, signedIn, onCancel, onConfirm, onSignIn }: { ask: Ask; signedIn: boolean; onCancel(): void; onConfirm(): void; onSignIn(): void }) {
  const preview = previewMove([ask.id], ask.place)
  if (ask.place === 'drive' && !signedIn)
    return (
      <div className="pl-ask" role="alertdialog" aria-label="Entrar para usar o Google Drive">
        <b>Para guardar no Google Drive, entre com o Google.</b>
        <div className="pl-ask-act">
          <button className="btn" onClick={onCancel}>
            Agora não
          </button>
          <button className="btn primary" onClick={onSignIn}>
            Entrar com o Google
          </button>
        </div>
      </div>
    )
  const where = ask.place === 'local' ? 'Local' : 'o Google Drive'
  const what = preview.notes ? `Vão ${preview.notes === 1 ? '1 nota' : `${preview.notes.toLocaleString('pt-BR')} notas`} e ${formatBytes(preview.bytes)} para ${where}.` : `Nada precisa mudar de lugar agora: só a escolha de “${ask.name}” muda.`
  return (
    <div className="pl-ask" role="alertdialog" aria-label={`Levar ${ask.name} para ${where}`}>
      <b>{`Levar “${ask.name}” para ${where}?`}</b>
      <span>{what}</span>
      {ask.place === 'local' ? <span className="pl-warn">{LOCAL_WARNING}</span> : <span className="muted">Aparece em todos os seus aparelhos com esta conta Google.</span>}
      {ask.place === 'local' && safariPage() && <span className="pl-warn">{SAFARI_WARNING}</span>}
      <span className="muted">Cada item só sai de onde está depois de chegar inteiro.</span>
      <div className="pl-ask-act">
        <button className="btn" onClick={onCancel}>
          Cancelar
        </button>
        <button className="btn primary" onClick={onConfirm}>
          {`Levar para ${where}`}
        </button>
      </div>
    </div>
  )
}
