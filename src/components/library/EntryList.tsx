// Navegação de entradas (FR-026): every live entrada, whatever its folder, with its type, folder, date and what was born of it.
import { useEffect, useMemo, useState } from 'react'

import type { FileMeta } from '@/types/domain'
import { sortFiles, type SortColumn, type SortState } from '@/components/library/Explorer'
import { FileTableRow, SortHead, TableCheck } from '@/components/library/FileRows'
import { FilterPanel } from '@/components/library/FilterPanel'
import { ActiveFilters } from '@/components/library/Filters'
import { SelectionBar } from '@/components/library/SelectionBar'
import { isTouchScreen, useFileActions } from '@/components/library/use-file-actions'
import { Icon, type IconName } from '@/components/ui/Icon'
import { useIsNarrow } from '@/hooks/use-is-narrow'
import { useFilterSource, useLiveLibrary } from '@/hooks/use-library-view'
import { isNote } from '@/lib/family'
import { mediaOf } from '@/lib/file-types'
import { filterLibrary, NO_FILTERS, withoutFilter } from '@/lib/library-filters'
import { paths } from '@/lib/paths'
import { useUiStore } from '@/stores/ui'
import '@/styles/explorer.css'
import '@/styles/entry-list.css'

/** What the entrada is, as the person calls it: Vídeo, Áudio, PDF, Link, Texto colado, Tema… */
export function entryKind(file: Pick<FileMeta, 'origin'>): { label: string; icon: IconName } {
  const media = mediaOf(file)
  if (media === 'video') return { label: 'Vídeo', icon: 'monitor' }
  if (media === 'audio') return { label: 'Áudio', icon: 'mic' }
  const origin = file.origin
  if (origin?.input === 'url') return { label: 'Link', icon: 'link' }
  if (origin?.input === 'youtube') return { label: 'YouTube', icon: 'monitor' }
  if (origin?.input === 'text') return { label: 'Texto colado', icon: 'text' }
  if (origin?.input === 'topic') return { label: 'Tema', icon: 'search' }
  if (origin?.mime === 'application/pdf' || /\.pdf$/i.test(origin?.name ?? '')) return { label: 'PDF', icon: 'file' }
  return { label: 'Arquivo', icon: 'file' }
}

/** The list of entradas (FR-026, FR-044): the explorer's filter panel and table, over every live entrada of the library, whatever its folder. */
export function EntryList() {
  const ui = useUiStore()
  const { filters, selection } = ui
  const { files, folders } = useLiveLibrary()
  const actions = useFileActions()
  const source = useFilterSource()
  const narrow = useIsNarrow()
  const draggable = !isTouchScreen()
  const [sort, setSort] = useState<SortState>({ column: 'created', ascending: false })
  const [drawerOpen, setDrawerOpen] = useState(false)
  const every = useMemo(() => files.filter(file => !isNote(file)), [files])
  const folderName = useMemo(() => new Map(folders.map(folder => [folder.id, folder.name])), [folders])
  // the scope belongs to the explorer: here it is always the entradas, and what the panel changes keeps the explorer's own
  const result = useMemo(() => filterLibrary({ ...source, only: new Set(every.map(file => file.id)) }, { ...filters, scope: 'entradas' }), [source, every, filters])
  const rows = useMemo(() => sortFiles(result.items, sort), [result.items, sort])
  const visible = useMemo(() => new Set(rows.map(file => file.id)), [rows])

  // What leaves the table leaves the selection: "Apagar" never acts on what is out of sight.
  useEffect(() => {
    const { selection: current, setSelection } = useUiStore.getState()
    const kept = [...current].filter(id => visible.has(id))
    if (kept.length < current.size) setSelection(kept)
  }, [visible])

  if (!every.length) {
    return (
      <div className="empty entry-empty">
        <Icon name="upload" />
        <div>
          <b>Nenhuma entrada ainda</b>
          <div className="muted">O vídeo, o PDF, o link, o texto colado ou o tema de onde nascem as suas notas aparecem aqui, em qualquer pasta.</div>
        </div>
        <button className="btn primary" onClick={() => ui.open({ kind: 'new' })}>
          <Icon name="plus" />
          Novo
        </button>
      </div>
    )
  }

  const marked = [...visible].filter(id => selection.has(id)).length
  const allChecked = marked === 0 ? false : marked === visible.size ? true : 'some'
  const sortBy = (column: SortColumn) => setSort(current => ({ column, ascending: current.column === column ? !current.ascending : column === 'name' }))
  const rowProps = { narrow, selectable: true, draggable, actions }

  return (
    <section className="explorer ex-browser entry-list">
      <FilterPanel
        filters={filters}
        facets={result.facets}
        onChange={next => ui.setFilters({ ...next, scope: filters.scope })}
        collapsed={ui.filtersCollapsed}
        onCollapsedChange={filtersCollapsed => ui.set({ filtersCollapsed })}
        drawer={narrow}
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
      />
      <div className="ex-main">
        {narrow && (
          <div className="ex-tools">
            <button className="btn" onClick={() => setDrawerOpen(true)}>
              <Icon name="filter" />
              Filtros
              {result.active.length > 0 && <span className="ex-filters-n">{result.active.length}</span>}
            </button>
          </div>
        )}
        {result.active.length > 0 && <ActiveFilters active={result.active} summary={`${result.shown} de ${every.length}`} onRemove={group => ui.setFilters(withoutFilter(filters, group))} onClear={() => ui.setFilters({ ...NO_FILTERS, scope: filters.scope, dateField: filters.dateField })} />}
        <table className="ex-table" aria-label="Entradas">
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
            {rows.map(file => (
              <FileTableRow key={file.id} file={file} depth={0} to={paths.entry(file.id)} kindText={entryKind(file).label} folderName={(file.folderId && folderName.get(file.folderId)) || 'Biblioteca'} {...rowProps} />
            ))}
          </tbody>
        </table>
        {!visible.size && <div className="empty">Nada com esse filtro aqui.</div>}
        <div className="selwrap ex-selwrap">
          <SelectionBar />
        </div>
      </div>
    </section>
  )
}
