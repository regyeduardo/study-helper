import { type ReactNode, useState } from 'react'

import { FilterPanel } from '@/components/library/FilterPanel'
import { Icon } from '@/components/ui/Icon'
import { FILE_TYPES } from '@/lib/file-types'
import { type ActiveFilter, type FilterGroup, type FilterResult, NO_FILTERS, type Scope, SCOPE_LABELS, withoutFilter } from '@/lib/library-filters'
import { type SortKey, useUiStore } from '@/stores/ui'

const SCOPES: Scope[] = ['tudo', 'entradas', 'notas']

/** Tudo, Entradas ou Notas, each with how many there are. */
export function ScopeTabs({ scope, counts, onChange }: { scope: Scope; counts: Record<Scope, number>; onChange(scope: Scope): void }) {
  return (
    <div className="ex-scope" role="group" aria-label="Mostrar">
      {SCOPES.map(id => (
        <button key={id} aria-pressed={scope === id} onClick={() => onChange(id)}>
          {SCOPE_LABELS[id]} <span className="ex-scope-n">{counts[id]}</span>
        </button>
      ))}
    </div>
  )
}

interface ActiveFiltersProps {
  active: ActiveFilter[]
  /** "8 de 214" */
  summary: string
  onRemove(group: FilterGroup): void
  onClear(): void
}

/** The line above the table: how many, each active filter with its "x", and "Limpar tudo". */
export function ActiveFilters({ active, summary, onRemove, onClear }: ActiveFiltersProps) {
  return (
    <div className="ex-active">
      <span className="ex-count">{summary}</span>
      {active.length > 0 && (
        <div className="ex-fchips" role="group" aria-label="Filtros ativos">
          {active.map(item => (
            <span key={item.group} className="ex-fchip">
              <span>{item.label}</span>
              <b title={item.value}>{item.value}</b>
              <button aria-label={`Tirar o filtro ${item.label}`} title={`Tirar o filtro ${item.label}`} onClick={() => onRemove(item.group)}>
                <Icon name="x" />
              </button>
            </span>
          ))}
        </div>
      )}
      <button className="ex-clear" onClick={onClear}>
        Limpar tudo
      </button>
    </div>
  )
}

export function LowMasteryChip() {
  const lowMastery = useUiStore(state => state.lowMastery)
  const toggleLowMastery = useUiStore(state => state.toggleLowMastery)
  return (
    <button className="chip" aria-pressed={lowMastery} onClick={toggleLowMastery}>
      <Icon name="warn" />
      Domínio abaixo de 60%
    </button>
  )
}

/**
 * The explorer's filters in Colunas, Comandos and Foco (FR-041): the panel opens as a drawer, with Tudo, Entradas or Notas
 * and the active filters beside it. `result` is what `useLibraryView` counted.
 */
export function LayoutFilters({ result, children }: { result: FilterResult; children?: ReactNode }) {
  const filters = useUiStore(state => state.filters)
  const setFilters = useUiStore(state => state.setFilters)
  const tag = useUiStore(state => state.tag)
  const setTag = useUiStore(state => state.setTag)
  const [open, setOpen] = useState(false)
  return (
    <>
      <div className="fl lf-bar">
        <button className="btn" onClick={() => setOpen(true)}>
          <Icon name="filter" />
          Filtros
          {result.active.length > 0 && <span className="ex-filters-n">{result.active.length}</span>}
        </button>
        <ScopeTabs scope={filters.scope} counts={result.scopes} onChange={scope => setFilters({ ...filters, scope })} />
        <LowMasteryChip />
        {tag && (
          <button className="chip" aria-pressed="true" onClick={() => setTag(null)}>
            #{tag} <Icon name="x" />
          </button>
        )}
        {children}
      </div>
      {result.active.length > 0 && (
        <ActiveFilters active={result.active} summary={result.summary} onRemove={group => setFilters(withoutFilter(filters, group))} onClear={() => setFilters({ ...NO_FILTERS, scope: filters.scope, dateField: filters.dateField })} />
      )}
      <FilterPanel filters={filters} facets={result.facets} onChange={setFilters} drawer open={open} onClose={() => setOpen(false)} />
    </>
  )
}

/** The type chips of the reader's other lists, which have no panel. */
export function FilterChips() {
  const { types, lowMastery, tag, query, toggleType, setTag, clearFilters } = useUiStore()
  return (
    <>
      {FILE_TYPES.map(type => (
        <button key={type.id} className="chip" aria-pressed={types.has(type.id)} onClick={() => toggleType(type.id)}>
          <span className={`tdot ${type.tone}`} style={{ fontSize: 12.5, color: 'inherit' }}>
            {type.label}
          </span>
        </button>
      ))}
      <LowMasteryChip />
      {tag && (
        <button className="chip" aria-pressed="true" onClick={() => setTag(null)}>
          #{tag} <Icon name="x" />
        </button>
      )}
      {(types.size > 0 || lowMastery || tag || query) && (
        <button className="btn quiet" onClick={clearFilters}>
          Limpar filtros
        </button>
      )}
    </>
  )
}

export function SortSelect() {
  const { sort, setSort } = useUiStore()
  return (
    <select className="input sortsel" aria-label="Ordenar" value={sort} onChange={event => setSort(event.target.value as SortKey)} style={{ width: 'auto', height: 28, padding: '2px 8px' }}>
      <option value="recent">Mais recentes</option>
      <option value="title">Título (A–Z)</option>
      <option value="mastery">Menor domínio primeiro</option>
    </select>
  )
}
