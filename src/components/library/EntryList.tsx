// Gravações (003, FR-050): o que o app gravou, de qualquer pasta, com o mesmo desenho da antiga tela de Entradas: tipo, pasta, data e o que nasceu.
import { useEffect, useMemo, useState } from 'react'

import { plural, SearchBox, sortFiles, type SortColumn, type SortState } from '@/components/library/Explorer'
import { FileTableRow, SortHead, TableCheck } from '@/components/library/FileRows'
import { FilterPanel } from '@/components/library/FilterPanel'
import { ActiveFilters } from '@/components/library/Filters'
import { SelectionBar } from '@/components/library/SelectionBar'
import { isTouchScreen, useFileActions } from '@/components/library/use-file-actions'
import { entryKind } from '@/components/library/entry-kind'
import { Icon } from '@/components/ui/Icon'
import { useDrawnRows } from '@/hooks/use-drawn-rows'
import { useIsNarrow } from '@/hooks/use-is-narrow'
import { useFilterSource, useLiveLibrary, useSearchHits, useSearchMissed, useSearchPending } from '@/hooks/use-library-view'
import { isRecording } from '@/lib/file-types'
import { filterLibrary, type ItemKind, NO_FILTERS, withoutFilter } from '@/lib/library-filters'
import { searchWords } from '@/lib/library-search'
import { paths } from '@/lib/paths'
import { useUiStore } from '@/stores/ui'
import '@/styles/explorer.css'
import '@/styles/entry-list.css'

// the name lives in entry-kind.ts (the folder view uses it too); it is still imported from here by the entry page and the share dialog
export { entryKind }

const RECORDED_KINDS = new Set<ItemKind>(['video', 'audio'])

