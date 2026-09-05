import { useEffect, useRef, useCallback } from 'react'
import { createPortal } from 'react-dom'
import type { ContextMenuItem } from '@/types'

interface ContextMenuProps {
  items: ContextMenuItem[]
  x: number
  y: number
  onClose: () => void
}

/**
 * ContextMenu — a custom right-click menu rendered via portal.
 *
 * - Positioned at (x, y), adjusted to stay within viewport bounds.
 * - Dismissed on outside click or Escape key.
 * - Renders items in sections: app items, divider, browser items.
 */
export default function ContextMenu({ items, x, y, onClose }: ContextMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null)

  // ── Viewport adjustment ──

  useEffect(() => {
    if (!menuRef.current) return
    const menu = menuRef.current
    const rect = menu.getBoundingClientRect()
    const vw = window.innerWidth
    const vh = window.innerHeight

    let adjustedX = x
    let adjustedY = y

    if (rect.right > vw) {
      adjustedX = vw - rect.width - 8
    }
    if (rect.bottom > vh) {
      adjustedY = vh - rect.height - 8
    }

    menu.style.left = `${Math.max(0, adjustedX)}px`
    menu.style.top = `${Math.max(0, adjustedY)}px`
  }, [x, y])

  // ── Outside click ──

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose()
      }
    }
    // Use setTimeout to avoid the same click that opened the menu
    const id = setTimeout(() => {
      document.addEventListener('mousedown', handler)
    }, 0)

    return () => {
      clearTimeout(id)
      document.removeEventListener('mousedown', handler)
    }
  }, [onClose])

  // ── Escape key ──

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose()
      }
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [onClose])

  // ── Select All handler ──

  const handleSelectAll = useCallback(() => {
    const selection = window.getSelection()
    if (!selection) return

    const viewer = document.querySelector('[data-content-viewer]')
    if (viewer) {
      const range = document.createRange()
      range.selectNodeContents(viewer)
      selection.removeAllRanges()
      selection.addRange(range)
    }
    onClose()
  }, [onClose])

  // ── Copy handler ──

  const handleCopy = useCallback(() => {
    const text = window.getSelection()?.toString() ?? ''
    try {
      navigator.clipboard.writeText(text)
    } catch {
      // Fallback: do nothing if clipboard access is denied
    }
    onClose()
  }, [onClose])

  // ── No items → nothing to render ──

  if (items.length === 0) return null

  // ── Render ──

  const menu = (
    <div
      ref={menuRef}
      role="menu"
      className="fixed z-[9999] min-w-[200px] bg-[#0d0d15] border border-white/10 rounded-xl shadow-2xl shadow-black/50 overflow-hidden"
      style={{ left: x, top: y }}
    >
      {items.map((item) => {
        if (item.kind === 'divider') {
          return (
            <div
              key="divider"
              data-testid="context-menu-divider"
              className="h-px bg-white/10 mx-2"
            />
          )
        }

        return (
          <button
            key={item.id}
            role="menuitem"
            onClick={() => {
              if (item.id === 'copy') {
                handleCopy()
              } else if (item.id === 'select-all') {
                handleSelectAll()
              } else {
                item.onClick?.()
                onClose()
              }
            }}
            className="w-full flex items-center gap-2 px-4 py-2.5 text-sm text-slate-300 transition-colors text-left hover:bg-white/5 hover:text-white"
          >
            <span className="flex-1">{item.label}</span>
            {item.id === 'copy' && (
              <span className="text-xs text-slate-500">Ctrl+C</span>
            )}
            {item.id === 'select-all' && (
              <span className="text-xs text-slate-500">Ctrl+A</span>
            )}
          </button>
        )
      })}
    </div>
  )

  return createPortal(menu, document.body)
}
