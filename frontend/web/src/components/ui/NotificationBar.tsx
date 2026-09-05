import { useAppState, useAppDispatch } from '@/context/AppContext'
import { Loader2, AlertTriangle, X } from 'lucide-react'

/**
 * NotificationBar — a floating bar at the bottom of the viewport
 * that shows loading status or error messages WITHOUT affecting
 * the document viewer (OutputPanel).
 *
 * - loading: shown as an animated bar with spinner + message
 * - error: shown as a red bar with dismiss button
 * - idle (no loading, no error): renders nothing
 */
export default function NotificationBar() {
  const { isLoading, loadingMessage, loadingSubMessage, errorMessage } = useAppState()
  const dispatch = useAppDispatch()

  const showLoading = isLoading
  const showError = !!errorMessage

  if (!showLoading && !showError) return null

  return (
    <div className="fixed bottom-20 left-1/2 -translate-x-1/2 z-[9999] flex flex-col items-center gap-2 pointer-events-none">
      {/* Loading notification */}
      {showLoading && (
        <div className="pointer-events-auto flex items-center gap-2.5 bg-[#0d0d15]/95 backdrop-blur-md border border-violet-500/30 rounded-xl px-4 py-2.5 shadow-2xl shadow-violet-900/30">
          <Loader2 size={16} className="text-violet-400 animate-spin shrink-0" />
          <span className="text-xs text-violet-300 font-medium whitespace-nowrap">
            {loadingMessage || 'Processando...'}
          </span>
          {loadingSubMessage && (
            <span className="text-[11px] text-slate-500 ml-1 hidden sm:inline">
              — {loadingSubMessage}
            </span>
          )}
        </div>
      )}

      {/* Error notification */}
      {showError && (
        <div className="pointer-events-auto flex items-start gap-2.5 bg-red-500/15 backdrop-blur-md border border-red-500/30 rounded-xl px-4 py-2.5 shadow-2xl shadow-red-900/30 max-w-md">
          <AlertTriangle size={16} className="text-red-400 shrink-0 mt-0.5" />
          <span className="text-xs text-red-300 flex-1">{errorMessage}</span>
          <button
            onClick={() => dispatch({ type: 'SET_ERROR', payload: null })}
            className="p-0.5 rounded text-red-400 hover:text-red-300 hover:bg-red-500/10 shrink-0"
          >
            <X size={14} />
          </button>
        </div>
      )}
    </div>
  )
}
