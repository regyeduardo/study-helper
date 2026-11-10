// O explorador (FR-036 a FR-045): a pasta como antes desta feature, só notas, uma por linha (FR-073); a busca, na biblioteca toda (FR-074, FR-075).
import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'

import type { FileMeta, FolderMeta } from '@/types/domain'
import { FileTableRow, FolderTableRow, SortHead, TableCheck } from '@/components/library/FileRows'
import { FilterPanel } from '@/components/library/FilterPanel'
import { ActiveFilters, LowMasteryChip } from '@/components/library/Filters'
import { SelectionBar } from '@/components/library/SelectionBar'
import { isTouchScreen, useFileActions } from '@/components/library/use-file-actions'
import { Icon } from '@/components/ui/Icon'
import { useIsNarrow } from '@/hooks/use-is-narrow'
import { readForSearch, useFilterSource, useLiveLibrary, usePathName, useSearchHits, useSearchPending } from '@/hooks/use-library-view'
import { isNote } from '@/lib/family'
import { LOW_MASTERY_BELOW, REVIEW_BELOW } from '@/lib/file-types'
import { filterLibrary, type LibraryFilters, placeOf, withoutFilter } from '@/lib/library-filters'
import { type SearchHit, searchWords } from '@/lib/library-search'
import { paths, type View } from '@/lib/paths'
import { useLibraryStore } from '@/stores/library'
import { useUiStore } from '@/stores/ui'
import '@/styles/explorer.css'

export type SortColumn = 'name' | 'created' | 'updated'
export interface SortState {
  column: SortColumn
  ascending: boolean
}

export function sortFiles(files: FileMeta[], { column, ascending }: SortState): FileMeta[] {
  const byName = (a: FileMeta, b: FileMeta) => a.name.localeCompare(b.name, 'pt-BR')
  const order = (a: FileMeta, b: FileMeta) => (column === 'name' ? byName(a, b) : a[column].at.localeCompare(b[column].at))
  return [...files].sort((a, b) => (ascending ? order(a, b) : order(b, a)) || byName(a, b))
}

/** What this screen lists before the filters: notes only (FR-073). The tag of the side bar and the Pasta filter look beyond the folder being browsed. */
function inView(view: View, folderId: string | null, tag: string | null, filters: LibraryFilters): (file: FileMeta) => boolean {
  if (tag) return isNote
  if (view === 'review') return file => isNote(file) && file.mastery !== null && file.mastery < REVIEW_BELOW
  if (view === 'favorites') return file => isNote(file) && file.favorite
  return filters.folders.length ? isNote : file => isNote(file) && file.folderId === folderId
}

const byPosition = (a: FolderMeta, b: FolderMeta) => a.position - b.position || a.name.localeCompare(b.name, 'pt-BR')

/** The pause after the last key before the search runs (FR-075): the keys themselves only change the box. */
export const SEARCH_PAUSE_MS = 150
/** Results drawn at once; the rest comes with "Mostrar mais". */
const RESULTS_AT_ONCE = 50

const plural = (count: number, one: string, many: string) => `${count.toLocaleString('pt-BR')} ${count === 1 ? one : many}`

/** The search box: what is typed stays here, and reaches the search only after a pause; going to it starts reading the library. */
function SearchBox() {
  const query = useUiStore(state => state.query)
  const setQuery = useUiStore(state => state.setQuery)
  const [value, setValue] = useState(query)
  const sent = useRef(query)
  const box = useRef<HTMLInputElement>(null)

  // a query changed elsewhere ("Limpar tudo", another layout) shows here
  useEffect(() => {
    if (query === sent.current) return
    sent.current = query
    setValue(query)
  }, [query])

  useEffect(() => {
    if (value === sent.current) return
    const timer = setTimeout(
      () => {
        sent.current = value
        setQuery(value)
      },
      value.trim() ? SEARCH_PAUSE_MS : 0,
    )
    return () => clearTimeout(timer)
  }, [value, setQuery])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== '/' || event.ctrlKey || event.metaKey || event.altKey || useUiStore.getState().overlay) return
      if ((event.target as HTMLElement).closest?.('input, textarea, select, [contenteditable="true"]')) return
      event.preventDefault()
      box.current?.focus()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  return (
    <label className="ex-search">
      <Icon name="search" />
      <input ref={box} type="search" aria-label="Buscar" placeholder="Buscar em nomes, transcrições e notas" value={value} onFocus={() => void readForSearch()} onChange={event => setValue(event.target.value)} />
      <span className="kbd" aria-hidden="true">
        /
      </span>
    </label>
  )
}

