// The filter panel (FR-044, FR-045): every group and count in view, beside the table; on the phone, a drawer.
import { type CSSProperties, type ReactNode, useEffect, useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

import { Icon, type IconName } from '@/components/ui/Icon'
import { DATE_FIELD_LABELS, GROUP_LABELS, toggleOption, type DateField, type FacetOption, type Facets, type FilterGroup, type FolderOption, type ItemKind, type LibraryFilters } from '@/lib/library-filters'
import '@/styles/filter-panel.css'

export interface FilterPanelProps {
  filters: LibraryFilters
  facets: Facets
  onChange(next: LibraryFilters): void
  /** Beside the table: only a narrow rail stays. */
  collapsed?: boolean
  onCollapsedChange?(collapsed: boolean): void
  /** On the phone: a drawer, shown while `open`. `collapsed` does not apply. */
  drawer?: boolean
  open?: boolean
  onClose?(): void
}

type ListGroup = Exclude<FilterGroup, 'period'>

const TITLE = 'Filtros'
/** Rows of a long list (Etiqueta, Pasta) before "Ver as N". */
const LONG_LIST = 5
const MAX_INDENT = 5
const DATE_FIELDS: DateField[] = ['updated', 'created']
const KIND_ICONS: Record<ItemKind, IconName> = { video: 'monitor', audio: 'mic', pdf: 'file', link: 'link', texto: 'text', tema: 'bulb', arquivo: 'file', nota: 'note' }

const itemsLabel = (count: number) => (count === 1 ? '1 item' : `${count} itens`)
const activeLabel = (count: number) => (count === 1 ? '1 ativo' : `${count} ativos`)

/** "Escolher datas…" with no day yet is not a filter. */
const periodIsActive = (facets: Facets) => facets.period.some(preset => preset.selected) || facets.periodCustom !== null

/** Groups in use, the same that become chips above the table. */
function activeGroups(filters: LibraryFilters, facets: Facets): number {
  const lists = [filters.kinds, filters.generated, filters.tags, filters.folders, filters.places].filter(list => list.length).length
  return lists + (periodIsActive(facets) ? 1 : 0)
}

/* ---------- one option ---------- */

interface OptionRowProps {
  label: string
  /** null: no number to show. */
  count: number | null
  selected: boolean
  onToggle(): void
  /** The radios of one group share this name. */
  radio?: string
  icon?: IconName
  depth?: number
  onOnly?(): void
}

function OptionRow({ label, count, selected, onToggle, radio, icon, depth, onOnly }: OptionRowProps) {
  const zero = count === 0 && !selected
  return (
    <div className={`fp-row${selected ? ' fp-on' : ''}${zero ? ' fp-zero' : ''}`}>
      <label className="fp-opt" style={depth ? ({ '--fp-depth': Math.min(depth, MAX_INDENT) } as CSSProperties) : undefined}>
        {/* onClick, not onChange: a radio already checked fires no change, and clicking it again takes the period off */}
        <input className={radio ? 'fp-radio' : 'fp-box'} type={radio ? 'radio' : 'checkbox'} name={radio} checked={selected} readOnly aria-label={count === null ? label : `${label}, ${itemsLabel(count)}`} onClick={onToggle} />
        {icon && <Icon name={icon} />}
        <span className="fp-name" title={label}>
          {label}
        </span>
        {count !== null && <span className="fp-count">{count}</span>}
      </label>
      {onOnly && (
        <button className="fp-only" aria-label={`só este: ${label}`} onClick={onOnly}>
          só este
        </button>
      )}
    </div>
  )
}

/* ---------- one group ---------- */

interface GroupProps {
  title: string
  summary?: ReactNode
  more?: ReactNode
  children: ReactNode
}

function Group({ title, summary, more, children }: GroupProps) {
  const [open, setOpen] = useState(true)
  const id = useId()
  const titleId = `${id}-title`
  const bodyId = `${id}-body`
  return (
    <div className="fp-group" role="group" aria-labelledby={titleId}>
      <div className="fp-ghead">
        <h3 className="fp-gh">
          <button id={titleId} className="fp-gtitle" aria-expanded={open} aria-controls={open ? bodyId : undefined} onClick={() => setOpen(!open)}>
            {title}
          </button>
        </h3>
        <div className="fp-gside">
          {summary}
          {more}
          <Icon name="chev" className={`fp-chev${open ? '' : ' fp-shut'}`} />
        </div>
      </div>
      {open && <div id={bodyId}>{children}</div>}
    </div>
  )
}

const selectedCount = (count: number) => (count > 0 ? <span className="fp-num">{count}</span> : null)

interface OptionGroupProps<G extends ListGroup> {
  group: G
  options: (FacetOption<LibraryFilters[G][number]> & { depth?: number })[]
  filters: LibraryFilters
  onChange(next: LibraryFilters): void
  icons?: Partial<Record<string, IconName>>
  /** Long list: the first rows and the checked ones, until "Ver as N". */
  long?: boolean
  summary?: ReactNode
  /** Goes above the options. */
  children?: ReactNode
}

function OptionGroup<G extends ListGroup>({ group, options, filters, onChange, icons, long = false, summary, children }: OptionGroupProps<G>) {
  const [all, setAll] = useState(false)
  const tooLong = long && options.length > LONG_LIST
  const visible = tooLong && !all ? options.filter((option, index) => index < LONG_LIST || option.selected) : options
  const chosen = filters[group].length
  const more = tooLong && (
    <button className="fp-more" aria-expanded={all} onClick={() => setAll(!all)}>
      {all ? 'Ver menos' : `Ver as ${options.length}`}
    </button>
  )
  return (
    <Group title={GROUP_LABELS[group]} summary={summary ?? selectedCount(chosen)} more={more}>
      {children}
      <div className={all ? 'fp-all' : undefined}>
        {visible.map(option => (
          <OptionRow
            key={String(option.id)}
            label={option.label}
            count={option.count}
            selected={option.selected}
            icon={icons?.[String(option.id)]}
            depth={option.depth}
            onToggle={() => onChange(toggleOption(filters, group, option.id))}
            onOnly={option.selected && chosen === 1 ? undefined : () => onChange({ ...filters, [group]: [option.id] })}
          />
        ))}
      </div>
    </Group>
  )
}

function folderSummary(folders: FolderOption[]): ReactNode {
  const chosen = folders.filter(folder => folder.selected)
  if (!chosen.length) return null
  return (
    <span className="fp-sum" title={chosen.map(folder => folder.label).join(', ')}>
      {chosen.length === 1 ? chosen[0].label : `${chosen.length} pastas`}
    </span>
  )
}

/* ---------- Período ---------- */

interface PeriodGroupProps {
  filters: LibraryFilters
  facets: Facets
  change(patch: Partial<LibraryFilters>): void
}

function PeriodGroup({ filters, facets, change }: PeriodGroupProps) {
  const presets = useId()
  const field = useId()
  const days = typeof filters.period === 'object' ? filters.period : null
  return (
    <Group title={GROUP_LABELS.period} summary={selectedCount(periodIsActive(facets) ? 1 : 0)}>
      <div className="fp-seg" role="radiogroup" aria-label="Data do período">
        {DATE_FIELDS.map(id => (
          <label key={id} className={`fp-segb${filters.dateField === id ? ' fp-on' : ''}`}>
            <input className="fp-sr" type="radio" name={field} checked={filters.dateField === id} onChange={() => change({ dateField: id })} />
            {DATE_FIELD_LABELS[id]}
          </label>
        ))}
      </div>
      {facets.period.map(preset => (
        <OptionRow key={preset.id} radio={presets} label={preset.label} count={preset.count} selected={preset.selected} onToggle={() => change({ period: preset.selected ? null : preset.id })} />
      ))}
      <OptionRow radio={presets} label="Escolher datas…" count={facets.periodCustom} selected={days !== null} onToggle={() => change({ period: days ? null : {} })} />
      {days && (
        <div className="fp-dates">
          <label className="fp-date">
            <span>De</span>
            <input className="input" type="date" value={days.from ?? ''} onChange={event => change({ period: { ...days, from: event.target.value || undefined } })} />
          </label>
          <label className="fp-date">
            <span>Até</span>
            <input className="input" type="date" value={days.to ?? ''} onChange={event => change({ period: { ...days, to: event.target.value || undefined } })} />
          </label>
        </div>
      )}
    </Group>
  )
}

/* ---------- the panel ---------- */

type BodyProps = Pick<FilterPanelProps, 'filters' | 'facets' | 'onChange'>

function PanelBody({ filters, facets, onChange }: BodyProps) {
  const shared = { filters, onChange }
  return (
    <div className="fp-body">
      <OptionGroup group="kinds" options={facets.kinds} icons={KIND_ICONS} {...shared} />
      <OptionGroup group="generated" options={facets.generated} {...shared} />
      <PeriodGroup filters={filters} facets={facets} change={patch => onChange({ ...filters, ...patch })} />
      <OptionGroup group="tags" options={facets.tags} long {...shared} />
      <OptionGroup group="folders" options={facets.folders} long summary={folderSummary(facets.folders)} {...shared}>
        {facets.withSubfolders !== null && <OptionRow label="Com subpastas" count={facets.withSubfolders} selected={filters.subfolders} onToggle={() => onChange({ ...filters, subfolders: !filters.subfolders })} />}
      </OptionGroup>
      <OptionGroup group="places" options={facets.places} {...shared} />
    </div>
  )
}

function PanelHead({ active, children }: { active: number; children: ReactNode }) {
  return (
    <header className="fp-head">
      <h2 className="fp-title">{TITLE}</h2>
      {active > 0 && <span className="fp-active">{activeLabel(active)}</span>}
      {children}
    </header>
  )
}

function FilterDrawer({ active, onClose, children }: { active: number; onClose?: () => void; children: ReactNode }) {
  const closeButton = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null
    closeButton.current?.focus()
    return () => opener?.focus()
  }, [])

  useEffect(() => {
    if (!onClose) return
    const onKey = (event: KeyboardEvent) => event.key === 'Escape' && !event.defaultPrevented && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return createPortal(
    <div className="scrim fp-scrim" onMouseDown={event => event.target === event.currentTarget && onClose?.()}>
      <div className="fp fp-drawer" role="dialog" aria-modal="true" aria-label={TITLE}>
        <PanelHead active={active}>
          <button ref={closeButton} className="ibtn fp-toggle" aria-label="Fechar os filtros" title="Fechar os filtros" onClick={onClose}>
            <Icon name="x" />
          </button>
        </PanelHead>
        {children}
      </div>
    </div>,
    document.body,
  )
}

export function FilterPanel({ filters, facets, onChange, collapsed = false, onCollapsedChange, drawer = false, open = false, onClose }: FilterPanelProps) {
  const active = activeGroups(filters, facets)
  const body = <PanelBody filters={filters} facets={facets} onChange={onChange} />

  if (drawer) {
    return open ? (
      <FilterDrawer active={active} onClose={onClose}>
        {body}
      </FilterDrawer>
    ) : null
  }

  if (collapsed) {
    const show = active ? `Mostrar os filtros, ${activeLabel(active)}` : 'Mostrar os filtros'
    return (
      <aside className="fp fp-rail" aria-label={TITLE}>
        <button className="ibtn" aria-label={show} title={show} aria-expanded={false} onClick={() => onCollapsedChange?.(false)}>
          <Icon name="filter" />
        </button>
        {active > 0 && (
          <span className="fp-num" aria-hidden="true">
            {active}
          </span>
        )}
      </aside>
    )
  }

  return (
    <aside className="fp" aria-label={TITLE}>
      <PanelHead active={active}>
        <button className="ibtn fp-toggle" aria-label="Recolher os filtros" title="Recolher os filtros" aria-expanded onClick={() => onCollapsedChange?.(true)}>
          <Icon name="sidebar" />
        </button>
      </PanelHead>
      {body}
    </aside>
  )
}
