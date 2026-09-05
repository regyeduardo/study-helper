interface RegenerateDialogProps {
  onRedo: () => void
  onClose: () => void
}

import { ClipboardList, RefreshCw } from 'lucide-react'

export default function RegenerateDialog({ onRedo, onClose }: RegenerateDialogProps) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm">
      <div className="bg-[#0d0d15] border border-white/10 rounded-2xl w-full max-w-md mx-4 p-6 shadow-2xl">
        <h2 className="text-lg font-semibold text-white flex items-center gap-2 mb-3">
          <ClipboardList size={20} className="text-violet-400" />
          Gerar Novas Questões
        </h2>
        <p className="text-sm text-slate-400 mb-6">
          Já existem questões geradas para este conteúdo. Deseja substituí-las por novas questões?
        </p>
        <p className="text-xs text-amber-400 mb-6 bg-amber-500/10 border border-amber-500/20 rounded-lg p-3">
          ⚠️ As questões anteriores serão permanentemente substituídas.
        </p>

        <div className="space-y-3">
          <button
            onClick={() => { onRedo(); onClose() }}
            className="w-full flex items-center gap-3 p-4 rounded-xl bg-amber-500/10 border border-amber-500/30 hover:bg-amber-500/20 transition-colors text-left"
          >
            <span className="flex items-center justify-center w-8 h-8 rounded-lg bg-amber-500/20 text-amber-400"><RefreshCw size={20} /></span>
            <div>
              <p className="text-sm font-medium text-white">Gerar novas questões</p>
              <p className="text-xs text-slate-400 mt-0.5">
                As questões atuais serão substituídas por novas
              </p>
            </div>
          </button>
        </div>

        <button
          onClick={onClose}
          className="mt-4 w-full py-2.5 text-sm font-medium rounded-lg bg-white/5 border border-white/10 text-slate-400 hover:bg-white/10 hover:text-white transition-colors"
        >
          Cancelar
        </button>
      </div>
    </div>
  )
}
