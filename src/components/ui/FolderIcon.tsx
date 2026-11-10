import type { FolderColor } from '@/types/domain'
import { Icon } from '@/components/ui/Icon'

const SPOKEN: Record<FolderColor, string> = { vermelho: 'vermelha', laranja: 'laranja', amarelo: 'amarela', verde: 'verde', azul: 'azul', roxo: 'roxa', cinza: 'cinza' }

/** The folder icon in the folder's color; the color is also said, so it never depends on seeing it. */
export function FolderIcon({ color, className = '' }: { color?: FolderColor; className?: string }) {
  if (!color) return <Icon name="folder" className={className} />
  const name = `Pasta ${SPOKEN[color]}`
  return (
    <span role="img" aria-label={name} title={name} className={`folder-ic ${className}`} style={{ color: `var(--folder-${color})` }}>
      <Icon name="folder" />
    </span>
  )
}
