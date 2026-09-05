import { useState } from 'react'
import { X, Layers } from 'lucide-react'

interface FolderExamDialogProps {
  folderName: string
  totalQuestions: number
  onConfirm: (count: number | 'all') => void
  onCancel: () => void
}

export default function FolderExamDialog({
  folderName,
  totalQuestions,
  onConfirm,
  onCancel,
}: FolderExamDialogProps) {
  const [count, setCount] = useState<string>('')
  const isEmpty = totalQuestions === 0

  const handleConfirm = () => {
    const n = parseInt(count, 10)
    if (!isNaN(n) && n > 0) {
      onConfirm(Math.min(n, totalQuestions))
    }
  }

  const handleAll = () => {
    onConfirm('all')
  }

  return (
    <div className="fixed inset-0 z-120 flex items-center justify-center bg-black/50 backdrop-blur-sm">
      <div className="bg-[#12121a] border border-white/10 rounded-xl w-full max-w-sm mx-4 shadow-2xl">
        <div className="flex items-center justify-between px-5 py-3 border-b border-white/10">
          <h3 className="text-sm font-semibold text-white flex items-center gap-2">
            <Layers size={16} className="text-violet-400" />
            Prova da Pasta
          </h3>
          <button onClick={onCancel} className="p-1 rounded text-slate-500 hover:text-white hover:bg-white/10">
            <X size={14} />
          </button>
        </div>

        <div className="p-5 space-y-4">
          <p className="text-sm text-slate-400">
            Pasta: <span className="text-white font-medium">{folderName}</span>
          </p>

          {isEmpty ? (
            <p className="text-sm text-amber-400 bg-amber-500/10 border border-amber-500/20 rounded-lg p-3">
              Nenhuma questão encontrada nos arquivos desta pasta.
            </p>
          ) : (
            <>
              <p className="text-xs text-slate-500">
                {totalQuestions} questão{totalQuestions !== 1 ? 'ões' : ''} disponível{totalQuestions !== 1 ? 'is' : ''}
              </p>

              <div>
                <label className="text-xs text-slate-400 block mb-1.5">
                  Quantas questões?
                </label>
                <input
                  type="number"
                  min={1}
                  max={totalQuestions}
                  value={count}
                  onChange={(e) => setCount(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && handleConfirm()}
                  placeholder={`1-${totalQuestions}`}
                  className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm text-white placeholder:text-slate-600 focus:border-violet-500/50"
                  autoFocus
                />
              </div>

              <div className="flex gap-2">
                <button
                  onClick={handleConfirm}
                  disabled={!count || parseInt(count) < 1}
                  className="flex-1 px-4 py-2 text-sm font-medium rounded-lg bg-violet-600 text-white hover:bg-violet-500 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                >
                  Iniciar ({count || '?'})
                </button>
                <button
                  onClick={handleAll}
                  className="px-4 py-2 text-sm font-medium rounded-lg bg-white/5 border border-white/10 text-slate-300 hover:bg-white/10 transition-colors"
                >
                  Todas ({totalQuestions})
                </button>
              </div>
            </>
          )}
        </div>

        {isEmpty && (
          <div className="px-5 pb-5">
            <button
              onClick={onCancel}
              className="w-full px-4 py-2 text-sm font-medium rounded-lg bg-white/5 border border-white/10 text-slate-400 hover:bg-white/10 transition-colors"
            >
              Fechar
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
