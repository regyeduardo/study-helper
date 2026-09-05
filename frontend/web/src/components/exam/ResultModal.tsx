import { useAppState } from '@/context/AppContext'
import MermaidRenderer from '@/components/output/MermaidRenderer'
import { marked } from 'marked'
import type { Question } from '@/types'
import { BarChart3, X, Check, XCircle, Frown, Trophy, Sparkles, BookOpen, Medal } from 'lucide-react'

interface ResultModalProps {
  onClose: () => void
}

export default function ResultModal({ onClose }: ResultModalProps) {
  const state = useAppState()
  const questions: Question[] = state.questionsData?.questions ?? []
  const letters = ['A', 'B', 'C', 'D', 'E']

  let correctCount = 0
  questions.forEach((q) => {
    if (state.userAnswers[q.id] === q.correta) correctCount++
  })

  const total = questions.length
  const percentage = total > 0 ? Math.round((correctCount / total) * 100) : 0

  let gradeIcon = <Frown size={48} className="text-red-400 mx-auto mb-2" />
  let gradeText = 'Estude novamente o conteúdo e tente outra vez.'
  let gradeColor = 'text-red-400'
  let barColor = 'bg-red-500'
  if (percentage >= 90) { gradeIcon = <Trophy size={48} className="text-emerald-400 mx-auto mb-2" />; gradeText = 'Excelente! Domínio completo do conteúdo.'; gradeColor = 'text-emerald-400'; barColor = 'bg-emerald-500' }
  else if (percentage >= 70) { gradeIcon = <Sparkles size={48} className="text-violet-400 mx-auto mb-2" />; gradeText = 'Muito bom! Precisa revisar alguns pontos.'; gradeColor = 'text-violet-400'; barColor = 'bg-violet-500' }
  else if (percentage >= 50) { gradeIcon = <BookOpen size={48} className="text-amber-400 mx-auto mb-2" />; gradeText = 'Bom, mas precisa estudar mais.'; gradeColor = 'text-amber-400'; barColor = 'bg-amber-500' }

  return (
    <div data-testid="result-modal" className="fixed inset-0 z-110 flex items-center justify-center bg-black/70 backdrop-blur-sm">
      <div className="bg-[#0d0d15] border border-white/10 rounded-2xl w-full max-w-2xl mx-4 max-h-[85vh] flex flex-col shadow-2xl">
        <div className="flex items-center justify-between px-6 py-4 border-b border-white/10">
          <h2 className="text-lg font-semibold text-white flex items-center gap-2">
            <BarChart3 size={20} className="text-violet-400" />
            Resultado da Prova
          </h2>
          <button data-testid="modal-close" onClick={onClose} className="p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-white/10 transition-colors">
            <X size={16} />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-6 space-y-4">
          {/* Score */}
          <div data-testid="result-score" className="bg-white/5 rounded-xl p-6 text-center border border-white/10">
            <div className="mb-2">{gradeIcon}</div>
            <h3 className={`text-2xl font-bold ${gradeColor}`}>{correctCount}/{total} corretas</h3>
            <div className="h-3 bg-white/10 rounded-full overflow-hidden max-w-xs mx-auto my-3">
              <div className={`h-full ${barColor} rounded-full transition-all duration-1000`} style={{ width: `${percentage}%` }} />
            </div>
            <p className="text-sm text-slate-400">{gradeText}</p>
          </div>

          {/* Per-question breakdown */}
          {questions.map((q, idx) => {
            const userAnswer = state.userAnswers[q.id]
            const isCorrect = userAnswer === q.correta
            return (
              <div
                key={q.id}
                data-testid={`result-question-${idx}`}
                className={`rounded-xl p-4 border ${
                  isCorrect ? 'bg-emerald-500/5 border-emerald-500/20' : 'bg-red-500/5 border-red-500/20'
                }`}
              >
                <div className="flex items-center justify-between mb-2">
                  <span className="font-semibold text-sm text-white flex items-center gap-1.5">
                    {isCorrect ? <Check size={16} className="text-emerald-400" /> : <XCircle size={16} className="text-red-400" />}
                    Questão {idx + 1}
                  </span>
                  <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${
                    isCorrect ? 'bg-emerald-600/30 text-emerald-300' : 'bg-red-600/30 text-red-300'
                  }`}>
                    {isCorrect ? 'Correta' : 'Incorreta'}
                  </span>
                </div>

                <div
                  className="text-sm text-slate-300 mb-2 prose prose-invert prose-sm max-w-none prose-p:mb-1"
                  dangerouslySetInnerHTML={{
                    __html: marked.parse(q.enunciado) as string,
                  }}
                />

                {q.diagrama && (
                  <div className="bg-white/5 rounded-lg p-3 mb-2">
                    <MermaidRenderer code={q.diagrama} />
                  </div>
                )}

                <div className="space-y-1 mb-2">
                  {letters.map((letter) => {
                    const altText = q.alternativas[letter]
                    if (!altText) return null
                    let cls = 'bg-white/5 border border-white/10'
                    if (letter === q.correta) cls = 'bg-emerald-500/10 border border-emerald-500/30'
                    else if (letter === userAnswer && userAnswer !== q.correta) cls = 'bg-red-500/10 border border-red-500/30'
                    return (
                      <div key={letter} className={`p-2 rounded-lg text-sm ${cls}`}>
                        <strong className="text-white">{letter})</strong>{' '}
                        <span className="text-slate-300">{altText}</span>
                        {letter === q.correta && <span className="float-right text-emerald-400 font-bold">✓</span>}
                        {letter === userAnswer && userAnswer !== q.correta && <span className="float-right text-red-400 font-bold">✗</span>}
                      </div>
                    )
                  })}
                </div>

                <div className="bg-white/5 rounded-lg p-3 text-xs text-slate-400">
                  <strong className="text-slate-300">💡 Explicação:</strong> {q.explicacao}
                </div>
              </div>
            )
          })}
        </div>

        <div className="flex justify-end px-6 py-4 border-t border-white/10">
          <button data-testid="result-close" onClick={onClose} className="px-4 py-2 text-sm font-medium rounded-lg bg-white/5 border border-white/10 text-slate-300 hover:bg-white/10 transition-colors">
            Fechar
          </button>
        </div>
      </div>
    </div>
  )
}
