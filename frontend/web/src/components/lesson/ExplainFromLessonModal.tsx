import { useState, useEffect } from 'react'
import { Sparkles, X } from 'lucide-react'

export interface ExplainFromLessonModalProps {
  lessonName: string
  lessonFileId: string
  onSubmit: (payload: { fileId: string; focus: string }) => void
  onClose: () => void
}

export function ExplainFromLessonModal({
  lessonName,
  lessonFileId,
  onSubmit,
  onClose,
}: ExplainFromLessonModalProps) {
  const [focus, setFocus] = useState('')

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose()
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [onClose])

  const handleSubmit = () => {
    onSubmit({ fileId: lessonFileId, focus })
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm">
      <div className="bg-[#0d0d15] border border-white/10 rounded-2xl w-full max-w-md mx-4 shadow-2xl overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-white/10">
          <div className="flex items-center gap-2">
            <Sparkles size={18} className="text-violet-400" />
            <div>
              <h2 className="text-lg font-semibold text-white">Gerar Explicação</h2>
              <p className="text-xs text-slate-400 mt-0.5">
                A partir de: <span className="text-slate-300">{lessonName}</span>
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-white/10 transition-colors"
          >
            <X size={16} />
          </button>
        </div>

        {/* Body */}
        <div className="px-5 py-4">
          <label
            htmlFor="explain-focus"
            className="block text-sm font-medium text-slate-300 mb-1.5"
          >
            O que você quer explicado melhor?{' '}
            <span className="text-slate-500 font-normal">(opcional)</span>
          </label>
          <textarea
            id="explain-focus"
            value={focus}
            onChange={(e) => setFocus(e.target.value)}
            placeholder="Deixe em branco para explicar o conteúdo completo"
            rows={3}
            className="w-full bg-white/5 border border-white/10 rounded-xl px-3 py-2 text-sm text-white placeholder-slate-500 outline-none focus:border-violet-500/50 transition-colors resize-none"
            autoFocus
          />
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-3 px-5 py-3 border-t border-white/10">
          <button
            onClick={onClose}
            className="px-4 py-2 text-sm font-medium rounded-lg bg-white/5 border border-white/10 text-slate-400 hover:bg-white/10 hover:text-white transition-colors"
          >
            Cancelar
          </button>
          <button
            onClick={handleSubmit}
            className="px-5 py-2 text-sm font-semibold rounded-xl text-white
                       bg-linear-to-r from-violet-600 to-purple-600 hover:from-violet-500 hover:to-purple-500
                       transition-all duration-200 shadow-lg shadow-violet-500/20 flex items-center gap-2"
          >
            <Sparkles size={16} />
            Gerar Explicação
          </button>
        </div>
      </div>
    </div>
  )
}
