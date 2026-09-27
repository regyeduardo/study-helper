import { type ReactNode, useEffect } from 'react'

import { Icon } from '@/components/ui/Icon'

interface DialogProps {
  title: ReactNode
  size?: 'narrow' | 'normal' | 'wide'
  onClose?: () => void
  footer?: ReactNode
  children: ReactNode
  label?: string
  role?: 'dialog' | 'alertdialog'
  style?: React.CSSProperties
}

export function Dialog({ title, size = 'normal', onClose, footer, children, label, role = 'dialog', style }: DialogProps) {
  useEffect(() => {
    if (!onClose) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div className="scrim" onMouseDown={event => event.target === event.currentTarget && onClose?.()}>
      <div className={`dialog ${size === 'normal' ? '' : size}`} role={role} aria-modal="true" aria-label={label ?? (typeof title === 'string' ? title : undefined)} style={style}>
        <div className="dh">
          <h2>{title}</h2>
          {onClose && (
            <button className="ibtn" onClick={onClose} aria-label="Fechar">
              <Icon name="x" />
            </button>
          )}
        </div>
        {children}
        {footer && <div className="df">{footer}</div>}
      </div>
    </div>
  )
}
