import { useEffect, useState } from 'react'
import { Sparkles, X } from 'lucide-react'

export interface ExplainSelectionModalProps {
  excerpt: string
  sourceName: string
  onSubmit: (params: { excerpt: string; prompt: string }) => void
  onClose: () => void
}

export default function ExplainSelectionModal({
  excerpt,
  sourceName,
  onSubmit,
  onClose,
}: ExplainSelectionModalProps) {
  const [prompt, setPrompt] = useState('')

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [onClose])

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm">
      <div className="bg-[#0d0d15] border border-white/10 rounded-2xl w-full max-w-lg mx-4 shadow-2xl overflow-hidden">
        <div className="flex items-center justify-between px-5 py-4 border-b border-white/10">
          <div className="flex items-center gap-2">
            <Sparkles size={18} className="text-violet-400" />
            <div>
              <h2 className="text-lg font-semibold text-white">Gerar explicação</h2>
              <p className="text-xs text-slate-400 mt-0.5">
                A partir de: <span className="text-slate-300">{sourceName}</span>
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

        <div className="px-5 py-4 space-y-4">
          <div>
            <p className="text-xs font-medium text-slate-400 mb-1.5">Trecho selecionado</p>
            <blockquote
              data-testid="selection-excerpt"
              className="max-h-32 overflow-y-auto text-sm text-slate-300 bg-white/5 border-l-2 border-violet-500/60 rounded-r-lg px-3 py-2"
            >
              {excerpt}
            </blockquote>
          </div>

          <div>
            <label htmlFor="explain-prompt" className="block text-sm font-medium text-slate-300 mb-1.5">
              Seu prompt <span className="text-slate-500 font-normal">(opcional)</span>
            </label>
            <textarea
              id="explain-prompt"
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
              placeholder="Deixe em branco para usar o contexto de onde o trecho veio"
              rows={3}
              className="w-full bg-white/5 border border-white/10 rounded-xl px-3 py-2 text-sm text-white placeholder-slate-500 outline-none focus:border-violet-500/50 transition-colors resize-none"
            />
          </div>
        </div>

        <div className="flex justify-end gap-2 px-5 py-4 border-t border-white/10">
          <button
            onClick={onClose}
            className="px-4 py-2 rounded-xl text-sm text-slate-300 hover:bg-white/5 transition-colors"
          >
            Cancelar
          </button>
          <button
            data-testid="explain-selection-submit"
            onClick={() => onSubmit({ excerpt, prompt: prompt.trim() })}
            className="px-4 py-2 rounded-xl text-sm font-medium bg-violet-500 text-white hover:bg-violet-400 transition-colors"
          >
            Gerar
          </button>
        </div>
      </div>
    </div>
  )
}