/** The list of recordings (FR-050): the explorer's filter panel and table, over every live media note the app recorded, whatever its folder. */
export function EntryList() {
  const ui = useUiStore()
  const { filters, selection, query } = ui
  const { files, folders } = useLiveLibrary()
  const actions = useFileActions()
  const source = useFilterSource()
  const narrow = useIsNarrow()
  const draggable = !isTouchScreen()
  const [sort, setSort] = useState<SortState>({ column: 'created', ascending: false })
  const [drawerOpen, setDrawerOpen] = useState(false)
  const every = useMemo(() => files.filter(isRecording), [files])
  // the same search as the folders (FR-074), only among the recordings
  const hits = useSearchHits(query)
  const pending = useSearchPending()
  // without internet the search looks only at what this device has (FR-040)
  const missed = useSearchMissed()
  const searching = searchWords(query).length > 0
  const found = useMemo(() => (searching ? every.filter(file => hits.has(file.id)) : every), [searching, every, hits])
  const folderName = useMemo(() => new Map(folders.map(folder => [folder.id, folder.name])), [folders])
  // the scope belongs to the explorer: here it is always the notes that keep a source, and what the panel changes keeps the explorer's own
  const result = useMemo(() => filterLibrary({ ...source, only: new Set(found.map(file => file.id)) }, { ...filters, scope: 'entradas' }), [source, found, filters])
  const rows = useMemo(() => sortFiles(result.items, sort), [result.items, sort])
  // a recording is only ever a Vídeo or an Áudio: the other kinds would be options that never apply
  const facets = useMemo(() => ({ ...result.facets, kinds: result.facets.kinds.filter(option => RECORDED_KINDS.has(option.id)) }), [result.facets])
  const visible = useMemo(() => new Set(rows.map(file => file.id)), [rows])
  // the table draws first what fills the screen and the rest right after (spec 007, T047)
  const drawn = useDrawnRows(rows.length, 'gravacoes')

  // What leaves the table leaves the selection: "Apagar" never acts on what is out of sight.
  useEffect(() => {
    const { selection: current, setSelection } = useUiStore.getState()
    const kept = [...current].filter(id => visible.has(id))
    if (kept.length < current.size) setSelection(kept)
  }, [visible])

  if (!every.length) {
    return (
      <div className="empty entry-empty">
        <Icon name="rec" />
        <div>
          <b>Nenhuma gravação ainda</b>
          <div className="muted">O que você grava no app (reunião, tela ou microfone) aparece aqui. Um vídeo ou áudio que você envia fica como nota na pasta dele.</div>
        </div>
        <button className="btn primary" onClick={() => ui.open({ kind: 'record' })}>
          <Icon name="rec" />
          Gravar
        </button>
      </div>
    )
  }

  const marked = [...visible].filter(id => selection.has(id)).length
  const allChecked = marked === 0 ? false : marked === visible.size ? true : 'some'
  const sortBy = (column: SortColumn) => setSort(current => ({ column, ascending: current.column === column ? !current.ascending : column === 'name' }))
  const rowProps = { narrow, selectable: true, draggable, actions }
  const term = query.trim()
  const reading = searching && pending > 0

  return (
    <section className="explorer ex-browser entry-list">
      <FilterPanel
        filters={filters}
        facets={facets}
        onChange={next => ui.setFilters({ ...next, scope: filters.scope })}
        collapsed={ui.filtersCollapsed}
        onCollapsedChange={filtersCollapsed => ui.set({ filtersCollapsed })}
        drawer={narrow}
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
      />
      <div className="ex-main">
        <div className="ex-tools">
          {narrow && (
            <button className="btn" onClick={() => setDrawerOpen(true)}>
              <Icon name="filter" />
              Filtros
              {result.active.length > 0 && <span className="ex-filters-n">{result.active.length}</span>}
            </button>
          )}
          <span className="spacer" />
          <SearchBox placeholder="Buscar em nomes e transcrições" />
        </div>
        {result.active.length > 0 && <ActiveFilters active={result.active} summary={`${result.shown} de ${every.length}`} onRemove={group => ui.setFilters(withoutFilter(filters, group))} onClear={() => ui.setFilters({ ...NO_FILTERS, scope: filters.scope, dateField: filters.dateField })} />}
        {searching && (
          <p className="ex-found" role="status">
            {result.shown ? (
              <>
                <b>{plural(result.shown, 'resultado', 'resultados')}</b> {`para “${term}” nas gravações`}
              </>
            ) : reading ? (
              `Procurando “${term}” nas gravações…`
            ) : (
              `Nada com “${term}” ${result.active.length ? 'com esses filtros' : 'nas gravações'}.`
            )}
            {reading && <span className="ex-reading" aria-hidden="true">{` Lendo ${plural(pending, 'item', 'itens')}…`}</span>}
            {missed > 0 && <span className="ex-offline">{' Sem internet: a busca olhou só o que já está neste aparelho, e pode faltar algo.'}</span>}
          </p>
        )}
        {/* a search with nothing found keeps only its sentence, like the folders: no heading of an empty table */}
        {(!searching || rows.length > 0) && (
          <table className="ex-table" aria-label="Gravações">
            <thead>
              <tr>
                <th className="ex-check">
                  <TableCheck checked={allChecked} label="Marcar todos" onToggle={() => (allChecked === true ? ui.clearSelection() : ui.setSelection([...visible]))} />
                </th>
                <SortHead column="name" label="Nome" sort={sort} onSort={sortBy} />
                {!narrow && <th className="ex-plain">O que nasceu</th>}
                {!narrow && <SortHead column="created" label="Criado" sort={sort} onSort={sortBy} />}
                {!narrow && <SortHead column="updated" label="Atualizado" sort={sort} onSort={sortBy} />}
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.slice(0, drawn).map(file => {
                const hit = searching ? hits.get(file.id) : undefined
                // a result opens at the speech found
                const to = hit && hit.at !== null ? `${paths.entry(file.id)}?t=${hit.at}` : paths.entry(file.id)
                return <FileTableRow key={file.id} file={file} born to={to} hit={hit} kindText={entryKind(file).label} folderName={(file.folderId && folderName.get(file.folderId)) || 'Biblioteca'} {...rowProps} />
              })}
            </tbody>
          </table>
        )}
        {!visible.size && !searching && <div className="empty">Nada com esse filtro aqui.</div>}
        <div className="selwrap ex-selwrap">
          <SelectionBar />
        </div>
      </div>
    </section>
  )
}
