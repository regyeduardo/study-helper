import { useState } from 'react'

interface GenerationModeModalProps {
  open: boolean
  onRealtime: () => void
  onBackground: () => void
  onClose: () => void
}

/**
 * GenerationModeModal — shown before generation starts.
 *
 * Gives the user two options:
 * - "Acompanhar em tempo real" — opens streaming view
 * - "Deixar em segundo plano" — runs in background, toast on completion
 */
export default function GenerationModeModal({
  open,
  onRealtime,
  onBackground,
  onClose,
}: GenerationModeModalProps) {
  const [selected, setSelected] = useState<'realtime' | 'background' | null>(null)

  if (!open) return null

  const handleRealtime = () => {
    setSelected('realtime')
    onRealtime()
    onClose()
  }

  const handleBackground = () => {
    setSelected('background')
    onBackground()
    onClose()
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm">
      <div className="bg-[#0d0d15] border border-white/10 rounded-2xl w-full max-w-md mx-4 shadow-2xl overflow-hidden">
        {/* Header */}
        <div className="px-5 py-4 border-b border-white/10">
          <h2 className="text-lg font-semibold text-white">Modo de Geração</h2>
          <p className="text-sm text-slate-400 mt-1">
            Escolha como deseja acompanhar a geração da aula:
          </p>
        </div>

        {/* Options */}
        <div className="p-4 space-y-3">
          <button
            onClick={handleRealtime}
            data-testid="realtime-option"
            className={`w-full text-left p-4 rounded-xl border transition-all duration-200
              ${selected === 'realtime'
                ? 'border-violet-500 bg-violet-500/10'
                : 'border-white/10 bg-white/5 hover:bg-white/10 hover:border-white/20'
              }`}
          >
            <div className="font-medium text-white text-sm">
              Acompanhar em tempo real
            </div>
            <div className="text-xs text-slate-400 mt-1">
              Acompanhe a geração passo a passo, vendo o texto e diagramas aparecerem gradualmente
            </div>
          </button>

          <button
            onClick={handleBackground}
            data-testid="background-option"
            className={`w-full text-left p-4 rounded-xl border transition-all duration-200
              ${selected === 'background'
                ? 'border-cyan-500 bg-cyan-500/10'
                : 'border-white/10 bg-white/5 hover:bg-white/10 hover:border-white/20'
              }`}
          >
            <div className="font-medium text-white text-sm">
              Deixar em segundo plano
            </div>
            <div className="text-xs text-slate-400 mt-1">
              A geração será feita em segundo plano. Você receberá uma notificação quando estiver pronta
            </div>
          </button>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end px-5 py-3 border-t border-white/10">
          <button
            onClick={() => { setSelected(null); onClose() }}
            className="px-4 py-2 text-sm font-medium rounded-lg bg-white/5 border border-white/10 text-slate-400 hover:bg-white/10 hover:text-white transition-colors"
          >
            Cancelar
          </button>
        </div>
      </div>
    </div>
  )
}
