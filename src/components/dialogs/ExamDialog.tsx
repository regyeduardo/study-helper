import { marked } from 'marked'
import { type MouseEvent, useEffect, useMemo, useRef, useState } from 'react'

import type { Attempt, Certainty, Question, StoredQuestion, UserAnswer } from '@/types/domain'
import { MoreOptions } from '@/components/dialogs/FromNoteFields'
import { useGoToNew } from '@/components/dialogs/go-to-new'
import { ModelPick, useModelChoice } from '@/components/dialogs/ModelPick'
import { Dialog } from '@/components/ui/Dialog'
import { Icon } from '@/components/ui/Icon'
import { Popover } from '@/components/ui/Popover'
import { targetFor } from '@/lib/ai/config'
import { isNote } from '@/lib/family'
import { CERTAINTY_LABELS, examStats, givenAnswerText, isAnswered, LETTERS, LEVEL_LABELS, questionFromStored, questionType, rightAnswerText, shuffleExam, statementLines, storedAnswer, summarizeExam } from '@/lib/exam'
import { clearExamDraft, examDraftKey, loadExamDraft, peekExamDraft, saveExamDraft, selectionScope, stoppedAt } from '@/lib/exam-draft'
import { type Diagnosis, diagnoseMistakes, gapExcerpt, type MissedQuestion } from '@/lib/generation/diagnosis'
import { paths } from '@/lib/paths'
import { useJobsStore } from '@/stores/jobs'
import { useLibraryStore } from '@/stores/library'
import { useUiStore } from '@/stores/ui'
import '@/styles/exam-bar.css'

const KIND_LABEL: Record<string, string> = {
  unica: 'Múltipla escolha',
  multipla: 'Marque todas',
  certo_errado: 'Certo ou errado',
  ordenar: 'Ordenar',
  associar: 'Associar',
  lacuna: 'Lacuna',
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return url
  }
}

function Markdown({ text }: { text: string }) {
  return <span dangerouslySetInnerHTML={{ __html: marked.parseInline(text, { async: false }) as string }} />
}

function RichText({ text }: { text: string }) {
  return <div className="rich" dangerouslySetInnerHTML={{ __html: marked.parse(statementLines(text), { async: false, gfm: true, breaks: true }) as string }} />
}

function RightAnswer({ text }: { text: string }) {
  return (
    <span className="right-answer">
      certo: <Markdown text={text} />
    </span>
  )
}

function Diagram({ code }: { code: string }) {
  const box = useRef<HTMLDivElement>(null)
  useEffect(() => {
    let alive = true
    void import('mermaid').then(async module => {
      const mermaid = module.default
      mermaid.initialize({ startOnLoad: false, securityLevel: 'strict' })
      try {
        const { svg } = await mermaid.render(`exam-${Math.random().toString(36).slice(2)}`, code)
        if (alive && box.current) box.current.innerHTML = svg
      } catch {
        if (alive && box.current) box.current.textContent = ''
      }
    })
    return () => {
      alive = false
    }
  }, [code])
  return <div ref={box} className="pdf-diagrama" style={{ overflow: 'auto' }} />
}

