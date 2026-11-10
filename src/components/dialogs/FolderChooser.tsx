import { type CSSProperties, Fragment, type KeyboardEvent, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

import '@/styles/folder-chooser.css'

import type { FolderMeta } from '@/types/domain'
import { Dialog } from '@/components/ui/Dialog'
import { FolderIcon } from '@/components/ui/FolderIcon'
import { Icon } from '@/components/ui/Icon'
import { searchWords } from '@/lib/library-search'
import { liveFolders, useLibraryStore } from '@/stores/library'

/** A folder offered before it exists: the one named after the note. Whoever confirms it makes it. */
export type ProposedFolder = Pick<FolderMeta, 'id' | 'name' | 'parentId'>

type Entry = ProposedFolder & Partial<Pick<FolderMeta, 'favorite' | 'color' | 'position'>>

interface ChoiceOptions {
  /** Hidden, with everything inside them. */
  exclude?: string[]
  extra?: ProposedFolder
  /** What will be saved: closes the "Fica em" line. */
  leaf?: string
  hint?(id: string | null): string
}

export interface FolderChooserProps extends ChoiceOptions {
  value: string | null
  onChange(id: string | null): void
  /** Enter on the marked folder. */
  onConfirm?(id: string | null): void
  /** Esc with the filter empty; without it, the key goes on to the dialog around. */
  onCancel?(): void
  autoFocus?: boolean
}

export interface FolderChooserDialogProps extends ChoiceOptions {
  /** The folder that comes marked. */
  value: string | null
  /** The caller closes the window. */
  onConfirm(id: string | null): void
  onClose(): void
  title?: string
  confirmLabel?: string
  /** The document it opens in: a field in the floating recording window passes that window's. */
  host?: Document
}

export interface FolderFieldProps extends ChoiceOptions {
  value: string | null
  onChange(id: string | null): void
  /** The field's accessible name. */
  label?: string
  title?: string
  confirmLabel?: string
  /** Give both to open the window from outside. */
  open?: boolean
  onOpenChange?(open: boolean): void
}

interface Row {
  key: string
  id: string | null
  name: string
  depth: number
  entry: Entry | null
  hasKids: boolean
  parentKey?: string
}

const ROOT = ''
const ROOT_NAME = 'Biblioteca (raiz)'
const MAX_INDENT = 8
/** A name this short stays whole in the path line: cutting it saves nothing. */
const SHORT_NAME = 8
const keyOf = (id: string | null) => id ?? ROOT
const foldedName = (name: string) => searchWords(name).join(' ')
const byName = (a: Entry, b: Entry) => a.name.localeCompare(b.name, 'pt-BR')

function useFolderModel(exclude: string[] | undefined, extra: ProposedFolder | undefined) {
  const folders = useLibraryStore(state => state.folders)
  return useMemo(() => {
    const live: Entry[] = liveFolders(folders)
    const byId = new Map<string, Entry>(live.map(folder => [folder.id, folder]))
    if (extra) byId.set(extra.id, extra)
    const chain = (id: string | null): Entry[] => {
      const path: Entry[] = []
      for (let current = id ? byId.get(id) : undefined; current && path.length < 64; current = current.parentId ? byId.get(current.parentId) : undefined) path.unshift(current)
      return path
    }
    const hidden = new Set(exclude)
    const shown = [...byId.values()].filter(entry => !chain(entry.id).some(link => hidden.has(link.id)))
    const kids = new Map<string | null, Entry[]>()
    for (const entry of shown) kids.set(entry.parentId, [...(kids.get(entry.parentId) ?? []), entry])
    // the proposed folder comes first among its siblings, as in the sidebar order otherwise
    for (const list of kids.values()) list.sort((a, b) => Number(b.id === extra?.id) - Number(a.id === extra?.id) || (a.position ?? 0) - (b.position ?? 0) || byName(a, b))
    const names = (id: string | null) => {
      const path = chain(id).map(entry => entry.name)
      return path.length ? path : ['Biblioteca']
    }
    /** The keys that must be open for the folder to show. */
    const ancestors = (id: string | null) => [ROOT, ...chain(id).slice(0, -1).map(entry => entry.id)]
    return { byId, shown, kids, names, ancestors }
  }, [folders, exclude, extra])
}

type Model = ReturnType<typeof useFolderModel>

/** The path in one line: a deep one loses its middle, a long name is cut by the CSS. */
function PathLine({ segments }: { segments: string[] }) {
  const shown = segments.length > 4 ? [segments[0], '…', ...segments.slice(-3)] : segments
  return (
    <span className="fc-path">
      {shown.map((segment, index) => (
        <Fragment key={index}>
          {index > 0 && <span className="fc-sep"> › </span>}
          <span className={`fc-seg${segment === '…' ? ' fc-gap' : segment.length <= SHORT_NAME ? ' fc-short' : ''}`}>{segment}</span>
        </Fragment>
      ))}
    </span>
  )
}

const iconOf = (entry: Entry | null) => (entry ? <FolderIcon color={entry.color} /> : <Icon name="book" />)

/** Name, "pasta nova", star and, where the row is out of the tree, the place it lives in. */
function RowText({ entry, name, isNew, where }: { entry: Entry | null; name: string; isNew: boolean; where?: string }) {
  return (
    <>
      {iconOf(entry)}{' '}
      <span className="fc-text">
        <span className="fc-title">
          <span className="fc-name">{name}</span>
          {isNew && (
            <>
              {' '}
              <span className="fc-new">(pasta nova)</span>
            </>
          )}
          {entry?.favorite && <Icon name="star" className="fc-star" />}
        </span>
        {where && (
          <span className="fc-where" aria-hidden="true">
            {where}
          </span>
        )}
      </span>
    </>
  )
}

/** The chooser itself, for a dialog that is only about picking a folder (Mover). */
export function FolderChooser({ value, onChange, onConfirm, onCancel, exclude, extra, leaf, hint, autoFocus = false }: FolderChooserProps) {
  const model = useFolderModel(exclude, extra)
  const [query, setQuery] = useState('')
  const [open, setOpen] = useState(() => new Set(model.ancestors(value)))
  const [seen, setSeen] = useState(value)
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  const filter = useRef<HTMLInputElement>(null)
  const rowEls = useRef(new Map<string, HTMLButtonElement>())
  const words = searchWords(query)
  const filtering = words.length > 0

  // Whatever gets marked shows: its parents open, and stay open as the mark moves on.
  if (seen !== value) {
    setSeen(value)
    setOpen(current => new Set([...current, ...model.ancestors(value)]))
  }

  const rows = useMemo(() => (filtering ? resultRows(model, words) : treeRows(model, open)), [model, open, filtering, query])
  const markedRow = rows.find(row => row.id === value)
  const favorites = useMemo(() => model.shown.filter(entry => entry.favorite).sort(byName), [model])

  useEffect(() => {
    if (autoFocus && !window.matchMedia('(pointer: coarse)').matches) filter.current?.focus()
  }, [autoFocus])

  useEffect(() => {
    root.current?.querySelector('[role="treeitem"][aria-selected="true"]')?.scrollIntoView?.({ block: 'nearest' })
  }, [value, filtering])

  const mark = (id: string | null) => {
    if (id !== value) onChange(id)
  }
  const go = (row: Row | undefined) => {
    if (!row) return
    mark(row.id)
    rowEls.current.get(row.key)?.focus()
  }
  const toggle = (key: string, next: boolean) =>
    setOpen(current => {
      const copy = new Set(current)
      if (next) copy.add(key)
      else copy.delete(key)
      return copy
    })

  const onFilterKey = (event: KeyboardEvent) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      go(markedRow ?? rows[0])
    } else if (event.key === 'Enter') {
      event.preventDefault()
      if (!filtering || markedRow) onConfirm?.(value)
      else if (rows[0]) mark(rows[0].id)
    }
  }

  const onRowKey = (event: KeyboardEvent, row: Row, index: number) => {
    const move = (target: Row | undefined) => {
      event.preventDefault()
      go(target)
    }
    if (event.key === 'ArrowDown') move(rows[index + 1])
    else if (event.key === 'ArrowUp') move(rows[index - 1])
    else if (event.key === 'Home') move(rows[0])
    else if (event.key === 'End') move(rows[rows.length - 1])
    else if (event.key === 'ArrowRight' && !filtering && row.hasKids) {
      event.preventDefault()
      if (open.has(row.key)) go(rows[index + 1])
      else toggle(row.key, true)
    } else if (event.key === 'ArrowLeft' && !filtering) {
      event.preventDefault()
      if (row.hasKids && open.has(row.key)) toggle(row.key, false)
      else go(rows.find(item => item.key === row.parentKey))
    } else if (event.key === 'Enter' && onConfirm) {
      event.preventDefault()
      mark(row.id)
      onConfirm(row.id)
    }
  }

  const onFavoriteKey = (event: KeyboardEvent, id: string) => {
    if (event.key !== 'Enter' || !onConfirm) return
    event.preventDefault()
    mark(id)
    onConfirm(id)
  }

  const onChooserKey = (event: KeyboardEvent) => {
    if (event.key === '/' && (event.target as HTMLElement).tagName !== 'INPUT') {
      event.preventDefault()
      filter.current?.focus()
      return
    }
    if (event.key !== 'Escape') return
    if (query) {
      event.stopPropagation()
      setQuery('')
      filter.current?.focus()
    } else if (onCancel) {
      event.stopPropagation()
      onCancel()
    }
  }

  const create = async () => {
    const clean = name.trim()
    if (!clean || busy) return
    setBusy(true)
    setFailed(false)
    try {
      const { createFolder } = useLibraryStore.getState()
      // inside the proposed folder: that one has to exist first
      const parentId = extra && value === extra.id ? (await createFolder({ name: extra.name, parentId: extra.parentId })).id : value
      const folder = await createFolder({ name: clean, parentId })
      setName('')
      setQuery('')
      onChange(folder.id)
    } catch {
      setFailed(true)
    } finally {
      setBusy(false)
    }
  }

  const onCreateKey = (event: KeyboardEvent) => {
    if (event.key === 'Enter') {
      event.preventDefault()
      event.stopPropagation()
      void create()
    } else if (event.key === 'Escape' && name) {
      event.stopPropagation()
      setName('')
    }
  }

  const tabbable = (markedRow ?? rows[0])?.key
  const found = rows.length === 1 ? '1 pasta encontrada' : rows.length ? `${rows.length} pastas encontradas` : 'Nenhuma pasta encontrada'
  const placeOf = (entry: Entry) => (entry.parentId ? model.names(entry.parentId).join(' › ') : undefined)
  const pathOf = (id: string | null) => model.names(id)
  const destination = leaf ? [...pathOf(value), leaf] : pathOf(value)

  const renderRow = (row: Row, index: number) => (
    <div key={row.key} className="fc-row" role="none" style={{ '--fc-indent': Math.min(row.depth, MAX_INDENT) } as CSSProperties}>
      {!filtering &&
        (row.hasKids ? (
          <button type="button" className="fc-tw" tabIndex={-1} aria-label={`${open.has(row.key) ? 'Fechar' : 'Abrir'} ${row.name}`} onClick={() => toggle(row.key, !open.has(row.key))}>
            <Icon name={open.has(row.key) ? 'down' : 'fwd'} />
          </button>
        ) : (
          <span className="fc-tw" />
        ))}
      <button
        ref={element => {
          if (element) rowEls.current.set(row.key, element)
          else rowEls.current.delete(row.key)
        }}
        type="button"
        role="treeitem"
        aria-level={row.depth + 1}
        aria-selected={row.id === value}
        aria-expanded={!filtering && row.hasKids ? open.has(row.key) : undefined}
        tabIndex={row.key === tabbable ? 0 : -1}
        title={pathOf(row.id).join(' › ')}
        className="fc-it"
        onClick={() => mark(row.id)}
        onKeyDown={event => onRowKey(event, row, index)}
      >
        <RowText entry={row.entry} name={row.name} isNew={row.id !== null && row.id === extra?.id} where={filtering && row.entry ? (placeOf(row.entry) ?? 'Biblioteca') : undefined} />
      </button>
    </div>
  )

  return (
    <div className="fc" ref={root} onKeyDown={onChooserKey}>
      <div className="fc-filter">
        <Icon name="search" />
        <input ref={filter} className="input" type="search" aria-label="Filtrar pastas" placeholder="Filtrar pastas" value={query} onChange={event => setQuery(event.target.value)} onKeyDown={onFilterKey} />
        {!query && (
          <kbd className="kbd fc-kbd" aria-hidden="true">
            /
          </kbd>
        )}
        {query && (
          <button
            type="button"
            className="ibtn fc-clear"
            tabIndex={-1}
            aria-label="Limpar filtro"
            title="Limpar filtro"
            onClick={() => {
              setQuery('')
              filter.current?.focus()
            }}
          >
            <Icon name="x" />
          </button>
        )}
      </div>
      <span className="fc-live" role="status">
        {filtering ? found : ''}
      </span>
      {filtering ? (
        rows.length ? (
          <div className="fc-tree" role="tree" aria-label="Pastas encontradas">
            {rows.map(renderRow)}
          </div>
        ) : (
          <p className="fc-empty">Nenhuma pasta com esse nome.</p>
        )
      ) : (
        <>
          {favorites.length > 0 && (
            <div className="fc-sec">
              <span className="fc-cap">Favoritas</span>
              <ul className="fc-favs" role="list" aria-label="Favoritas">
                {favorites.map(entry => (
                  <li key={entry.id}>
                    <button type="button" className="fc-it" aria-pressed={entry.id === value} title={pathOf(entry.id).join(' › ')} onClick={() => mark(entry.id)} onKeyDown={event => onFavoriteKey(event, entry.id)}>
                      <RowText entry={entry} name={entry.name} isNew={false} where={placeOf(entry)} />
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
          <span className="fc-cap">Todas as pastas</span>
          <div className="fc-tree" role="tree" aria-label="Todas as pastas">
            {rows.map(renderRow)}
          </div>
        </>
      )}
      <div className="fc-create">
        <input className="input" aria-label="Nome da pasta nova" placeholder="Pasta nova, dentro da marcada" value={name} onChange={event => setName(event.target.value)} onKeyDown={onCreateKey} />
        <button type="button" className="btn" disabled={!name.trim() || busy} onClick={() => void create()}>
          {busy ? 'Criando…' : 'Criar'}
        </button>
      </div>
      {failed && (
        <p className="fc-fail" role="alert">
          Não deu para criar a pasta. Tente de novo.
        </p>
      )}
      {hint && <p className="fc-hint">{hint(value)}</p>}
      <div className="fc-dest" role="group" aria-label="Fica em" title={destination.join(' › ')}>
        <span className="fc-dest-lab">Fica em</span> <PathLine segments={destination} />
      </div>
    </div>
  )
}

function treeRows(model: Model, open: Set<string>): Row[] {
  const out: Row[] = []
  const walk = (parentId: string | null, depth: number) => {
    for (const entry of model.kids.get(parentId) ?? []) {
      out.push({ key: entry.id, id: entry.id, name: entry.name, depth, entry, hasKids: Boolean(model.kids.get(entry.id)?.length), parentKey: keyOf(entry.parentId) })
      if (open.has(entry.id)) walk(entry.id, depth + 1)
    }
  }
  out.push({ key: ROOT, id: null, name: ROOT_NAME, depth: 0, entry: null, hasKids: Boolean(model.kids.get(null)?.length) })
  if (open.has(ROOT)) walk(null, 1)
  return out
}

/** Only the folders that match, flat, favorites first. */
function resultRows(model: Model, words: string[]): Row[] {
  const matches = (name: string) => {
    const folded = foldedName(name)
    return words.every(word => folded.includes(word))
  }
  const found = model.shown.filter(entry => matches(entry.name)).sort((a, b) => Number(Boolean(b.favorite)) - Number(Boolean(a.favorite)) || byName(a, b))
  const rows: Row[] = found.map(entry => ({ key: entry.id, id: entry.id, name: entry.name, depth: 0, entry, hasKids: false }))
  return matches(ROOT_NAME) ? [{ key: ROOT, id: null, name: ROOT_NAME, depth: 0, entry: null, hasKids: false }, ...rows] : rows
}

/** The chooser in its own window, over whatever asked for the folder. Esc closes only this one. */
export function FolderChooserDialog({ value, onConfirm, onClose, exclude, extra, leaf, hint, title = 'Escolher pasta', confirmLabel = 'Usar esta pasta', host = document }: FolderChooserDialogProps) {
  const [draft, setDraft] = useState(value)
  const panel = useRef<HTMLDivElement>(null)
  // read while rendering: by the first effect the filter has already taken the focus
  const [opener] = useState(() => host.activeElement as HTMLElement | null)
  useEffect(() => () => opener?.focus(), [opener])
  // Dialog's own Esc hears only the main tab, and there it would close the window below as well
  useEffect(() => {
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape' || panel.current?.contains(event.target as Node)) return
      event.stopImmediatePropagation()
      onClose()
    }
    host.addEventListener('keydown', onKey, true)
    return () => host.removeEventListener('keydown', onKey, true)
  }, [host, onClose])
  return createPortal(
    <Dialog title={title} onClose={onClose}>
      <div
        ref={panel}
        className="fc-dialog"
        tabIndex={-1}
        onKeyDown={event => {
          if (event.key !== 'Escape') return
          event.stopPropagation()
          onClose()
        }}
      >
        <div className="fc-body">
          <FolderChooser value={draft} onChange={setDraft} onConfirm={onConfirm} onCancel={onClose} exclude={exclude} extra={extra} leaf={leaf} hint={hint} autoFocus />
        </div>
        <div className="df">
          <button type="button" className="btn quiet" onClick={onClose}>
            Voltar
          </button>
          <button type="button" className="btn primary" onClick={() => onConfirm(draft)}>
            {confirmLabel}
          </button>
        </div>
      </div>
    </Dialog>,
    host.body,
  )
}

/** The field that takes the place of a folder select: where it goes now, and "Trocar". */
export function FolderField({ value, onChange, exclude, extra, leaf, hint, label = 'Pasta', title, confirmLabel, open, onOpenChange }: FolderFieldProps) {
  const model = useFolderModel(exclude, extra)
  const [ownOpen, setOwnOpen] = useState(false)
  // in state, not a ref: opened from outside at once, the window waits to know where the field lives
  const [fieldEl, setFieldEl] = useState<HTMLDivElement | null>(null)
  const shown = open ?? ownOpen
  const setShown = (next: boolean) => {
    setOwnOpen(next)
    onOpenChange?.(next)
  }
  const isNew = value !== null && value === extra?.id
  const segments = model.names(value)
  const display = isNew ? [...segments.slice(0, -1), `${segments[segments.length - 1]} (pasta nova)`] : segments
  return (
    <>
      <div ref={setFieldEl} className="fc-field" role="group" aria-label={label}>
        {iconOf(value ? (model.byId.get(value) ?? null) : null)}
        <span className="fc-field-path" title={display.join(' › ')}>
          <PathLine segments={display} />
        </span>
        <button type="button" className="btn" onClick={() => setShown(true)}>
          Trocar
        </button>
      </div>
      {hint && <span className="fc-hint">{hint(value)}</span>}
      {shown && fieldEl && (
        <FolderChooserDialog
          host={fieldEl.ownerDocument}
          value={value}
          exclude={exclude}
          extra={extra}
          leaf={leaf}
          hint={hint}
          title={title}
          confirmLabel={confirmLabel}
          onClose={() => setShown(false)}
          onConfirm={id => {
            onChange(id)
            setShown(false)
          }}
        />
      )}
    </>
  )
}
