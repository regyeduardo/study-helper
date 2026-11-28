import { useNavigate } from 'react-router-dom'

import { Icon } from '@/components/ui/Icon'
import { type Toast, useUiStore } from '@/stores/ui'

/**
 * The toasts at the foot of the screen. T194: an operation running without holding the app ("busy"), and its failure, which stays with the
 * reason and "Tentar de novo" until closed. A failure is read at once (alert), outside the polite region of the others, so it is read once.
 */
export function Toasts() {
  const toasts = useUiStore(state => state.toasts)
  const dismiss = useUiStore(state => state.dismissToast)
  const navigate = useNavigate()
  const failures = toasts.filter(toast => toast.failure)
  const others = toasts.filter(toast => !toast.failure)
  const plain = (toast: Toast) => (
    <div key={toast.id} className={toast.busy ? 'toast toast-busy' : 'toast'}>
      {toast.busy && <Icon name="sync" className="spinning" />}
      {toast.text}
      {toast.action && (
        <button
          className="toast-act"
          onClick={() => {
            dismiss(toast.id)
            navigate(toast.action!.to)
          }}
        >
          {toast.action.label}
        </button>
      )}
    </div>
  )
  return (
    <div className="toasts">
      {failures.map(toast => (
        <div key={toast.id} className="toast toast-failure" role="alert">
          <Icon name="warn" />
          <span className="toast-text">{toast.text}</span>
          <button className="toast-act" onClick={toast.failure!.retry}>
            Tentar de novo
          </button>
          <button className="toast-close" aria-label="Fechar o aviso" title="Fechar o aviso" onClick={() => dismiss(toast.id)}>
            <Icon name="x" />
          </button>
        </div>
      ))}
      <div className="toasts-live" role="status" aria-live="polite">
        {others.map(plain)}
      </div>
    </div>
  )
}
