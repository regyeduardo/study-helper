import { useState, useRef, useEffect, type ReactNode } from 'react'

export interface DropdownItem {
  label: string
  icon?: ReactNode
  onClick?: () => void
  children?: DropdownItem[]
  hidden?: boolean
  disabled?: boolean
}

interface DropdownMenuProps {
  trigger: ReactNode
  triggerClassName?: string
  items: DropdownItem[]
  align?: 'left' | 'right'
}

export default function DropdownMenu({ trigger, triggerClassName, items, align = 'right' }: DropdownMenuProps) {
  const [open, setOpen] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    if (open) document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open])

  const visibleItems = items.filter((i) => !i.hidden)

  return (
    <div ref={containerRef} className="relative inline-block">
      <button
        onClick={() => setOpen(!open)}
        className={triggerClassName || 'px-3 py-1.5 text-xs font-medium rounded-lg bg-white/5 border border-white/10 text-slate-300 hover:bg-white/10 transition-colors'}
      >
        {trigger}
      </button>

      {open && visibleItems.length > 0 && (
        <div
          className={`absolute top-full mt-1 z-50 min-w-50 bg-[#0d0d15] border border-white/10 rounded-xl shadow-2xl shadow-black/50 overflow-hidden ${
            align === 'right' ? 'right-0' : 'left-0'
          }`}
        >
          {visibleItems.map((item, idx) => (
            <DropdownItemRow
              key={idx}
              item={item}
              onClose={() => setOpen(false)}
            />
          ))}
        </div>
      )}
    </div>
  )
}

interface DropdownItemRowProps {
  item: DropdownItem
  onClose: () => void
}

function DropdownItemRow({ item, onClose }: DropdownItemRowProps) {
  const [subOpen, setSubOpen] = useState(false)
  const rowRef = useRef<HTMLDivElement>(null)

  const hasSubmenu = item.children && item.children.some((c) => !c.hidden)

  return (
    <div ref={rowRef} className="relative">
      <button
        onClick={() => {
          if (hasSubmenu) {
            setSubOpen((prev) => !prev)
          } else {
            item.onClick?.()
            onClose()
          }
        }}
        onMouseEnter={() => hasSubmenu && setSubOpen(true)}
        onMouseLeave={(e) => {
          if (hasSubmenu) {
            const submenu = rowRef.current?.querySelector('[data-submenu="true"]')
            if (submenu && !submenu.contains(e.relatedTarget as Node)) {
              setSubOpen(false)
            }
          }
        }}
        disabled={item.disabled}
        className="w-full flex items-center gap-2 px-4 py-2.5 text-sm text-slate-300 transition-colors text-left disabled:opacity-50 disabled:cursor-not-allowed disabled:pointer-events-none enabled:hover:bg-white/5 enabled:hover:text-white"
      >
        {item.icon && <span className="text-base flex items-center">{item.icon}</span>}
        <span className="flex-1">{item.label}</span>
        {hasSubmenu && <span className="text-slate-500 text-xs">▶</span>}
      </button>

      {hasSubmenu && subOpen && (
        <div
          data-submenu="true"
          className="absolute top-0 right-full mr-1 z-50 min-w-50 bg-[#0d0d15] border border-white/10 rounded-xl shadow-2xl shadow-black/50 overflow-hidden"
        >
          {(item.children ?? [])
            .filter((c) => !c.hidden)
            .map((child, cIdx) => (
              <button
                key={cIdx}
                onClick={() => {
                  child.onClick?.()
                  onClose()
                }}
                className="w-full flex items-center gap-2 px-4 py-2.5 text-sm text-slate-300 hover:bg-white/5 hover:text-white transition-colors text-left"
              >
                {child.icon && <span className="text-base flex items-center">{child.icon}</span>}
                <span>{child.label}</span>
              </button>
            ))}
        </div>
      )}
    </div>
  )
}
