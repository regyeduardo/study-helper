import { marked } from 'marked'
import { useEffect, useMemo, useRef, useState } from 'react'

import type { Certainty, Question, StoredQuestion, UserAnswer } from '@/types/domain'
import { Dialog } from '@/components/ui/Dialog'
import { Icon } from '@/components/ui/Icon'
import { CERTAINTY_LABELS, isAnswered, LETTERS, LEVEL_LABELS, questionFromStored, questionType, shuffleExam, storedAnswer, summarizeExam } from '@/lib/exam'
import { useJobsStore } from '@/stores/jobs'
import { useLibraryStore } from '@/stores/library'
import { useUiStore } from '@/stores/ui'

const KIND_LABEL: Record<string, string> = {
  unica: 'Múltipla escolha',
  multipla: 'Marque todas',
  certo_errado: 'Certo ou errado',
  ordenar: 'Ordenar',
  associar: 'Associar',
  lacuna: 'Lacuna',
}

function Markdown({ text }: { text: string }) {
  return <span dangerouslySetInnerHTML={{ __html: marked.parseInline(text, { async: false }) as string }} />
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
          <label key={pair.esquerda} className="match">
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
          <select key={position} aria-label={`Lacuna ${part}`} className="input" style={{ width: 'auto', display: 'inline-block', margin: '0 4px' }} disabled={revealed} value={chosen[index]} onChange={event => onAnswer(chosen.map((value, place) => (place === index ? event.target.value : value)))}>
            <option value="">[{part}] escolha…</option>
            {gap.opcoes.map(option => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>
        )
      })}
    </div>
  )
}

interface ExamRunProps {
  title: string
  questions: StoredQuestion[]
  sourceOf?: (storedId: string) => string | undefined
  onRetryWrong?: (wrong: Question[]) => void
  onRegenerate?: () => void
}

