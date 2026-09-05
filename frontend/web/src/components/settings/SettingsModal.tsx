import { X, Sparkles } from 'lucide-react'
import { useDockPosition } from '@/hooks/useDockPosition'

interface SettingsModalProps {
  open: boolean
  onClose: () => void
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [key: string]: any
}

export default function SettingsModal({
  open,
  onClose,
}: SettingsModalProps) {
  const [dockPosition, setDockPosition] = useDockPosition()

  if (!open) return null

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm">
      <div className="bg-[#0d0d15] border border-white/10 rounded-2xl w-full max-w-lg mx-4 shadow-2xl overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3 border-b border-white/10">
          <div className="flex items-center gap-2">
            <Sparkles size={18} className="text-violet-400" />
            <h2 className="text-lg font-semibold text-white">Configurações</h2>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-white/10 transition-colors"
          >
            <X size={18} />
          </button>
        </div>

        {/* Body */}
        <div className="px-5 py-4 space-y-4">
          {/* Dock lateral — Posição */}
          <div className="flex items-center justify-between">
            <span className="text-sm font-medium text-slate-300">
              Dock lateral — Posição
            </span>
            <div className="flex gap-1 bg-white/5 rounded-lg p-1">
              <button
                onClick={() => setDockPosition('left')}
                className={`px-3 py-1.5 text-xs font-semibold rounded-md transition-colors ${
                  dockPosition === 'left'
                    ? 'bg-violet-600 text-white shadow-md'
                    : 'text-slate-400 hover:text-white'
                }`}
              >
                Esquerda
              </button>
              <button
                onClick={() => setDockPosition('right')}
                className={`px-3 py-1.5 text-xs font-semibold rounded-md transition-colors ${
                  dockPosition === 'right'
                    ? 'bg-violet-600 text-white shadow-md'
                    : 'text-slate-400 hover:text-white'
                }`}
              >
                Direita
              </button>
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end px-5 py-3 border-t border-white/10">
          <button
            onClick={onClose}
            className="px-5 py-2 text-sm font-semibold rounded-xl text-white
                       bg-linear-to-r from-violet-600 to-cyan-600 hover:from-violet-500 hover:to-cyan-500
                       transition-all duration-200 shadow-lg shadow-violet-500/20"
          >
            Fechar
          </button>
        </div>
      </div>
    </div>
  )
}
