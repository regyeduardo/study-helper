import { useEffect, useId, useMemo, useRef, useState } from 'react'

import type { FileMeta, Place } from '@/types/domain'
import { Icon } from '@/components/ui/Icon'
import { fileBytes } from '@/lib/storage/file-sizes'
import { useAccountStore } from '@/stores/account'
import { useLibraryStore } from '@/stores/library'
import { type MoveSummary, placesApply, previewMove, sideOfItem, usePlacesStore } from '@/stores/places'
import { useUiStore } from '@/stores/ui'
import { formatBytes } from '@/utils/format'

import '@/styles/places.css'

export const PLACE_LABEL: Record<Place, string> = { drive: 'Google Drive', local: 'Local', app: 'App' }
/** The buttons of the bar, in the wireframe's order (opção E). */
const DESTINATIONS: Place[] = ['app', 'drive', 'local']
const TO: Record<Place, string> = { app: 'o App', drive: 'o Google Drive', local: 'Local' }
const IN: Record<Place, string> = { app: 'no App', drive: 'no Google Drive', local: 'em Local' }
const LOCAL_WARNING = 'O que fica em Local está só neste navegador: não aparece nos seus outros aparelhos, e limpar os dados do navegador apaga.'
const SAFARI_WARNING = 'No Safari do iPhone, fora da tela de início, o navegador apaga o que ficar 7 dias sem abrir.'

/** Safari on an iPhone or iPad opened as a page (not from the home screen) clears a site's data after 7 days unused. */
function safariPage(): boolean {
  const standalone = (navigator as Navigator & { standalone?: boolean }).standalone === true || window.matchMedia?.('(display-mode: standalone)').matches
  return /iPhone|iPad/.test(navigator.userAgent) && !standalone
}

const notesText = (count: number) => `${count.toLocaleString('pt-BR')} ${count === 1 ? 'nota' : 'notas'}`

interface Row {
  kind: 'folder' | 'file'
  id: string
  name: string
  depth: number
  /** Only a note has a place (spec 005, FR-005); a folder only organizes. */
  place?: Place
  bytes: number
  hasChildren: boolean
}

interface Ask {
  /** Only notes, and only the ones somewhere else than `place`. */
  ids: string[]
  /** One note: its name in quotes; more: "3 notas". */
  name: string
  batch: boolean
  /** Marked notes already in `place`: they neither count nor go. */
  already: number
  place: Place
}

/**
 * "Locais", in Configurações › Armazenamento (spec 005, história 3, opção E "Marcar e levar"): the whole library, where only a note has a
 * place (App, Google Drive or Local) and a folder only organizes. Marking a folder marks every note inside it (and in the folders inside),
 * with "−" when only part is marked; the bar takes the marked notes that are somewhere else to the place chosen, asking first (how many,
 * how much space, what Local means) and then moving for real in the window that holds the app (FR-007 a FR-009, spec 003 FR-064).
 */
