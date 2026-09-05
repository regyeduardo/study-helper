import { useState, useRef, type ReactNode } from 'react'
import { useOutsideClick } from '../../hooks/useOutsideClick'

export interface DockGroupItem {
  label: string
  onClick: () => void
  disabled?: boolean
  loading?: boolean
}

export interface DockGroupProps {
  icon: ReactNode
  label: string
  show: boolean
  items: DockGroupItem[]
  onClick?: () => void
}

export function DockGroup({ icon, label, show, items, onClick }: DockGroupProps) {
  // ── hooks must be called unconditionally ──
  const [open, setOpen] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)

  // Dismiss popover on click outside
  useOutsideClick(containerRef, open, () => setOpen(false))

  // ── early return after hooks ──
  if (!show) return null

  const handleClick = () => {
    if (onClick) {
      onClick()
    } else {
      setOpen(prev => !prev)
    }
  }

  return (
    <div ref={containerRef} className="relative flex flex-col items-center">
      {/* Dock icon button — matches DockItem visual style */}
      <button
        onClick={handleClick}
        aria-label={label}
        className="relative flex flex-col items-center justify-center gap-1 min-w-11 min-h-11 px-2 py-1 rounded-xl transition-all duration-200 ease-out hover:bg-white/10 group text-white/80"
      >
        <span className="text-2xl transition-transform duration-200 flex items-center justify-center">
          {icon}
        </span>
        <span
          className="absolute -bottom-6 text-[10px] font-medium text-white/80
                     whitespace-nowrap opacity-0 group-hover:opacity-100
                     transition-opacity duration-200 bg-black/60 px-2 py-0.5
                     rounded-md pointer-events-none"
        >
          {label}
        </span>
      </button>

      {/* Popover above the icon */}
      {open && (
        <div
          className="absolute bottom-full mb-2 z-50 min-w-44 bg-[#0d0d15] border border-white/10 rounded-xl shadow-2xl shadow-black/50 overflow-hidden"
        >
          {items.map((item, i) => (
            <button
              key={i}
              data-testid={item.loading ? 'dock-item-loading' : undefined}
              onClick={() => {
                if (!item.disabled && !item.loading) {
                  item.onClick()
                  setOpen(false)
                }
              }}
              disabled={item.disabled || item.loading}
              className={`w-full flex items-center gap-2 px-4 py-2.5 text-sm text-slate-300 hover:bg-white/5 hover:text-white transition-colors text-left ${
                item.disabled || item.loading ? 'opacity-50 cursor-not-allowed' : ''
              }`}
            >
              {item.loading ? (
                <span className="w-3.5 h-3.5 border-2 border-violet-400 border-t-transparent rounded-full animate-spin inline-block shrink-0" />
              ) : null}
              {item.label}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