function Answer({ question, answer, onAnswer, revealed }: { question: Question; answer: UserAnswer | undefined; onAnswer(answer: UserAnswer): void; revealed: boolean }) {
  const type = questionType(question)
  if (type === 'unica' || type === 'multipla') {
    const many = type === 'multipla'
    const marked = many ? ((answer as string[] | undefined) ?? []) : answer
    const right = many ? (question.corretas ?? []) : [question.correta]
    return (
      <div className="ans">
        {many && <span className="faint" style={{ fontSize: 12 }}>Marque todas as corretas — pode haver mais de uma.</span>}
        {LETTERS.filter(letter => question.alternativas[letter]).map(letter => {
          const on = many ? (marked as string[]).includes(letter) : marked === letter
          const tone = revealed ? (right.includes(letter) ? 'right' : on ? 'wrong' : '') : ''
          return (
            <button
              key={letter}
              className={tone}
              aria-pressed={on}
              disabled={revealed}
              onClick={() => onAnswer(many ? (on ? (marked as string[]).filter(item => item !== letter) : [...(marked as string[]), letter].sort()) : letter)}
            >
              <span className={`check ${on ? 'on' : ''}`} style={many ? undefined : { borderRadius: '50%' }}>
                {on && <Icon name="check" />}
              </span>
              <span>
                <b>{letter})</b> <Markdown text={question.alternativas[letter]} />
              </span>
            </button>
          )
        })}
      </div>
    )
  }
  if (type === 'certo_errado') {
    const right = question.certo ? 'certo' : 'errado'
    return (
      <div className="ans" style={{ gridTemplateColumns: '1fr 1fr' }}>
        {['certo', 'errado'].map(value => (
          <button key={value} aria-pressed={answer === value} disabled={revealed} className={revealed ? (value === right ? 'right' : answer === value ? 'wrong' : '') : ''} onClick={() => onAnswer(value)} style={{ justifyContent: 'center' }}>
            {value === 'certo' ? 'Certo' : 'Errado'}
          </button>
        ))}
      </div>
    )
  }
  if (type === 'ordenar') {
    const order = (answer as string[] | undefined) ?? question.ordemInicial ?? question.passos ?? []
    const move = (from: number, to: number) => {
      if (to < 0 || to >= order.length) return
      const next = [...order]
      const [step] = next.splice(from, 1)
      next.splice(to, 0, step)
      onAnswer(next)
    }
    return (
      <div className="order">
        {order.map((step, index) => (
          <div key={step} className={revealed ? (question.passos?.[index] === step ? 'right' : 'wrong') : ''}>
            <span className="faint" style={{ fontVariantNumeric: 'tabular-nums' }}>
              {index + 1}
            </span>
            <span>
              <Markdown text={step} />
            </span>
            {revealed && question.passos?.[index] !== step && <span className="right-answer">posição certa: {(question.passos?.indexOf(step) ?? -1) + 1}</span>}
            {!revealed && (
              <>
                <button className="ibtn" style={{ width: 24, height: 24 }} onClick={() => move(index, index - 1)} aria-label={`Subir o passo ${index + 1}`} disabled={index === 0}>
                  <Icon name="up" />
                </button>
                <button className="ibtn" style={{ width: 24, height: 24 }} onClick={() => move(index, index + 1)} aria-label={`Descer o passo ${index + 1}`} disabled={index === order.length - 1}>
                  <Icon name="down" />
                </button>
              </>
            )}
          </div>
        ))}
        {!answer && !revealed && (
          <button className="btn quiet" onClick={() => onAnswer([...order])}>
            Essa já é a ordem que eu acho certa
          </button>
        )}
      </div>
    )
  }
  if (type === 'associar') {
    const pairs = question.pares ?? []
    const options = question.direitas ?? pairs.map(pair => pair.direita)
    const chosen = (answer as string[] | undefined) ?? pairs.map(() => '')
    return (
      <div style={{ display: 'grid', gap: 6 }}>
        {pairs.map((pair, index) => (
          <label key={pair.esquerda} className={`match ${revealed ? (chosen[index] === pair.direita ? 'right' : 'wrong') : ''}`}>
            <span>
              <Markdown text={pair.esquerda} />
            </span>
            <select className="input" value={chosen[index]} disabled={revealed} onChange={event => onAnswer(chosen.map((value, position) => (position === index ? event.target.value : value)))}>
              <option value="">Escolha…</option>
              {options.map(option => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </select>
            {revealed && chosen[index] !== pair.direita && <RightAnswer text={pair.direita} />}
          </label>
        ))}
      </div>
    )
  }
  const gaps = question.lacunas ?? []
  const chosen = (answer as string[] | undefined) ?? gaps.map(() => '')
  const parts = question.enunciado.split(/\[\[(\d+)\]\]/)
  return (
    <div style={{ fontSize: 14, lineHeight: 2.2 }}>
      {parts.map((part, position) => {
        if (position % 2 === 0) return <Markdown key={position} text={part} />
        const index = Number(part) - 1
        const gap = gaps[index]
        if (!gap) return null
        return (
          <span key={position} className="gap">
            <select aria-label={`Lacuna ${part}`} className={`input ${revealed ? (chosen[index] === gap.correta ? 'right' : 'wrong') : ''}`} style={{ width: 'auto', display: 'inline-block', margin: '0 4px' }} disabled={revealed} value={chosen[index]} onChange={event => onAnswer(chosen.map((value, place) => (place === index ? event.target.value : value)))}>
              <option value="">[{part}] escolha…</option>
              {gap.opcoes.map(option => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </select>
            {revealed && chosen[index] !== gap.correta && <RightAnswer text={gap.correta} />}
          </span>
        )
      })}
    </div>
  )
}

interface DiagnosisTarget {
  fileId: string | null
  folderId: string | null
}

interface ExamRunProps {
  title: string
  questions: StoredQuestion[]
  sourceOf?: (storedId: string) => string | undefined
  diagnosisTarget?: DiagnosisTarget
  onRegenerate?: () => void
  /** Said above the questions (Questões da web that did not come). */
  notice?: string
  onRecord?: (fileId: string, fields: Omit<Attempt, 'id' | 'createdAt' | 'deviceId'>) => void | Promise<void>
  /** Where the exam in progress is kept (a note, a folder or a selection): closing the window keeps it. Absent: nothing is kept. */
  draftScope?: string
}

function DiagnosisView({ title, missed, target, onBack }: { title: string; missed: MissedQuestion[]; target: DiagnosisTarget; onBack(): void }) {
  const ui = useUiStore()
  const goToNew = useGoToNew()
  const settings = useLibraryStore(state => state.index.settings)
  const explainGaps = useJobsStore(state => state.explainGaps)
  // who writes the explanations, chosen before they start
  const choice = useModelChoice('explicacao')
  const [state, setState] = useState<{ kind: 'thinking' } | { kind: 'error'; message: string } | { kind: 'ready'; diagnosis: Diagnosis }>({ kind: 'thinking' })
  const [single, setSingle] = useState(true)
  const [busy, setBusy] = useState(false)
  const controller = useRef<AbortController | null>(null)

  const run = () => {
    controller.current?.abort()
    const current = new AbortController()
    controller.current = current
    setState({ kind: 'thinking' })
    diagnoseMistakes(missed, targetFor(settings, 'prova'), current.signal)
      .then(diagnosis => {
        setSingle(diagnosis.single)
        setState({ kind: 'ready', diagnosis })
      })
      .catch(failure => !current.signal.aborted && setState({ kind: 'error', message: failure instanceof Error ? failure.message : 'O diagnóstico não saiu.' }))
  }

  useEffect(() => {
    run()
    return () => controller.current?.abort()
  }, [])

  const generate = async (diagnosis: Diagnosis) => {
    setBusy(true)
    const notes = single ? [{ title: `O que faltou em ${title}`, excerpt: gapExcerpt(diagnosis.gaps, missed) }] : diagnosis.gaps.map(gap => ({ title: gap.title, excerpt: gapExcerpt([gap], missed) }))
    const ids = await explainGaps(target, notes, choice.model || null)
    ui.close()
    // with the note open she stays there, and the notice opens the explanation
    if (ids[0]) goToNew(paths.file(ids[0]), ids.length > 1 ? 'Gerando as explicações' : 'Gerando a explicação')
  }

  return (
    <Dialog
      title={`Diagnóstico · ${title}`}
      size="wide"
      onClose={ui.close}
      footer={
        <>
          <button className="btn quiet" onClick={onBack} disabled={busy}>
            Voltar ao resultado
          </button>
          {state.kind === 'error' && (
            <button className="btn" onClick={run}>
              Tentar de novo
            </button>
          )}
          <button className="btn primary" disabled={state.kind !== 'ready' || busy || !choice.ready} onClick={() => state.kind === 'ready' && void generate(state.diagnosis)}>
            <Icon name="bulb" />
            {busy ? 'Criando…' : 'Gerar explicações'}
          </button>
        </>
      }
    >
      <div className="db">
        {state.kind === 'thinking' && (
          <div className="progress" role="status">
            <div className="step now">
              <Icon name="sync" className="spinning" />
              Lendo o que você errou para achar o que faltou aprender…
            </div>
          </div>
        )}
        {state.kind === 'error' && (
          <div className="banner" role="alert">
            <Icon name="warn" />
            <span>{state.message}</span>
          </div>
        )}
        {state.kind === 'ready' && (
          <>
            <span className="muted" style={{ fontSize: 13 }}>
              {state.diagnosis.gaps.length === 1 ? 'Faltou aprender um tema:' : `Faltou aprender ${state.diagnosis.gaps.length} temas:`}
            </span>
            <ul className="gaps">
              {state.diagnosis.gaps.map(gap => (
                <li key={gap.title}>
                  <b>{gap.title}</b>
                  {gap.missing && <span>{gap.missing}</span>}
                  {gap.questions.length > 0 && <small className="faint">{gap.questions.length === 1 ? 'questão' : 'questões'} {gap.questions.join(', ')}</small>}
                </li>
              ))}
            </ul>
            <div className="opts" role="radiogroup" aria-label="Como gerar as explicações">
              <button className="opt" role="radio" aria-checked={single} onClick={() => setSingle(true)}>
                <span className="radio" />
                <span>
                  <b>Uma nota com tudo{state.diagnosis.single ? ' (sugerido)' : ''}</b>
                  <span>Uma explicação só, cobrindo todos os temas.</span>
                </span>
              </button>
              <button className="opt" role="radio" aria-checked={!single} onClick={() => setSingle(false)}>
                <span className="radio" />
                <span>
                  <b>
                    Uma nota por tema ({state.diagnosis.gaps.length}){!state.diagnosis.single ? ' (sugerido)' : ''}
                  </b>
                  <span>Uma explicação para cada tema, geradas em lote.</span>
                </span>
              </button>
            </div>
            <ModelPick choice={choice} />
          </>
        )}
      </div>
    </Dialog>
  )
}

export function ExamRun({ title, questions, sourceOf, diagnosisTarget, onRegenerate, notice, onRecord, draftScope }: ExamRunProps) {
  const ui = useUiStore()
  const accountId = useLibraryStore(state => state.accountId)
  const libraryRecord = useLibraryStore(state => state.recordAttempt)
  const recordAttempt = onRecord ?? libraryRecord
  const oneAtATimeSetting = useLibraryStore(state => state.index.settings.examOneAtATime)
  const draftKey = draftScope ? examDraftKey(accountId, draftScope) : null
  // what was kept of this exam, read once: it opens where the person left it
  const [restored, setRestored] = useState(() => (draftKey ? loadExamDraft(draftKey, questions) : null))
  const [seed, setSeed] = useState(0)
  const exam = useMemo(() => restored?.exam ?? shuffleExam(questions.map(questionFromStored)), [questions, seed, restored])
  const [answers, setAnswers] = useState<Record<number, UserAnswer>>(restored?.answers ?? {})
  const [certainty, setCertainty] = useState<Record<number, Certainty>>(restored?.certainty ?? {})
  const [done, setDone] = useState(false)
  const [current, setCurrent] = useState(restored?.current ?? 0)
  const [oneAtATime, setOneAtATime] = useState(restored?.oneAtATime ?? oneAtATimeSetting)
  // "Você parou na questão 7": there until the person goes on
  const [resumed, setResumed] = useState(restored !== null)
  const [diagnosing, setDiagnosing] = useState(false)
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)
  const leaving = useRef(false)
  const body = useRef<HTMLDivElement>(null)
  const summary = useMemo(() => summarizeExam(exam, answers, certainty), [exam, answers, certainty])
  const stats = useMemo(() => examStats(exam, answers, summary.scores), [exam, answers, summary])
  const answered = stats.done
  const paged = oneAtATime && !done
  const last = paged && current === exam.length - 1
  const shown = paged ? exam.slice(current, current + 1) : exam

  useEffect(() => {
    if (!draftKey || done || leaving.current) return
    const started = answered > 0 || Object.keys(certainty).length > 0 || current > 0
    if (started) saveExamDraft(draftKey, { exam, answers, certainty, current, oneAtATime }, questions)
    else clearExamDraft(draftKey)
  }, [draftKey, done, exam, answers, certainty, current, oneAtATime])

  // the bar stays, the question is what scrolls: a new question starts at the top
  useEffect(() => {
    if (body.current) body.current.scrollTop = 0
  }, [current])

  // in the list, the window opens at the question where the person stopped
  useEffect(() => {
    if (restored && !restored.oneAtATime) body.current?.querySelector<HTMLElement>(`[data-q="${stoppedAt(restored)}"]`)?.scrollIntoView?.({ block: 'center' })
  }, [])

  const goTo = (to: (value: number) => number) => (setResumed(false), setCurrent(to))

  const finish = async () => {
    if (draftKey) clearExamDraft(draftKey)
    setDone(true)
    const byFile = new Map<string, Question[]>()
    for (const question of exam) {
      const fileId = sourceOf?.(question.storedId!) ?? ''
      if (!fileId || !isAnswered(answers[question.id])) continue
      byFile.set(fileId, [...(byFile.get(fileId) ?? []), question])
    }
    for (const [fileId, list] of byFile) {
      await recordAttempt(fileId, {
        total: list.length,
        correct: list.reduce((sum, question) => sum + summary.scores[question.id], 0),
        answers: list.map(question => ({ questionId: question.storedId!, answer: storedAnswer(question, answers[question.id]), score: summary.scores[question.id], certainty: certainty[question.id] ?? null })),
      })
    }
  }

  /** Começar de novo and Refazer: nothing kept, the questions drawn again. */
  const restart = () => {
    if (draftKey) clearExamDraft(draftKey)
    setRestored(null)
    setAnswers({})
    setCertainty({})
    setDone(false)
    setCurrent(0)
    setOneAtATime(oneAtATimeSetting)
    setResumed(false)
    setSeed(value => value + 1)
  }

  const leave = () => {
    leaving.current = true
    if (draftKey) clearExamDraft(draftKey)
    ui.close()
  }

  // the exam in progress is left behind only when the new questions are asked for: "Voltar à prova" finds it as it was
  const regenerate = () => onRegenerate?.()

  const missed: MissedQuestion[] = exam
    .filter(question => isAnswered(answers[question.id]) && summary.scores[question.id] < 1)
    .map(question => ({ number: exam.indexOf(question) + 1, statement: question.enunciado, right: rightAnswerText(question), given: givenAnswerText(question, answers[question.id]), explanation: question.explicacao }))

  if (diagnosing && diagnosisTarget) return <DiagnosisView title={title} missed={missed} target={diagnosisTarget} onBack={() => setDiagnosing(false)} />

  const openMenu = (event: MouseEvent<HTMLButtonElement>) => {
    const box = event.currentTarget.getBoundingClientRect()
    setMenu({ x: box.right - 250, y: box.bottom + 4 })
  }
  const submitHint = answered === 0 ? 'Responda pelo menos uma questão' : undefined
  const submit = (place: 'head' | 'bar') => (
    <button key={place} className={place === 'bar' ? 'btn primary' : 'btn exam-submit'} disabled={answered === 0} title={submitHint} onClick={() => void finish()}>
      Entregar prova
    </button>
  )

  return (
    <>
      <Dialog
        title={`${done ? 'Resultado' : 'Prova'} · ${title}`}
        size="wide"
        onClose={() => (menu ? setMenu(null) : ui.close())}
        actions={
          !done && (
            <span className="exam-head">
              {submit('head')}
              <button className="btn exam-more" aria-label="Mais" aria-haspopup="menu" aria-expanded={menu !== null} onClick={openMenu}>
                <span className="exam-more-label">Mais</span>
                <Icon name="dots" />
              </button>
            </span>
          )
        }
        footer={
          done ? (
            <>
              {diagnosisTarget && missed.length > 0 && (
                <button className="btn" onClick={() => setDiagnosing(true)}>
                  <Icon name="bulb" />
                  Ver o que faltou aprender
                </button>
              )}
              <button className="btn" onClick={restart}>
                Refazer
              </button>
              <button className="btn primary" onClick={ui.close}>
                Concluir
              </button>
            </>
          ) : (
            <div className={`exam-bar${paged ? '' : ' list'}`} role="group" aria-label="Ações da prova">
              {paged ? (
                <>
                  <button className="btn" disabled={current === 0} onClick={() => goTo(value => value - 1)}>
                    <Icon name="back" />
                    Anterior
                  </button>
                  <div className="exam-count">
                    <b>{`${current + 1} de ${exam.length}`}</b>
                    <span>{`${answered} respondida${answered === 1 ? '' : 's'}`}</span>
                  </div>
                  {last ? (
                    submit('bar')
                  ) : (
                    <button className="btn primary" onClick={() => goTo(value => value + 1)}>
                      Próxima
                      <Icon name="fwd" />
                    </button>
                  )}
                </>
              ) : (
                <>
                  <div className="exam-count">
                    <span>{`${answered} de ${exam.length} respondidas`}</span>
                  </div>
                  {submit('bar')}
                </>
              )}
            </div>
          )
        }
      >
        <div className="db" ref={body}>
          {resumed && restored && !done && (
            <div className="banner info exam-resume" role="status">
              <Icon name="info" />
              <span>{`Você parou na questão ${stoppedAt(restored) + 1} de ${exam.length}`}</span>
              <button className="btn" onClick={restart}>
                Começar de novo
              </button>
            </div>
          )}
          {notice && !done && (
            <div className="banner" role="status">
              <Icon name="warn" />
              <span>{notice}</span>
            </div>
          )}
          {done ? (
            <div className="result-head">
              <div className="score">{stats.percent}%</div>
              <div>
                <b>
                  {stats.done} feita{stats.done === 1 ? '' : 's'}: {stats.right} certa{stats.right === 1 ? '' : 's'}
                  {stats.partial ? `, ${stats.partial} parcia${stats.partial === 1 ? 'l' : 'is'}` : ''}, {stats.wrong} errada{stats.wrong === 1 ? '' : 's'}
                </b>
                {stats.blank > 0 && (
                  <div className="muted" style={{ fontSize: 13 }}>
                    {stats.blank} sem fazer: não contam na nota.
                  </div>
                )}
                · pontos com certeza: {summary.certaintyPoints > 0 ? '+' : ''}
                {summary.certaintyPoints} de {summary.maxCertaintyPoints}
                <div className="muted" style={{ fontSize: 13 }}>
                  Errar com certeza alta tira mais pontos (0 / −2 / −6).
                  {summary.overconfident.length ? ` ${summary.overconfident.length} erro(s) com certeza alta: revise esses primeiro.` : ''}
                </div>
              </div>
            </div>
          ) : (
            <span className="faint" style={{ fontSize: 12.5 }}>
              {exam.length} questões. Marcar a certeza é opcional: sem marcar, conta como baixa.
            </span>
          )}
          {shown.map(question => {
            const index = exam.indexOf(question)
            const score = summary.scores[question.id]
            const yourWrong = done && questionType(question) === 'unica' && typeof answers[question.id] === 'string' && answers[question.id] !== question.correta ? question.explicacao_das_erradas?.[answers[question.id] as string] : undefined
            return (
              <div key={question.id} className="q" data-q={index}>
                <div className="qh">
                  <b>{index + 1}</b>
                  {questionType(question) === 'lacuna' ? <p>Complete as lacunas.</p> : <RichText text={question.enunciado} />}
                </div>
                <div className="qk">
                  {KIND_LABEL[questionType(question)]}
                  {done && question.nivel ? ` · nível: ${LEVEL_LABELS[question.nivel]}` : ''}
                  {done ? ` · certeza: ${CERTAINTY_LABELS[certainty[question.id] ?? 1].toLowerCase()}` : ''}
                </div>
                {question.fonte && (
                  <div className="faint" style={{ fontSize: 12.5 }}>
                    Questão da web:{' '}
                    <a href={question.fonte} target="_blank" rel="noreferrer">
                      {hostOf(question.fonte)}
                    </a>
                  </div>
                )}
                {question.diagrama && <Diagram code={question.diagrama} />}
                <Answer question={question} answer={answers[question.id]} revealed={done} onAnswer={value => (setResumed(false), setAnswers(state => ({ ...state, [question.id]: value })))} />
                {!done ? (
                  <div className="cert">
                    Certeza:
                    {([1, 2, 3] as Certainty[]).map(level => (
                      <button key={level} className="chip" aria-pressed={certainty[question.id] === level} onClick={() => (setResumed(false), setCertainty(state => ({ ...state, [question.id]: level })))}>
                        {CERTAINTY_LABELS[level]}
                      </button>
                    ))}
                  </div>
                ) : (
                  <>
                    <div style={{ fontSize: 13, color: score === 1 ? 'var(--ok)' : score > 0 ? 'var(--warn)' : 'var(--bad)' }}>{score === 1 ? 'Certa' : score > 0 ? 'Parcialmente certa' : isAnswered(answers[question.id]) ? 'Errada' : 'Sem resposta'}</div>
                    {yourWrong && (
                      <div className="expl bad">
                        <b>Por que a sua está errada:</b> <Markdown text={yourWrong} />
                      </div>
                    )}
                    <div className={`expl ${score === 1 ? 'ok' : ''}`}>
                      <RichText text={question.explicacao} />
                    </div>
                  </>
                )}
              </div>
            )
          })}
        </div>
      </Dialog>
      {menu && (
        <Popover x={menu.x} y={menu.y} onClose={() => setMenu(null)} label="Mais">
          <button className="mi exam-menu-submit" role="menuitem" disabled={answered === 0} onClick={() => (setMenu(null), void finish())}>
            <span className="mi-text">
              <b>Entregar prova</b>
              <small>{`${answered} de ${exam.length} respondidas`}</small>
            </span>
          </button>
          <button className="mi" role="menuitem" onClick={() => (setMenu(null), leave())}>
            <span className="mi-text">
              <b>Sair sem salvar</b>
              <small>fecha sem guardar</small>
            </span>
          </button>
          {onRegenerate && (
            <button className="mi" role="menuitem" onClick={() => (setMenu(null), regenerate())}>
              <span className="mi-text">
                <b>Gerar outras questões</b>
                <small>cria uma prova nova</small>
              </span>
            </button>
          )}
        </Popover>
      )}
    </>
  )
}

function Generating({ title, onCancel }: { title: string; onCancel(): void }) {
  return (
    <Dialog title={`Prova · ${title}`} size="narrow" onClose={onCancel}>
      <div className="db" role="status">
        <div className="progress">
          <div className="step now">
            <Icon name="sync" className="spinning" />
            Escrevendo e conferindo as questões (leva de 30 s a 2 min)…
          </div>
        </div>
        <span className="faint" style={{ fontSize: 12 }}>
          Dá para fechar: a prova fica salva no arquivo quando ficar pronta.
        </span>
      </div>
    </Dialog>
  )
}

export function ExamDialog({ fileId }: { fileId: string }) {
  const ui = useUiStore()
  const meta = useLibraryStore(state => state.files.find(file => file.id === fileId))
  const opened = useLibraryStore(state => state.opened[fileId])
  const openFile = useLibraryStore(state => state.openFile)
  const createQuestions = useJobsStore(state => state.createQuestions)
  const accountId = useLibraryStore(state => state.accountId)
  const choice = useModelChoice('prova')
  const [state, setState] = useState<'loading' | 'choose' | 'generating' | 'ready' | 'error'>('loading')
  const [error, setError] = useState('')
  const [webNote, setWebNote] = useState('')
  // "Gerar outras questões": the exam is there to go back to
  const [again, setAgain] = useState(false)
  const [instruction, setInstruction] = useState('')

  const generate = async (wrong?: Question[]) => {
    setState('generating')
    // the exam left half way is of the old questions
    clearExamDraft(examDraftKey(accountId, `file:${fileId}`))
    try {
      const { web } = await createQuestions(fileId, wrong?.map(question => ({ enunciado: question.enunciado, explicacao: question.explicacao })), choice.model, instruction)
      setWebNote(web.found ? '' : web.note)
      setState('ready')
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'A prova não saiu.')
      setState('error')
    }
  }

  useEffect(() => {
    void openFile(fileId).then(file => {
      setState(file.sidecar.questions.length ? 'ready' : 'choose')
    })
  }, [fileId])

  if (!meta) return null
  if (state === 'loading' || state === 'generating') return <Generating title={meta.name} onCancel={ui.close} />
  if (state === 'choose')
    return (
      <Dialog
        title={`${again ? 'Gerar outras questões' : 'Prova'} · ${meta.name}`}
        size="narrow"
        onClose={ui.close}
        footer={
          again ? (
            <>
              <button className="btn quiet" onClick={() => (setAgain(false), setState('ready'))}>
                Voltar à prova
              </button>
              <button className="btn primary" disabled={!choice.ready} onClick={() => void generate()}>
                Gerar outras questões
              </button>
            </>
          ) : (
            <button className="btn primary" disabled={!choice.ready} onClick={() => void generate()}>
              Gerar a prova
            </button>
          )
        }
      >
        <div className="db">
          {again && (
            <p className="muted" style={{ marginTop: 0 }}>
              Uma prova nova sai desta nota. A de agora é deixada para trás.
            </p>
          )}
          <ModelPick choice={choice} />
          <MoreOptions key={String(again)} instruction={instruction} onInstruction={setInstruction} placeholder="Ex.: só questões de cálculo, mais difíceis" open={again} />
        </div>
      </Dialog>
    )
  if (state === 'error')
    return (
      <Dialog title={`Prova · ${meta.name}`} size="narrow" onClose={ui.close} footer={<button className="btn primary" onClick={() => void generate()}>Tentar de novo</button>}>
        <div className="db">
          <div className="banner" role="alert">
            <Icon name="warn" />
            <span>{error}</span>
          </div>
        </div>
      </Dialog>
    )
  const questions = opened?.sidecar.questions ?? []
  return <ExamRun title={meta.name} questions={questions} sourceOf={() => fileId} diagnosisTarget={{ fileId, folderId: null }} onRegenerate={() => (setAgain(true), setState('choose'))} notice={webNote} draftScope={`file:${fileId}`} />
}

export function FolderExamDialog({ folderId, fileIds }: { folderId: string | null; fileIds?: string[] }) {
  const ui = useUiStore()
  const library = useLibraryStore()
  const [count, setCount] = useState('')
  const [pool, setPool] = useState<{ question: StoredQuestion; fileId: string }[] | null>(null)
  const [chosen, setChosen] = useState<StoredQuestion[] | null>(null)
  const folderName = folderId ? (library.folders.find(folder => folder.id === folderId)?.name ?? 'Pasta') : 'Seleção'
  const scope = folderId ? `folder:${folderId}` : selectionScope(fileIds ?? [])

  useEffect(() => {
    const ids = new Set<string>()
    if (folderId) {
      const walk = (id: string) => {
        ids.add(id)
        for (const folder of library.folders.filter(item => item.parentId === id && !item.deletedAt)) walk(folder.id)
      }
      walk(folderId)
    }
    const files = library.files.filter(file => !file.deletedAt && isNote(file) && (fileIds ? fileIds.includes(file.id) : file.folderId !== null && ids.has(file.folderId)))
    void Promise.all(files.map(async file => (await library.openFile(file.id)).sidecar.questions.map(question => ({ question, fileId: file.id })))).then(lists => {
      const all = lists.flat()
      setPool(all)
      // an exam left half way comes back as it was, with the same questions, without asking how many again
      const kept = peekExamDraft(examDraftKey(library.accountId, scope))
      const byId = new Map(all.map(item => [item.question.storedId, item.question]))
      if (kept?.length && kept.every(id => byId.has(id))) setChosen(kept.map(id => byId.get(id)!))
    })
  }, [folderId, fileIds])

  if (chosen && pool) {
    const owner = new Map(pool.map(item => [item.question.storedId, item.fileId]))
    return <ExamRun title={folderName} questions={chosen} sourceOf={id => owner.get(id)} diagnosisTarget={{ fileId: null, folderId }} draftScope={scope} />
  }

  const total = pool?.length ?? 0
  const start = (amount: number) => {
    const shuffled = [...(pool ?? [])].sort(() => Math.random() - 0.5)
    setChosen(shuffled.slice(0, amount).map(item => item.question))
  }
  return (
    <Dialog
      title={`Prova · ${folderName}`}
      size="narrow"
      onClose={ui.close}
      footer={
        total > 0 ? (
          <>
            <button className="btn" onClick={() => start(total)}>
              Todas ({total})
            </button>
            <button className="btn primary" disabled={!Number(count)} onClick={() => start(Math.min(Number(count), total))}>
              Começar
            </button>
          </>
        ) : undefined
      }
    >
      <div className="db">
        {pool === null ? (
          <span className="muted">Juntando as questões…</span>
        ) : total === 0 ? (
          <div className="banner">
            <Icon name="warn" />
            <span>Nenhum arquivo daqui tem prova ainda. Abra um arquivo e faça a prova dele primeiro.</span>
          </div>
        ) : (
          <div className="field">
            <label htmlFor="fx-count">Quantas questões? ({total} disponíveis)</label>
            <input className="input" id="fx-count" type="number" min={1} max={total} placeholder={`1-${total}`} value={count} onChange={event => setCount(event.target.value)} autoFocus />
          </div>
        )}
      </div>
    </Dialog>
  )
}
