import { Icon } from '@/components/ui/Icon'
import { useUiStore } from '@/stores/ui'

export function EmptyList({ filtering, browsing, hasTiles }: { filtering: boolean; browsing: boolean; hasTiles: boolean }) {
  const clearFilters = useUiStore(state => state.clearFilters)
  if (filtering) {
    return (
      <div className="empty">
        <Icon name="search" />
        <div>Nada com esses filtros.</div>
        <button className="btn" onClick={clearFilters}>
          Limpar filtros
        </button>
      </div>
    )
  }
  return (
    <div className="empty" style={{ padding: 14 }}>
      <Icon name="file" />
      <div>{browsing ? (hasTiles ? 'Nenhum arquivo solto aqui. Abra uma das pastas acima.' : 'Pasta vazia. Arraste arquivos para cá ou crie um conteúdo novo.') : 'Nada por aqui.'}</div>
    </div>
  )
}
