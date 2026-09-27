import { Icon } from '@/components/ui/Icon'
import { FILE_TYPES } from '@/lib/file-types'
import { type SortKey, useUiStore } from '@/stores/ui'

export function FilterChips() {
  const { types, lowMastery, tag, query, toggleType, toggleLowMastery, setTag, clearFilters } = useUiStore()
  return (
    <>
      {FILE_TYPES.map(type => (
        <button key={type.id} className="chip" aria-pressed={types.has(type.id)} onClick={() => toggleType(type.id)}>
          <span className={`tdot ${type.tone}`} style={{ fontSize: 12.5, color: 'inherit' }}>
            {type.label}
          </span>
        </button>
      ))}
      <button className="chip" aria-pressed={lowMastery} onClick={toggleLowMastery}>
        <Icon name="warn" />
        Domínio abaixo de 60%
      </button>
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