function ExamRun({ title, questions, sourceOf, onRetryWrong, onRegenerate }: ExamRunProps) {
  const ui = useUiStore()
  const recordAttempt = useLibraryStore(state => state.recordAttempt)
  const [seed, setSeed] = useState(0)
  const exam = useMemo(() => shuffleExam(questions.map(questionFromStored)), [questions, seed])
  const [answers, setAnswers] = useState<Record<number, UserAnswer>>({})
  const [certainty, setCertainty] = useState<Record<number, Certainty>>({})
  const [done, setDone] = useState(false)
  const summary = useMemo(() => summarizeExam(exam, answers, certainty), [exam, answers, certainty])
  const answered = exam.filter(question => isAnswered(answers[question.id])).length

  const finish = async () => {
    setDone(true)
    const byFile = new Map<string, Question[]>()
    for (const question of exam) {
      const fileId = sourceOf?.(question.storedId!) ?? ''
      if (!fileId) continue
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

  const wrong = exam.filter(question => summary.scores[question.id] < 1)
  const percent = exam.length ? Math.round((summary.score / exam.length) * 100) : 0

  return (
    <Dialog
      title={`${done ? 'Resultado' : 'Prova'} · ${title}`}
      size="wide"
      onClose={ui.close}
      footer={
        done ? (
          <>
            {onRetryWrong && wrong.length > 0 && (
              <button className="btn" onClick={() => onRetryWrong(wrong)}>
                <Icon name="exam" />
                Reforço do que errei
              </button>
            )}
            <button className="btn" onClick={() => (setAnswers({}), setCertainty({}), setDone(false), setSeed(value => value + 1))}>
              Refazer
            </button>
            <button className="btn primary" onClick={ui.close}>
              Concluir
            </button>
          </>
        ) : (
          <>
            <span className="grow">
              {answered} de {exam.length} respondidas
            </span>
            {onRegenerate && (
              <button className="btn quiet" onClick={onRegenerate}>
                Gerar outras questões
              </button>
            )}
            <button className="btn quiet" onClick={ui.close}>
              Sair sem salvar
            </button>
            <button className="btn primary" onClick={() => void finish()}>
              Entregar
            </button>
          </>
        )
      }
    >
      <div className="db">
        {done ? (
          <div className="result-head">
            <div className="score">{percent}%</div>
            <div>
              <b>
                {summary.score.toLocaleString('pt-BR', { maximumFractionDigits: 1 })} de {exam.length} certas
              </b>{' '}
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
        {exam.map((question, index) => {
          const score = summary.scores[question.id]
          const yourWrong = done && questionType(question) === 'unica' && typeof answers[question.id] === 'string' && answers[question.id] !== question.correta ? question.explicacao_das_erradas?.[answers[question.id] as string] : undefined
          return (
            <div key={question.id} className="q">
              <div className="qh">
                <b>{index + 1}</b>
                <p>{questionType(question) === 'lacuna' ? 'Complete as lacunas.' : <Markdown text={question.enunciado} />}</p>
              </div>
              <div className="qk">
                {KIND_LABEL[questionType(question)]}
                {done && question.nivel ? ` · nível: ${LEVEL_LABELS[question.nivel]}` : ''}
                {done ? ` · certeza: ${CERTAINTY_LABELS[certainty[question.id] ?? 1].toLowerCase()}` : ''}
              </div>
              {question.diagrama && <Diagram code={question.diagrama} />}
              <Answer question={question} answer={answers[question.id]} revealed={done} onAnswer={value => setAnswers(state => ({ ...state, [question.id]: value }))} />
              {!done ? (
                <div className="cert">
                  Certeza:
                  {([1, 2, 3] as Certainty[]).map(level => (
                    <button key={level} className="chip" aria-pressed={certainty[question.id] === level} onClick={() => setCertainty(state => ({ ...state, [question.id]: level }))}>
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
                    <Markdown text={question.explicacao} />
                  </div>
                </>
              )}
            </div>
          )
        })}
      </div>
    </Dialog>
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
  const [state, setState] = useState<'loading' | 'generating' | 'ready' | 'error'>('loading')
  const [error, setError] = useState('')

  const generate = async (wrong?: Question[]) => {
    setState('generating')
    try {
      await createQuestions(fileId, wrong?.map(question => ({ enunciado: question.enunciado, explicacao: question.explicacao })))
      setState('ready')
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'A prova não saiu.')
      setState('error')
    }
  }

  useEffect(() => {
    void openFile(fileId).then(file => {
      if (file.sidecar.questions.length) setState('ready')
      else void generate()
    })
  }, [fileId])

  if (!meta) return null
  if (state === 'loading' || state === 'generating') return <Generating title={meta.name} onCancel={ui.close} />
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
  return <ExamRun title={meta.name} questions={questions} sourceOf={() => fileId} onRetryWrong={wrong => void generate(wrong)} onRegenerate={() => void generate()} />
}

export function FolderExamDialog({ folderId, fileIds }: { folderId: string | null; fileIds?: string[] }) {
  const ui = useUiStore()
  const library = useLibraryStore()
  const [count, setCount] = useState('')
  const [pool, setPool] = useState<{ question: StoredQuestion; fileId: string }[] | null>(null)
  const [chosen, setChosen] = useState<StoredQuestion[] | null>(null)
  const folderName = folderId ? (library.folders.find(folder => folder.id === folderId)?.name ?? 'Pasta') : 'Seleção'

  useEffect(() => {
    const ids = new Set<string>()
    if (folderId) {
      const walk = (id: string) => {
        ids.add(id)
        for (const folder of library.folders.filter(item => item.parentId === id && !item.deletedAt)) walk(folder.id)
      }
      walk(folderId)
    }
    const files = library.files.filter(file => !file.deletedAt && (fileIds ? fileIds.includes(file.id) : file.folderId !== null && ids.has(file.folderId)))
    void Promise.all(files.map(async file => (await library.openFile(file.id)).sidecar.questions.map(question => ({ question, fileId: file.id })))).then(lists => setPool(lists.flat()))
  }, [folderId, fileIds])

  if (chosen && pool) {
    const owner = new Map(pool.map(item => [item.question.storedId, item.fileId]))
    return <ExamRun title={folderName} questions={chosen} sourceOf={id => owner.get(id)} />
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