export function PlacesPanel({ focusId }: { focusId?: string }) {
  const ui = useUiStore()
  const account = useAccountStore(state => state.active())
  const allFolders = useLibraryStore(state => state.folders)
  const allFiles = useLibraryStore(state => state.files)
  const sizes = useLibraryStore(state => state.sizes)
  const localMedia = useLibraryStore(state => state.localMedia)
  const appOn = useLibraryStore(state => state.appOn)
  const { running, progress, failed, summary: moved, closeSummary, choosePlace, retry } = usePlacesStore()
  const mixesPlaces = placesApply()
  const signedIn = account.kind === 'google'
  const folders = useMemo(() => allFolders.filter(folder => !folder.deletedAt), [allFolders])
  const files = useMemo(() => allFiles.filter(file => !file.deletedAt), [allFiles])
  const allId = useId()
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
  // the marked NOTES (a folder is never marked itself: its box shows the notes inside it)
  const [marked, setMarked] = useState<Set<string>>(() => new Set())
  // when the bar goes away (Limpar, or the move confirmed), the focus comes back to "Marcar tudo" instead of getting lost
  const allBox = useRef<HTMLInputElement | null>(null)
  const clearMarks = () => {
    setMarked(new Set())
    allBox.current?.focus()
  }
  /** The bar is a toolbar: ← → move between its buttons (the disabled ones are skipped), Home and End go to the ends. */
  const barKeys = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')]
    const at = buttons.indexOf(document.activeElement as HTMLButtonElement)
    const to = { ArrowRight: at + 1, ArrowLeft: at - 1, Home: 0, End: buttons.length - 1 }[event.key]
    if (to === undefined || at < 0) return
    event.preventDefault()
    buttons[(to + buttons.length) % buttons.length]?.focus()
  }

  const sizeOf = (file: FileMeta) => fileBytes(file, sizes[file.id], localMedia)
  /** Where a note is right now (during a move, the side the library shows). */
  const placeOf = (id: string): Place => sideOfItem(id)
  const term = query.trim().toLocaleLowerCase('pt-BR')
  const matches = (name: string) => !term || name.toLocaleLowerCase('pt-BR').includes(term)

  // every note inside each folder, and in the folders inside it: what the folder's box marks
  const inside = useMemo(() => {
    const childFolders = new Map<string | null, string[]>()
    for (const folder of folders) childFolders.set(folder.parentId, [...(childFolders.get(folder.parentId) ?? []), folder.id])
    const childFiles = new Map<string | null, string[]>()
    for (const file of files) childFiles.set(file.folderId, [...(childFiles.get(file.folderId) ?? []), file.id])
    const out = new Map<string, string[]>()
    const collect = (id: string, seen: Set<string>): string[] => {
      const known = out.get(id)
      if (known) return known
      // a loop in the data stops where it closes
      if (seen.has(id)) return []
      seen.add(id)
      const list = [...(childFiles.get(id) ?? [])]
      for (const child of childFolders.get(id) ?? []) list.push(...collect(child, seen))
      out.set(id, list)
      return list
    }
    for (const folder of folders) collect(folder.id, new Set())
    return out
  }, [folders, files])
  const byId = useMemo(() => new Map(files.map(file => [file.id, file])), [files])

  const rows = useMemo(() => {
    const out: Row[] = []
    const childFolders = (parentId: string | null) => folders.filter(folder => folder.parentId === parentId).sort((a, b) => a.position - b.position || a.name.localeCompare(b.name, 'pt-BR'))
    const childFiles = (folderId: string | null) => files.filter(file => file.folderId === folderId).sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'))
    // with a search, a folder shows when it or something inside it has the term
    const holds = (folderId: string): boolean => matches(folders.find(folder => folder.id === folderId)!.name) || childFiles(folderId).some(file => matches(file.name)) || childFolders(folderId).some(folder => holds(folder.id))
    const walk = (parentId: string | null, depth: number) => {
      for (const folder of childFolders(parentId)) {
        if (term && !holds(folder.id)) continue
        const notes = inside.get(folder.id) ?? []
        out.push({ kind: 'folder', id: folder.id, name: folder.name, depth, bytes: notes.reduce((sum, id) => sum + sizeOf(byId.get(id)!), 0), hasChildren: childFolders(folder.id).length + childFiles(folder.id).length > 0 })
        if (term || open.has(folder.id)) walk(folder.id, depth + 1)
      }
      for (const file of childFiles(parentId)) {
        if (!matches(file.name)) continue
        out.push({ kind: 'file', id: file.id, name: file.name, depth, place: placeOf(file.id), bytes: sizeOf(file), hasChildren: false })
      }
    }
    walk(null, 0)
    return out
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [folders, files, inside, byId, open, term, sizes, localMedia])

  const counts = { app: 0, drive: 0, local: 0 }
  for (const file of files) counts[placeOf(file.id)]++
  const total = files.length
  const totalBytes = files.reduce((sum, file) => sum + sizeOf(file), 0)

  // the notes marked, the live ones only (one deleted meanwhile drops out)
  const markedNotes = files.filter(file => marked.has(file.id))
  const markedBytes = markedNotes.reduce((sum, file) => sum + sizeOf(file), 0)
  /** The marked notes that are somewhere else than `place`: only these go. */
  const goingTo = (place: Place) => markedNotes.filter(file => placeOf(file.id) !== place)

  // "Marcar tudo" marks every note (with a search, the ones it found)
  const scope = term ? rows.filter(row => row.kind === 'file').map(row => row.id) : files.map(file => file.id)
  const allMarked = scope.length > 0 && scope.every(id => marked.has(id))
  const someMarked = !allMarked && scope.some(id => marked.has(id))
  const markNotes = (ids: string[], on: boolean) =>
    setMarked(current => {
      const next = new Set(current)
      for (const id of ids) {
        if (on) next.add(id)
        else next.delete(id)
      }
      return next
    })
  const markAll = () => markNotes(scope, !allMarked)
  /** A folder all marked unmarks every note inside it; empty or in "−", it marks them all. */
  const markFolder = (id: string) => {
    const notes = inside.get(id) ?? []
    markNotes(notes, !notes.every(note => marked.has(note)))
  }
  const folderState = (id: string): { checked: boolean; mixed: boolean; empty: boolean } => {
    const notes = inside.get(id) ?? []
    const count = notes.filter(note => marked.has(note)).length
    return { checked: notes.length > 0 && count === notes.length, mixed: count > 0 && count < notes.length, empty: notes.length === 0 }
  }

  const take = (place: Place) => {
    setError(null)
    const going = goingTo(place)
    if (!going.length) return
    const one = going.length === 1 ? going[0] : undefined
    setAsk({ ids: going.map(file => file.id), name: one ? `“${one.name}”` : notesText(going.length), batch: !one, already: markedNotes.length - going.length, place })
  }

  const confirm = async () => {
    if (!ask) return
    const target = ask
    setAsk(null)
    clearMarks()
    try {
      await choosePlace(target.ids, target.place)
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

  const where = [counts.app ? `${counts.app.toLocaleString('pt-BR')} no App` : '', `${counts.drive.toLocaleString('pt-BR')} no Google Drive`, `${counts.local.toLocaleString('pt-BR')} só neste navegador`].filter(Boolean).join(', ')
  const summary = `${notesText(total)} · ${formatBytes(totalBytes)}${mixesPlaces ? `. ${where}` : signedIn ? '' : '. Tudo só neste navegador'}`

  const button = (place: Place) => {
    const none = goingTo(place).length === 0
    const locked = place === 'app' && !appOn
    const label = `Levar para ${TO[place]}`
    const why = locked ? 'liberar com um código' : none ? (markedNotes.length === 1 ? 'já está lá' : 'já estão lá') : ''
    return (
      <button key={place} className="btn pl-go" onClick={() => take(place)} disabled={running || Boolean(ask) || locked || none} aria-label={why ? `${label} (${why})` : label} title={locked ? 'App · liberar com um código' : why ? `${markedNotes.length === 1 ? 'A nota marcada já está' : 'As notas marcadas já estão'} ${IN[place]}` : undefined}>
        <span className="pl-go-to">{`Levar para ${TO[place].replace(PLACE_LABEL[place], '')}`.trim()}</span>
        {PLACE_LABEL[place]}
      </button>
    )
  }

  return (
    <section className="pl" aria-label="Locais">
      <p className="muted pl-lead">Cada nota fica num lugar: App, Google Drive ou Local. A pasta não tem lugar, só organiza. Marque as notas, ou uma pasta para marcar todas as de dentro, e escolha para onde levar.</p>
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
      {moved && !running && (
        <div className="pl-done" role="status" aria-label="O que veio para o App">
          {summaryLines(moved).map((line, index) => (index === 0 ? <b key={line}>{line}</b> : <span key={line}>{line}</span>))}
          <button className="btn" onClick={closeSummary}>
            Fechar
          </button>
        </div>
      )}
      {failed.length > 0 && !running && (
        <div className="pl-failed" role="alert">
          <b>{failed.length === 1 ? '1 nota não mudou de lugar' : `${failed.length} notas não mudaram de lugar`}</b>
          <ul>
            {failed.slice(0, 5).map(record => (
              <li key={record.id}>{`${record.name}: ${record.reason ?? 'falhou'}`}</li>
            ))}
          </ul>
          <span className="muted">Nada foi apagado: cada uma continua inteira onde estava.</span>
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
      <input className="input pl-search" type="search" placeholder="Buscar pasta ou nota" aria-label="Buscar pasta ou nota" value={query} onChange={event => setQuery(event.target.value)} />
      <div className="pl-head">
        <span className="pl-check">
          <input
            id={allId}
            ref={input => {
              allBox.current = input
              if (input) input.indeterminate = someMarked
            }}
            type="checkbox"
            aria-label="Marcar tudo"
            aria-checked={someMarked ? 'mixed' : undefined}
            checked={allMarked}
            onChange={markAll}
            disabled={running || !scope.length}
          />
        </span>
        <label className="pl-all" htmlFor={allId}>
          Marcar tudo
        </label>
        <span className="pl-col pl-col-place" aria-hidden="true">
          Fica em
        </span>
        <span className="pl-col" aria-hidden="true">
          Tamanho
        </span>
      </div>
      <ul className="pl-tree" role="tree" aria-label="Biblioteca inteira" ref={tree}>
        {rows.map(row => {
          const state = row.kind === 'folder' ? folderState(row.id) : { checked: marked.has(row.id), mixed: false, empty: false }
          return (
            <li key={row.id} role="treeitem" aria-level={row.depth + 1} aria-expanded={row.kind === 'folder' && row.hasChildren ? open.has(row.id) || Boolean(term) : undefined} aria-label={row.name} className={`pl-row ${row.kind === 'folder' ? 'pl-folder' : ''} ${focusId === row.id ? 'pl-focus' : ''}`} style={{ '--depth': row.depth } as React.CSSProperties}>
              <label className="pl-check" title={state.empty ? 'Pasta sem notas' : undefined}>
                <input
                  ref={input => {
                    if (input) input.indeterminate = state.mixed
                  }}
                  type="checkbox"
                  aria-label={row.kind === 'folder' ? `Marcar as notas de ${row.name}` : `Marcar ${row.name}`}
                  aria-checked={state.mixed ? 'mixed' : undefined}
                  checked={state.checked}
                  onChange={() => (row.kind === 'folder' ? markFolder(row.id) : markNotes([row.id], !marked.has(row.id)))}
                  disabled={running || state.empty}
                />
              </label>
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
              </span>
              {row.place ? <span className="pl-place">{PLACE_LABEL[row.place]}</span> : <span className="pl-place" aria-hidden="true" />}
              <span className="pl-size">{formatBytes(row.bytes)}</span>
            </li>
          )
        })}
        {!rows.length && <li className="pl-empty muted">{term ? `Nada com “${query.trim()}”.` : 'A biblioteca está vazia.'}</li>}
      </ul>
      <p className="pl-summary muted">{summary}</p>
      {(ask || markedNotes.length > 0) && (
        <div className="pl-dock">
          {ask && <AskMove ask={ask} signedIn={signedIn} onCancel={() => setAsk(null)} onConfirm={() => void confirm()} onSignIn={() => ui.open({ kind: 'account' })} />}
          {markedNotes.length > 0 && (
            <div className="selbar pl-bulk" role="toolbar" aria-label="Notas marcadas" onKeyDown={barKeys}>
              <strong aria-live="polite">{`${notesText(markedNotes.length)} ${markedNotes.length === 1 ? 'marcada' : 'marcadas'} · ${formatBytes(markedBytes)}`}</strong>
              <span className="pl-bulk-lead" aria-hidden="true">
                Levar para
              </span>
              <span className="pl-bulk-go">{DESTINATIONS.map(button)}</span>
              <button className="btn pl-bulk-clear" onClick={clearMarks}>
                <Icon name="x" />
                Limpar
              </button>
            </div>
          )}
        </div>
      )}
    </section>
  )
}

function AskMove({ ask, signedIn, onCancel, onConfirm, onSignIn }: { ask: Ask; signedIn: boolean; onCancel(): void; onConfirm(): void; onSignIn(): void }) {
  const preview = previewMove(ask.ids, ask.place)
  if (ask.place === 'drive' && !signedIn)
    return (
      <div className="pl-ask" role="alertdialog" aria-label="Entrar para usar o Google Drive">
        <b>Para guardar no Google Drive, entre com o Google.</b>
        <div className="pl-ask-act">
          <button className="btn" onClick={onCancel}>
            Agora não
          </button>
          <button className="btn primary" onClick={onSignIn} autoFocus>
            Entrar com o Google
          </button>
        </div>
      </div>
    )
  const to = TO[ask.place]
  const what = preview.notes ? `Vão ${notesText(preview.notes)} e ${formatBytes(preview.bytes)} para ${to}.` : 'Nada precisa mudar de lugar agora.'
  const already = ask.already ? ` ${ask.already === 1 ? '1 já está' : `${ask.already.toLocaleString('pt-BR')} já estão`} ${IN[ask.place]} e ${ask.already === 1 ? 'fica' : 'ficam'} onde ${ask.already === 1 ? 'está' : 'estão'}.` : ''
  return (
    <div className="pl-ask" role="alertdialog" aria-label={`Levar ${ask.name} para ${to}`}>
      <b>{`Levar ${ask.name} para ${to}?`}</b>
      <span>{`${what}${already} As pastas continuam como estão.`}</span>
      {ask.place === 'local' ? <span className="pl-warn">{LOCAL_WARNING}</span> : <span className="muted">{ask.place === 'app' ? 'Fica na sua conta do Estudo e aparece em todos os seus aparelhos.' : 'Aparece em todos os seus aparelhos com esta conta Google.'}</span>}
      {ask.place === 'local' && safariPage() && <span className="pl-warn">{SAFARI_WARNING}</span>}
      <span className="muted">Cada nota só sai de onde está depois de chegar inteira.</span>
      <div className="pl-ask-act">
        <button className="btn" onClick={onCancel}>
          Cancelar
        </button>
        <button className="btn primary" onClick={onConfirm} autoFocus>
          {`Levar para ${to}`}
        </button>
      </div>
    </div>
  )
}

const counted = (count: number, one: string, many: string) => `${count.toLocaleString('pt-BR')} ${count === 1 ? one : many}`

/** "3 notas, 2 artefatos e 1 mídia": the parts that are not zero, joined as a sentence. */
function joined(parts: string[]): string {
  return parts.length > 1 ? `${parts.slice(0, -1).join(', ')} e ${parts[parts.length - 1]}` : parts[0]
}

/** The summary of a move to the App, in sentences (FR-043, FR-041). */
export function summaryLines(summary: MoveSummary): string[] {
  const parts = [counted(summary.notes, 'nota', 'notas')]
  if (summary.artifacts) parts.push(counted(summary.artifacts, 'artefato', 'artefatos'))
  if (summary.media) parts.push(counted(summary.media, 'mídia', 'mídias'))
  const single = parts.length === 1 && summary.notes === 1
  const lines = [`${joined(parts)} ${single ? 'veio' : 'vieram'} para o App.`]
  lines.push(
    summary.kept === 'drive'
      ? 'A original continua no Google Drive.'
      : summary.kept === 'local'
        ? 'A original ficou guardada numa cópia neste navegador.'
        : 'A original continua no Google Drive; a deste navegador ficou guardada numa cópia aqui.',
  )
  if (summary.expired)
    lines.push(
      summary.expired === 1
        ? '1 mídia tinha vencido no serviço temporário e chegou como “Só o registro”.'
        : `${summary.expired.toLocaleString('pt-BR')} mídias tinham vencido no serviço temporário e chegaram como “Só o registro”.`,
    )
  return lines
}
