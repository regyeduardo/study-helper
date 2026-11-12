import { useNavigate } from 'react-router-dom'

import { useUiStore } from '@/stores/ui'

export function Toasts() {
  const toasts = useUiStore(state => state.toasts)
  const dismiss = useUiStore(state => state.dismissToast)
  const navigate = useNavigate()
  return (
    <div className="toasts" role="status" aria-live="polite">
      {toasts.map(toast => (
        <div key={toast.id} className="toast">
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
      ))}
    </div>
  )
}
