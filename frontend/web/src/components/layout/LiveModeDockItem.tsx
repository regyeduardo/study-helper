import { useState, useRef } from 'react'
import { useOutsideClick } from '../../hooks/useOutsideClick'
import { Loader2, Save } from 'lucide-react'

export interface LiveModeDockItemProps {
  streamingOpen: boolean
  active: boolean
  complete: boolean
  onViewStream: () => void
  onCancelStream: () => void
  onOpenSaveModal: () => void
}

/**
 * `LiveModeDockItem` — a dock item that serves as the live mode control hub.
 *
 * State machine:
 *   streamingOpen=false  → hidden (returns null)
 *   active=true + !complete  → generating (spinner + popover)
 *   !active + complete  → ready (save icon, direct click)
 */
export default function LiveModeDockItem({
  streamingOpen,
  active,
  complete,
  onViewStream,
  onCancelStream,
  onOpenSaveModal,
}: LiveModeDockItemProps) {
  // ── hidden state ──
  if (!streamingOpen) return null

  const isGenerating = active && !complete
  const isReady = !active && complete

  // ── ready state (save icon, direct click → modal) ──
  if (isReady) {
    return (
      <button
        onClick={onOpenSaveModal}
        aria-label="Salvar aula"
        className="relative flex flex-col items-center gap-1 px-2 py-1 rounded-xl transition-all duration-200 ease-out hover:bg-white/10 group text-white/80"
      >
        <span className="text-2xl transition-transform duration-200 flex items-center justify-center">
          <Save className="animate-bounce text-white/70" size={24} />
        </span>
        <span
          className="absolute -bottom-6 text-[10px] font-medium text-white/80
                     whitespace-nowrap opacity-0 group-hover:opacity-100
                     transition-opacity duration-200 bg-black/60 px-2 py-0.5
                     rounded-md pointer-events-none"
        >
          Salvar aula
        </span>
      </button>
    )
  }

  // ── generating state (spinner + popover with contextual actions) ──
  return (
    <GeneratingPopover
      onViewStream={onViewStream}
      onCancelStream={onCancelStream}
    />
  )
}

// ── Internal: generating-state with popover ──

interface GeneratingPopoverProps {
  onViewStream: () => void
  onCancelStream: () => void
}

function GeneratingPopover({ onViewStream, onCancelStream }: GeneratingPopoverProps) {
  const [open, setOpen] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)

  // Dismiss popover on click outside
  useOutsideClick(containerRef, open, () => setOpen(false))

  const handleView = () => {
    onViewStream()
    setOpen(false)
  }

  const handleCancel = () => {
    onCancelStream()
    setOpen(false)
  }

  return (
    <div ref={containerRef} className="relative flex flex-col items-center">
      <button
        onClick={() => setOpen(true)}
        aria-label="Ao Vivo"
        className="relative flex flex-col items-center gap-1 px-2 py-1 rounded-xl transition-all duration-200 ease-out hover:bg-white/10 group text-white/80"
      >
        <span className="text-2xl transition-transform duration-200 flex items-center justify-center">
          <Loader2 className="animate-spin text-white/60" size={24} />
        </span>
        <span
          className="absolute -bottom-6 text-[10px] font-medium text-white/80
                     whitespace-nowrap opacity-0 group-hover:opacity-100
                     transition-opacity duration-200 bg-black/60 px-2 py-0.5
                     rounded-md pointer-events-none"
        >
          Ao Vivo
        </span>
      </button>

      {open && (
        <div
          className="absolute bottom-full mb-2 z-50 min-w-44 bg-[#0d0d15] border border-white/10 rounded-xl shadow-2xl shadow-black/50 overflow-hidden"
        >
          <button
            onClick={handleView}
            className="w-full flex items-center gap-2 px-4 py-2.5 text-sm text-slate-300 hover:bg-white/5 hover:text-white transition-colors text-left"
          >
            Ver geração
          </button>
          <button
            onClick={handleCancel}
            className="w-full flex items-center gap-2 px-4 py-2.5 text-sm text-red-400 hover:bg-white/5 hover:text-red-300 transition-colors text-left"
          >
            Cancelar geração
          </button>
        </div>
      )}
    </div>
  )
}
