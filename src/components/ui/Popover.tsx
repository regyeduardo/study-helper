import { type ReactNode, useEffect, useLayoutEffect, useRef, useState } from 'react'

interface PopoverProps {
  x: number
  y: number
  onClose(): void
  children: ReactNode
  label?: string
}

const MARGIN = 8

export function Popover({ x, y, onClose, children, label }: PopoverProps) {
  const box = useRef<HTMLDivElement>(null)
  const [position, setPosition] = useState({ left: x, top: y })

  useLayoutEffect(() => {
    const element = box.current
    if (!element) return
    const { width, height } = element.getBoundingClientRect()
    setPosition({
      left: Math.max(MARGIN, Math.min(x, window.innerWidth - width - MARGIN)),
      top: y + height + MARGIN > window.innerHeight ? Math.max(MARGIN, y - height) : y,
    })
  }, [x, y])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => event.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div className="scrim" style={{ background: 'transparent', display: 'block', padding: 0, position: 'fixed' }} onMouseDown={event => event.target === event.currentTarget && onClose()}>
      <div ref={box} className="menu" role="menu" aria-label={label} style={{ position: 'fixed', left: position.left, top: position.top }}>
        {children}
      </div>
    </div>
  )
}
