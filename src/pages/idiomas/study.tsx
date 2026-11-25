import { useEffect, useRef, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'

import { LearnCard } from '@/components/langs/cards/LearnCard'
import { ListenCard } from '@/components/langs/cards/ListenCard'
import { READ_TYPES, ReadCard } from '@/components/langs/cards/ReadCard'
import { ReportDialog } from '@/components/langs/ReportDialog'
import { Icon } from '@/components/ui/Icon'
import { ApiError } from '@/controllers/api.controller'
import { type Area, type Card, getKnowledge, getLanguage, getProgress, getText, type LanguageText, langsMessage, recordAnswer, saveProgress } from '@/controllers/langs.controller'
import { areaText } from '@/lib/langs/area'
import { type Answer, grade, ready, type Result, type Slot } from '@/lib/langs/listen'
import { newSchedule, rate, review } from '@/lib/langs/fsrs'
import { answer as answered, type Current, currentOf, fitsStudy, goTo, type Knowledge, langOf, type Part, partLeft, prune, startStudy, type StudyState, summaryOf, taught } from '@/lib/langs/study'
import { stop } from '@/lib/langs/voice'
import { paths } from '@/lib/paths'
import { useLangsPlace } from '@/lib/langs/browser'
import { useUiStore } from '@/stores/ui'
import '@/styles/langs.css'

/**
 * The study of a text (spec 004; wireframe A of 21/11: full screen, one thing at a time, the button fixed at the bottom), with the
 * flow of the prototype the owner validated (prototipo/web/app.js), in three parts (25/11, FR-041): Vocabulário (each item of the
 * text, the learn card after a wrong answer) → Prática (read and listen; the wrong ones come back once) → Contexto (the text in
 * sight). The parts can be switched at any time, each one where it stopped (FR-043). Leaving at any moment keeps where the person
 * stopped. With an area instead of a text (`/idiomas/:code/area/:area`, FR-044), it studies that area with all the ready texts:
 * Vocabulário and Prática, no Contexto, each answer going to the card's own text, nothing kept (the base decides each time).
 */

const PARTS: [Part, string][] = [
  ['test', 'Vocabulário'],
  ['practice', 'Prática'],
  ['context', 'Contexto'],
]
const SKILL: Record<string, string> = { read: 'Ler', listen: 'Ouvir', speak: 'Falar' }
const AREA: Record<string, string> = { lexico: 'Léxico', gramatica: 'Gramática', semantica: 'Sentidos', fonologia: 'Pronúncia', ortografia: 'Escrita', registro: 'Registro', pragmatica: 'Uso e discurso' }

/** What the card is, above the question: the part, the skill, the area and, in English, "EN". */
function kicker(now: Extract<Current, { kind: 'card' }>, text: LanguageText, lang: 'native' | 'target'): string {
  const part = now.stage === 'test' ? 'Teste' : now.stage === 'practice' ? 'Prática' : 'Contexto'
  const area = now.card.covers?.length ? AREA[(text.items[now.card.covers[0]] ?? text.needed?.[now.card.covers[0]])?.area ?? ''] : undefined
  const extra = now.review ? 'revisão' : now.again ? (now.stage === 'test' ? 'de novo, de outro jeito' : 'de novo') : undefined
  return [part, extra, SKILL[now.card.skill] ?? 'Ler', area, lang === 'target' ? 'EN' : undefined].filter(Boolean).join(' · ')
}

function CardBody({ card, text, slot, lang, answer, onAnswer, checked, result }: { card: Card; text: LanguageText; slot: Slot; lang: 'native' | 'target'; answer: Answer; onAnswer: (answer: Answer) => void; checked: boolean; result: Result | null }) {
  if (READ_TYPES.includes(card.type)) return <ReadCard card={card} slot={slot} lang={lang} answer={answer} onAnswer={onAnswer} checked={checked} result={result} />
  return <ListenCard card={card} locale={text.locale} slot={slot} answer={answer} onAnswer={onAnswer} checked={checked} result={result} />
}

export default function StudyPage() {
  const { code = '', textId = '', area = '' } = useParams()
  const navigate = useNavigate()
  const toast = useUiStore(state => state.toast)
  const { place, ready: placeReady } = useLangsPlace()
  const [text, setText] = useState<LanguageText | null>(null)
  const [knowledge, setKnowledge] = useState<Knowledge>({})
  const [state, setState] = useState<StudyState | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const [reply, setReply] = useState<Answer>(null)
  const [result, setResult] = useState<Result | null>(null)
  const [reporting, setReporting] = useState(false)
  // FR-044: which text each card of an area came from (the answer and "Reportar" go to it); "Estudar de novo" loads the area again
  const [origin, setOrigin] = useState<Record<string, string>>({})
  const [round, setRound] = useState(0)

  const save = (next: StudyState) => {
    if (area) return
    saveProgress(code, textId, next as unknown as Record<string, unknown>).catch(() => toast('Não deu para guardar onde você parou. Confira a internet.'))
  }

  useEffect(() => {
    if (!placeReady) return
    if (area && !AREA[area]) {
      setProblem('Esta área não existe. Volte à página do idioma e escolha uma área da sua base.')
      return
    }
    let alive = true
    ;(async () => {
      try {
        if (area) {
          const detail = await getLanguage(code)
          const ready = detail.texts.filter(row => row.status === 'ready')
          const [texts, base] = await Promise.all([Promise.all(ready.map(row => getText(code, row.id).catch(() => null))), getKnowledge(code).catch(() => ({}) as Knowledge)])
          if (!alive) return
          const study = areaText(
            texts.filter((loaded): loaded is LanguageText => Boolean(loaded)),
            area as Area,
            AREA[area],
          )
          setOrigin(study.origin)
          setText(study.text)
          setKnowledge(base)
          setState(startStudy(study.text, base))
          setReply(null)
          setResult(null)
          return
        }
        const loaded = await getText(code, textId)
        const [kept, base] = await Promise.all([getProgress(code, textId).then(found => found.state as unknown, () => null), getKnowledge(code).catch(() => ({}) as Knowledge)])
        if (!alive) return
        setText(loaded)
        setKnowledge(base)
        // a text already finished opens to be studied again; a study under way goes on, without what the text no longer has
        const goesOn = fitsStudy(kept) && kept.step !== 'done'
        const next = goesOn ? prune(kept, loaded) : startStudy(loaded, base)
        setState(next)
        // a new study keeps its drawn order from the first card: leaving, or another device, finds the same card
        if (!goesOn) save(next)
      } catch (error) {
        if (!alive) return
        setProblem(error instanceof ApiError && error.code === 'not_ready' ? 'Este texto ainda está sendo preparado. Volte em alguns minutos.' : langsMessage(error))
      }
    })()
    return () => {
      alive = false
      stop()
    }
  }, [code, textId, area, round, placeReady, place])

  const keep = (next: StudyState) => {
    setState(next)
    setReply(null)
    setResult(null)
    save(next)
  }

  const now: Current | null = state && text ? currentOf(state, text) : null
  const card = now?.kind === 'card' ? now : null
  const lang = card && state ? (card.entry.lang ?? langOf(card.card, state, knowledge)) : 'native'
  // each new card: the focus goes to its question (keyboard and screen reader start from it)
  const question = useRef<HTMLHeadingElement>(null)
  const focusKey = state ? `${state.step}-${state.pp}-${state.pos}-${state.cpos}` : ''
  useEffect(() => {
    question.current?.focus({ preventScroll: true })
    document.querySelector<HTMLElement>('.lg-learn .lg-q')?.focus({ preventScroll: true })
  }, [focusKey])
  const checked = result !== null

  const check = () => {
    if (!card || !state || !text || !ready(card.card, reply) || checked) return
    const graded = grade(card.card, reply, card.entry.slot, text.equivalences, lang)
    setResult(graded)
    // FR-025, FR-029: the card's own repetition (FSRS) moves with the answer; the server keeps it with the answer
    const shown = card.card
    const retry = Boolean(card.again)
    review(shown.id, text.schedules?.[shown.id] ?? newSchedule(), rate(graded.ok, retry), new Date())
      .then(schedule => {
        setText(current => (current ? { ...current, schedules: { ...current.schedules, [shown.id]: schedule } } : current))
        return recordAnswer(code, { textId: origin[shown.id] ?? textId, cardId: shown.id, stage: card.stage, promptLang: lang, answer: graded.given, ok: graded.ok, retry, schedule })
      })
      .catch(() => toast('Não deu para guardar a resposta. Confira a internet.'))
  }

  const next = () => {
    if (!card || !state || !text || !result) return
    stop()
    keep(answered(state, text, knowledge, result.ok, lang))
  }

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Enter' || event.shiftKey || reporting || !state) return
      if ((event.target as HTMLElement | null)?.tagName === 'SUMMARY') return
      // Enter on a part opens the part (FR-043), it does not check the card
      if ((event.target as HTMLElement | null)?.closest?.('.lg-steps')) return
      if (now?.kind === 'teach') {
        event.preventDefault()
        keep(taught(state))
      } else if (card) {
        event.preventDefault()
        if (checked) next()
        else check()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  /** FR-043: another part, where it stopped; an answer already checked moves on first (the same card is not answered twice). */
  const switchTo = (part: Part) => {
    if (!state || !text || state.step === part) return
    stop()
    keep(goTo(card && result ? answered(state, text, knowledge, result.ok, lang) : state, part))
  }

  const leave = () => {
    stop()
    navigate(paths.language(code))
  }
  const exit = area ? 'Sair' : 'Sair (guarda onde parou)'

  if (problem || !text || !state || !now) {
    return (
      <main className="lg-study">
        <header className="lg-top">
          <Link className="ibtn" to={paths.language(code)} aria-label="Sair">
            <Icon name="x" />
          </Link>
        </header>
        <div className="lg-stage">{problem ? <p className="lg-error" role="alert">{problem}</p> : <p className="faint">{area ? 'Juntando os textos…' : 'Abrindo o texto…'}</p>}</div>
      </main>
    )
  }

  const position = now.kind === 'card' || now.kind === 'teach' ? now.position : 0
  const total = now.kind === 'card' || now.kind === 'teach' ? now.total : 0
  const summary = state.step === 'done' ? summaryOf(state, text) : null
  const labels = Object.fromEntries(Object.entries({ ...text.needed, ...text.items }).map(([id, item]) => [id, item.label]))
  return (
    <main className="lg-study" aria-label={`Estudo: ${text.title}`}>
      <header className="lg-top">
        <button className="ibtn" onClick={leave} aria-label={exit} title={exit}>
          <Icon name="x" />
        </button>
        <div className="lg-progress" role="progressbar" aria-label="Andamento da parte" aria-valuemin={0} aria-valuemax={total} aria-valuenow={position}>
          <i style={{ transform: `scaleX(${total ? position / total : state.step === 'done' ? 1 : 0})` }} />
        </div>
        <span className="lg-count-top">
          {total ? (
            <>
              <span className="lg-count-name" title={text.title}>
                {text.title}
              </span>
              <span className="lg-count-n">
                {position} de {total}
              </span>
            </>
          ) : (
            text.title
          )}
        </span>
        {card && (
          <button className="ibtn lg-flag" onClick={() => setReporting(true)} aria-label="Reportar este card" title="Reportar este card">
            <Icon name="flag" />
          </button>
        )}
      </header>
      <ol className="lg-steps" aria-label="Partes do estudo">
        {PARTS.filter(([part]) => !area || part !== 'context').map(([part, name]) => {
          const on = state.step === part
          const finished = !on && partLeft(state, part) === 0
          return (
            <li key={part}>
              <button className={on ? 'on' : finished ? 'done' : ''} aria-current={on ? 'step' : undefined} disabled={finished} onClick={() => switchTo(part)}>
                {finished && <Icon name="check" />}
                {name}
                {finished && <span className="sr-only"> (terminada)</span>}
              </button>
            </li>
          )
        })}
      </ol>
      {reporting && card && (
        <ReportDialog
          code={code}
          textId={origin[card.card.id] ?? textId}
          cardId={card.card.id}
          onClose={() => setReporting(false)}
          onSent={() => {
            setReporting(false)
            toast('Vou refazer este card. Na próxima vez ele vem diferente.')
          }}
        />
      )}

      {now.kind === 'teach' && (
        <>
          <div className="lg-stage">
            <p className="lg-kicker">{['Aprender', AREA[now.item.area]].filter(Boolean).join(' · ')}</p>
            <LearnCard item={now.item} labels={labels} facets={text.facets} locale={text.locale} language={text.language} />
          </div>
          <footer className="lg-foot">
            <button className="btn primary lg-go" onClick={() => keep(taught(state))} autoFocus>
              Testar de outro jeito
            </button>
          </footer>
        </>
      )}

      {card && (
        <>
          <div className="lg-stage" key={focusKey}>
            {card.stage === 'context' && (
              <div className="lg-context" aria-label="O texto">
                {text.lines.map((line, n) => (
                  <p key={n} lang={text.language}>
                    {line}
                  </p>
                ))}
              </div>
            )}
            <p className="lg-kicker">{kicker(card, text, lang)}</p>
            <h1 className="lg-q" tabIndex={-1} ref={question} lang={lang === 'target' ? text.language : undefined}>
              {lang === 'target' && card.card.qEn ? card.card.qEn : card.card.q}
            </h1>
            <CardBody card={card.card} text={text} slot={card.entry.slot} lang={lang} answer={reply} onAnswer={setReply} checked={checked} result={result} />
          </div>
          <footer className="lg-foot">
            {result && (
              <div className={`lg-feedback ${result.ok ? 'ok' : 'bad'}`} role="status">
                <b>
                  <Icon name={result.ok ? 'check' : 'x'} />
                  {result.ok ? 'Certo' : 'Não foi'}
                </b>
                {!result.ok && result.right && (
                  <span>
                    Certo: <span lang={text.language}>{result.right}</span>
                  </span>
                )}
                {card.card.expl && <span className="lg-expl">{card.card.expl}</span>}
              </div>
            )}
            {checked ? (
              <button className="btn primary lg-go" onClick={next} autoFocus>
                Continuar
              </button>
            ) : (
              <button className="btn primary lg-go" disabled={!ready(card.card, reply)} onClick={check}>
                Conferir
              </button>
            )}
          </footer>
        </>
      )}

      {summary && area && !state.results.length && (
        <>
          <div className="lg-stage">
            <h1 className="lg-title">{text.title} está em dia</h1>
            <p>Nada vencido nem novo nesta área agora. Volte quando chegar uma revisão ou um texto novo.</p>
          </div>
          <footer className="lg-foot">
            <button className="btn primary lg-go" onClick={leave}>
              Voltar
            </button>
          </footer>
        </>
      )}

      {summary && !(area && !state.results.length) && (
        <>
          <div className="lg-stage">
            <h1 className="lg-title">{area ? `Estudo de ${text.title} terminado` : 'Texto terminado'}</h1>
            <div className="lg-results">
              <div>
                <b>
                  {summary.practice.right} de {summary.practice.total}
                </b>
                <span>prática certa de primeira</span>
              </div>
              {!area && (
                <div>
                  <b>
                    {summary.context.right} de {summary.context.total}
                  </b>
                  <span>contexto</span>
                </div>
              )}
              <div>
                <b>{summary.target}</b>
                <span>{text.language === 'en' ? 'perguntas em inglês' : 'perguntas no idioma'}</span>
              </div>
            </div>
            <p>{summary.taught.length ? `Aprendeu no caminho: ${summary.taught.join(', ')}.` : 'Acertou todos os testes de primeira.'}</p>
            <p className="faint">Os que você errou entram nas suas revisões.</p>
          </div>
          <footer className="lg-foot lg-foot-pair">
            <button className="btn lg-go" onClick={leave}>
              Voltar
            </button>
            <button className="btn primary lg-go" onClick={() => (area ? setRound(round + 1) : keep(startStudy(text, knowledge)))}>
              Estudar de novo
            </button>
          </footer>
        </>
      )}
    </main>
  )
}