/** Where a result opens: a note at the words, an entrada at the speech found (FR-074). */
function useOpenResult() {
  const navigate = useNavigate()
  const { openFile } = useFileActions()
  const query = useUiStore(state => state.query)
  return (file: FileMeta, hit: SearchHit) => () => {
    if (isNote(file)) openFile(file, query.trim())
    else navigate(hit.at === null ? paths.entry(file.id) : `${paths.entry(file.id)}?t=${hit.at}`)
  }
}

export function Explorer({ view, folderId }: { view: View; folderId: string | null }) {
  const ui = useUiStore()
  const { filters, tag, lowMastery, query, selection } = ui
  const { files, folders } = useLiveLibrary()
  const actions = useFileActions()
  const shared = useLibraryStore(state => Boolean(state.sharedView))
  const source = useFilterSource()
  const narrow = useIsNarrow()
  const pathName = usePathName()
  const openResult = useOpenResult()
  const selectable = !shared
  const draggable = selectable && !isTouchScreen()
  const [sort, setSort] = useState<SortState>({ column: 'name', ascending: true })
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [shownResults, setShownResults] = useState(RESULTS_AT_ONCE)
  const hits = useSearchHits(query)
  const pending = useSearchPending()
  const searching = searchWords(query).length > 0
  // the folder is a list of notes: its "Tipo" is the type of the note (FR-073)
  const notesFilters = useMemo<LibraryFilters>(() => ({ ...filters, scope: 'notas' }), [filters])

  useEffect(() => setShownResults(RESULTS_AT_ONCE), [query])

  const result = useMemo(() => {
    const low = (file: FileMeta) => !lowMastery || (file.mastery !== null && file.mastery < LOW_MASTERY_BELOW)
    // a search looks in the whole library, entradas included, and shows only what it found
    if (searching) return filterLibrary({ ...source, only: new Set(files.filter(file => hits.has(file.id) && low(file)).map(file => file.id)), foundEntries: true }, notesFilters)
    const here = inView(view, folderId, tag, filters)
    return filterLibrary({ ...source, only: new Set(files.filter(file => here(file) && low(file)).map(file => file.id)) }, notesFilters)
  }, [source, files, view, folderId, tag, filters, notesFilters, lowMastery, searching, hits])

  const hasFilters = result.active.length > 0 || lowMastery
  const sorted = useMemo(() => sortFiles(result.items, sort), [result.items, sort])
  const rows = searching ? sorted.slice(0, shownResults) : sorted
  const subfolders = useMemo(() => (view === 'folder' && !hasFilters && !searching ? folders.filter(folder => folder.parentId === folderId).sort(byPosition) : []), [view, hasFilters, searching, folders, folderId])
  const childCounts = useMemo(() => {
    const counts = new Map<string, number>()
    for (const parent of [...files.filter(isNote).map(file => file.folderId), ...folders.map(folder => folder.parentId)]) if (parent) counts.set(parent, (counts.get(parent) ?? 0) + 1)
    return counts
  }, [files, folders])
  const visible = useMemo(() => new Set([...subfolders.map(folder => folder.id), ...rows.map(file => file.id)]), [subfolders, rows])
  // the entradas of this folder are in "Entradas" (FR-073): an empty folder of notes says where they went
  const entriesHere = useMemo(() => (view === 'folder' && !tag ? files.filter(file => !isNote(file) && file.folderId === folderId).length : 0), [view, tag, files, folderId])

  // What leaves the table leaves the selection: "Apagar" never acts on what is out of sight.
  useEffect(() => {
    const { selection: current, setSelection } = useUiStore.getState()
    const kept = [...current].filter(id => visible.has(id))
    if (kept.length < current.size) setSelection(kept)
  }, [visible])

  const where = useMemo(() => ({ localMedia: new Set(source.localMedia), library: source.library, now: source.now }), [source])
  const placeLabels = new Map(result.facets.places.map(option => [option.id, option.label]))
  // said only when it differs from the library; "Só neste navegador" is the SaveToDrive notice, in the same line
  const placeNote = (file: FileMeta) => {
    const place = placeOf(file, where)
    return shared || place === where.library || place === 'navegador' ? null : placeLabels.get(place)
  }

  const tested = result.items.filter(file => file.mastery !== null)
  const average = tested.length ? Math.round(tested.reduce((sum, file) => sum + (file.mastery ?? 0), 0) / tested.length) : null
  const marked = [...visible].filter(id => selection.has(id)).length
  const allChecked = marked === 0 ? false : marked === visible.size ? true : 'some'
  const sortBy = (column: SortColumn) => setSort(current => ({ column, ascending: current.column === column ? !current.ascending : column === 'name' }))
  const folderMenu = (event: React.MouseEvent<HTMLElement>) => {
    const box = event.currentTarget.getBoundingClientRect()
    if (folderId) ui.openMenu({ kind: 'folder', id: folderId, x: box.left - 200, y: box.bottom + 4 })
  }
  const rowProps = { narrow, selectable, draggable, actions }
  const term = query.trim()
  const reading = searching && pending > 0

  return (
    <section className="explorer ex-browser">
      <FilterPanel filters={notesFilters} facets={result.facets} onChange={next => ui.setFilters({ ...next, scope: filters.scope })} collapsed={ui.filtersCollapsed} onCollapsedChange={filtersCollapsed => ui.set({ filtersCollapsed })} drawer={narrow} open={drawerOpen} onClose={() => setDrawerOpen(false)} />
      <div className="ex-main">
        <div className="ex-tools">
          {narrow && (
            <button className="btn" onClick={() => setDrawerOpen(true)}>
              <Icon name="filter" />
              Filtros
              {result.active.length > 0 && <span className="ex-filters-n">{result.active.length}</span>}
            </button>
          )}
          <LowMasteryChip />
          <span className="spacer" />
          {view === 'folder' && !shared && (
            <button className="btn" onClick={() => ui.open({ kind: 'new-folder', parentId: folderId })}>
              <Icon name="folder" />
              Nova pasta
            </button>
          )}
          {view === 'folder' && folderId && !shared && (
            <button className="ibtn" aria-label="Opções da pasta" onClick={folderMenu}>
              <Icon name="dots" />
            </button>
          )}
          <SearchBox />
        </div>
        {hasFilters && <ActiveFilters active={result.active} summary={result.summary} onRemove={group => ui.setFilters(withoutFilter(filters, group))} onClear={ui.clearFilters} />}
        {searching && (
          <p className="ex-found" role="status">
            {result.shown ? (
              <>
                <b>{plural(result.shown, 'resultado', 'resultados')}</b> {`para “${term}” na biblioteca`}
              </>
            ) : reading ? (
              `Procurando “${term}” na biblioteca…`
            ) : (
              `Nada com “${term}” ${hasFilters ? 'com esses filtros' : 'na biblioteca'}.`
            )}
            {/* out of what is announced: it changes every few tenths of a second while the library is read */}
            {reading && <span className="ex-reading" aria-hidden="true">{` Lendo ${plural(pending, 'item', 'itens')}…`}</span>}
          </p>
        )}
        {average !== null && view === 'folder' && !searching && (
          <div className="ex-strip">
            <span className="muted">Desta pasta:</span>
            <button className="chip" onClick={() => folderId && ui.open({ kind: 'folder-exam', folderId })}>
              Prova · {average}%
            </button>
          </div>
        )}
        {(!searching || rows.length > 0) && (
          <table className="ex-table" aria-label={searching ? 'Resultados da busca' : 'Notas e pastas'}>
            <thead>
              <tr>
                <th className="ex-check">{selectable && <TableCheck checked={allChecked} label="Marcar todos" onToggle={() => (allChecked === true ? ui.clearSelection() : ui.setSelection([...visible]))} />}</th>
                <SortHead column="name" label="Nome" sort={sort} onSort={sortBy} />
                {!narrow && <SortHead column="created" label="Criado" sort={sort} onSort={sortBy} />}
                {!narrow && <SortHead column="updated" label="Atualizado" sort={sort} onSort={sortBy} />}
                <th />
              </tr>
            </thead>
            <tbody>
              {subfolders.map(folder => (
                <FolderTableRow key={folder.id} folder={folder} items={childCounts.get(folder.id) ?? 0} {...rowProps} />
              ))}
              {rows.map(file => {
                const hit = searching ? hits.get(file.id) : undefined
                return <FileTableRow key={file.id} file={file} hit={hit} onOpen={hit && openResult(file, hit)} folderName={hit && pathName(file.folderId)} place={placeNote(file)} {...rowProps} />
              })}
            </tbody>
          </table>
        )}
        {searching && sorted.length > rows.length && (
          <button className="btn ex-more" onClick={() => setShownResults(count => count + RESULTS_AT_ONCE)}>
            {`Mostrar mais ${Math.min(RESULTS_AT_ONCE, sorted.length - rows.length)} de ${(sorted.length - rows.length).toLocaleString('pt-BR')}`}
          </button>
        )}
        {!searching && !rows.length && entriesHere > 0 && !hasFilters ? (
          <div className="empty ex-no-notes">
            <span>{`Nenhuma nota nesta pasta, só ${plural(entriesHere, 'entrada', 'entradas')}.`}</span>
            {!shared && (
              <Link className="btn" to={paths.entries}>
                Ver em Entradas
              </Link>
            )}
          </div>
        ) : (
          !searching && !visible.size && <div className="empty">{hasFilters ? 'Nada com esse filtro aqui.' : 'Pasta vazia. Use Novo ou Gravar para começar.'}</div>
        )}
        {selectable && (
          <div className="selwrap ex-selwrap">
            <SelectionBar />
          </div>
        )}
      </div>
    </section>
  )
}
