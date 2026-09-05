import { useState, useEffect, useRef } from 'react'
import MermaidRenderer from '@/components/output/MermaidRenderer'
import { useAppState, useAppDispatch } from '@/context/AppContext'
import { api } from '@/api/client'
import { getTitleFromMarkdown } from '@/lib/utils'
import { marked } from 'marked'
import type { QuestionsResponse, Question } from '@/types'
import { ClipboardList, Check, X, ArrowLeft, ArrowRight, Eye } from 'lucide-react'

interface ExamModalProps {
  onClose: () => void
  onFinish: () => void
  /** The markdown content to generate questions from.
   *  Passed explicitly to avoid race conditions with state.generatedMarkdown. */
  markdown: string
  /** File ID to persist questions to the database after generation. */
  fileId?: string | null
  /** Optional pre-generated questions to display instead of generating new ones.
   *  When provided, skips the internal question-generation API call. */
  initialQuestions?: QuestionsResponse | null
}

export default function ExamModal({ onClose, onFinish, markdown, fileId, initialQuestions }: ExamModalProps) {
  const state = useAppState()
  const dispatch = useAppDispatch()
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const generatedRef = useRef(false)

  useEffect(() => {
    // Prevent double generation in StrictMode (dev) or if questions already exist
    if (generatedRef.current) return
    if (state.questionsData?.questions?.length) return
    generatedRef.current = true

    if (initialQuestions?.questions?.length) {
      dispatch({ type: 'SET_QUESTIONS', payload: initialQuestions })
      return
    }

    loadQuestions()
  }, [])

  const loadQuestions = async () => {
    setLoading(true)
    setError(null)
    try {
      const title = getTitleFromMarkdown(markdown) || 'Conteúdo'
      const data = await api.generateQuestions(markdown, title, fileId ?? undefined)
      dispatch({ type: 'SET_QUESTIONS', payload: data })
    } catch (e: unknown) {
      setError((e as Error).message)
    } finally {
      setLoading(false)
    }
  }

  const questions = state.questionsData?.questions ?? []
  const total = questions.length
  const current = questions[state.currentQuestionIndex]
  const letters = ['A', 'B', 'C', 'D', 'E']

  const handleAnswer = (questionId: number, letter: string) => {
    dispatch({ type: 'SET_USER_ANSWER', payload: { questionId, answer: letter } })
  }

  return (
    <div data-testid="exam-modal" className="fixed inset-0 z-110 flex items-center justify-center bg-black/70 backdrop-blur-sm">
      <div className="bg-[#0d0d15] border border-white/10 rounded-2xl w-full max-w-2xl mx-4 max-h-[85vh] flex flex-col shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-white/10">
          <h2 className="text-lg font-semibold text-white flex items-center gap-2">
            <ClipboardList size={20} className="text-violet-400" />
            Prova de Múltipla Escolha
          </h2>
          <button data-testid="modal-close" onClick={onClose} className="p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-white/10 transition-colors">
            <X size={16} />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto p-6">
          {loading && (
            <div className="text-center py-8">
              <div className="w-8 h-8 border-4 border-violet-500/30 border-t-violet-400 rounded-full animate-spin mx-auto mb-3" />
              <p className="text-sm text-slate-400">Gerando questões... Aguarde.</p>
            </div>
          )}

          {error && (
            <div className="bg-red-500/10 border border-red-500/30 rounded-xl p-4 text-sm text-red-300">
              Erro: {error}
            </div>
          )}

          {!loading && !error && (!questions.length || !current) && (
            <div className="text-center py-8 text-slate-500">Nenhuma questão disponível.</div>
          )}

          {!loading && !error && current && (
            <div className="space-y-4">
              {/* Progress */}
              <div className="bg-white/5 rounded-xl p-3">
                <div className="flex justify-between text-xs text-slate-400 mb-1">
                  <span data-testid="exam-progress">Questão {state.currentQuestionIndex + 1} de {total}</span>
                  <span>{Math.round(((state.currentQuestionIndex + 1) / total) * 100)}%</span>
                </div>
                <div className="h-1.5 bg-white/10 rounded-full overflow-hidden">
                  <div
                    className="h-full bg-linear-to-r from-violet-500 to-cyan-500 rounded-full transition-all duration-300"
                    style={{ width: `${((state.currentQuestionIndex + 1) / total) * 100}%` }}
                  />
                </div>
              </div>

              {/* Question */}
              <div className="bg-white/5 rounded-xl p-4 border border-white/10">
                <div className="flex items-center gap-2 mb-3">
                  <span className="text-[11px] font-semibold bg-violet-600 text-white px-2.5 py-0.5 rounded-full">
                    Questão {state.currentQuestionIndex + 1}
                  </span>
                </div>
                <div
                  data-testid="exam-question-text"
                  className="text-sm text-slate-200 leading-relaxed mb-3
                    prose prose-invert prose-sm max-w-none
                    prose-p:mb-2 prose-code:text-cyan-300 prose-code:bg-white/5 prose-code:px-1 prose-code:rounded"
                  dangerouslySetInnerHTML={{
                    __html: marked.parse(current.enunciado) as string,
                  }}
                />

                {/* Diagram */}
                {current.diagrama && (
                  <div className="bg-white/5 rounded-lg p-3 mb-3">
                    <MermaidRenderer code={current.diagrama} />
                  </div>
                )}

                {/* Alternatives */}
                <div className="space-y-1.5">
                  {letters.map((letter) => {
                    const altText = current.alternativas[letter]
                    if (!altText) return null
                    const selected = state.userAnswers[current.id] === letter
                    return (
                      <button
                        key={letter}
                        data-testid={`exam-option-${letter}`}
                        onClick={() => handleAnswer(current.id, letter)}
                        className={`w-full text-left p-2.5 rounded-lg border text-sm transition-all duration-150 ${
                          selected
                            ? 'border-violet-500 bg-violet-500/15'
                            : 'border-white/10 bg-white/5 hover:border-violet-400/50'
                        }`}
                      >
                        <strong className="text-white">{letter})</strong>{' '}
                        <span className="text-slate-300">{altText}</span>
                      </button>
                    )
                  })}
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between px-6 py-4 border-t border-white/10">
          <button
            data-testid="exam-prev"
            onClick={() => dispatch({ type: 'SET_CURRENT_QUESTION_INDEX', payload: state.currentQuestionIndex - 1 })}
            disabled={state.currentQuestionIndex === 0}
            className="flex items-center gap-1.5 px-4 py-2 text-sm font-medium rounded-lg bg-white/5 border border-white/10 text-slate-300 hover:bg-white/10 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
          >
            <ArrowLeft size={16} /> Anterior
          </button>

          <div className="flex gap-2">
            <button
              data-testid="exam-gabarito"
              onClick={onFinish}
              className="flex items-center gap-1.5 px-4 py-2 text-sm font-medium rounded-lg bg-amber-600/20 border border-amber-500/30 text-amber-300 hover:bg-amber-600/30 transition-colors"
              title="Ver respostas corretas sem precisar responder todas"
            >
              <Eye size={16} /> Ver Gabarito
            </button>
            {state.currentQuestionIndex < total - 1 ? (
              <button
                data-testid="exam-next"
                onClick={() => dispatch({ type: 'SET_CURRENT_QUESTION_INDEX', payload: state.currentQuestionIndex + 1 })}
                className="flex items-center gap-1.5 px-4 py-2 text-sm font-medium rounded-lg bg-violet-600 text-white hover:bg-violet-500 transition-colors"
              >
                Próxima <ArrowRight size={16} />
              </button>
            ) : (
              <button
                data-testid="exam-finish"
                onClick={onFinish}
                className="flex items-center gap-1.5 px-4 py-2 text-sm font-medium rounded-lg bg-emerald-600 text-white hover:bg-emerald-500 transition-colors"
              >
                <Check size={16} /> Finalizar
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
