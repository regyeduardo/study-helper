import { useCallback, useState } from 'react'
import type { ReactNode } from 'react'
import ContextMenu from '@/components/reading/ContextMenu'
import type { ContextMenuItem } from '@/types'

interface SelectionMenuProps {
  children: ReactNode
  canExplain: boolean
  onExplainSelection: (excerpt: string) => void
}

export function currentSelectionText(): string {
  return window.getSelection()?.toString().trim() ?? ''
}

export default function SelectionMenu({ children, canExplain, onExplainSelection }: SelectionMenuProps) {
  const [position, setPosition] = useState({ x: 0, y: 0 })
  const [items, setItems] = useState<ContextMenuItem[]>([])
  const [visible, setVisible] = useState(false)

  const handleContextMenu = useCallback(
    (event: React.MouseEvent) => {
      const excerpt = currentSelectionText()
      const menu: ContextMenuItem[] = []

      if (canExplain && excerpt) {
        menu.push({
          id: 'explain-selection',
          label: 'Gerar explicação',
          kind: 'app',
          onClick: () => onExplainSelection(excerpt),
        })
        menu.push({ id: 'divider', label: '', kind: 'divider' })
      }

      menu.push({ id: 'copy', label: 'Copiar', kind: 'browser' })
      menu.push({ id: 'select-all', label: 'Selecionar tudo', kind: 'browser' })

      event.preventDefault()
      setPosition({ x: event.clientX, y: event.clientY })
      setItems(menu)
      setVisible(true)
    },
    [canExplain, onExplainSelection],
  )

  return (
    <div data-content-viewer onContextMenu={handleContextMenu}>
      {children}
      {visible && (
        <ContextMenu items={items} x={position.x} y={position.y} onClose={() => setVisible(false)} />
      )}
    </div>
  )
}
