import { useUiStore } from '@/stores/ui'

export function Toasts() {
  const toasts = useUiStore(state => state.toasts)
  return (
    <div className="toasts" role="status" aria-live="polite">
      {toasts.map(toast => (
        <div key={toast.id} className="toast">
          {toast.text}
        </div>
      ))}
    </div>
  )
}
