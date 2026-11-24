import type { Card } from '@/controllers/langs.controller'
import { Icon } from '@/components/ui/Icon'
import { moveWithArrows } from '@/components/langs/cards/ListenCard'
import { type Answer, choices, type Result, type Slot } from '@/lib/langs/listen'

/** The read cards types (spec 004, FR-017): answered by touching, graded by the app (prototipo/web/cards.js). */
export const READ_TYPES: Card['type'][] = ['mc', 'tf', 'gap', 'order', 'match', 'odd']

interface Props {
  card: Card
  slot: Slot
  lang: 'native' | 'target'
  answer: Answer
  onAnswer: (answer: Answer) => void
  checked: boolean
  result?: Result | null
}

function rightIndex(card: Card): number {
  if (card.type === 'tf') return card.a === true ? 0 : 1
  return Number(card.a)
}

/** One read card: the sentence (gap), the options, the tokens to put in order or the pairs to link. */
export function ReadCard({ card, slot, lang, answer, onAnswer, checked, result }: Props) {
  if (card.type === 'order') return <Order card={card} slot={slot} answer={answer} onAnswer={onAnswer} checked={checked} result={result} />
  if (card.type === 'match') return <Match card={card} slot={slot} answer={answer} onAnswer={onAnswer} checked={checked} />
  const options = choices(card, slot, lang)
  const right = rightIndex(card)
  return (
    <div className="lg-card-body">
      {card.type === 'gap' && card.text && (
        <p className="lg-sentence">
          {card.text}
        </p>
      )}
      <div className={card.type === 'tf' ? 'lg-tf' : 'lg-opts'} role="radiogroup" aria-label="Respostas" onKeyDown={moveWithArrows}>
        {options.map(option => {
          const state = checked ? (option.value === right ? 'right' : option.value === answer ? 'wrong' : '') : ''
          return (
            <button key={`${option.value}-${option.label}`} type="button" role="radio" aria-checked={answer === option.value} disabled={checked} className={`lg-opt ${state}`} onClick={() => onAnswer(option.value)}>
              {option.label}
              {state && <Icon name={state === 'right' ? 'check' : 'x'} />}
              {state && <span className="sr-only">{state === 'right' ? ' (a certa)' : ' (sua resposta)'}</span>}
            </button>
          )
        })}
      </div>
    </div>
  )
}

/** "Monte a frase": the tokens touched go to the line, in that order; "Limpar" starts again. */
function Order({ card, slot, answer, onAnswer, checked, result }: Omit<Props, 'lang'>) {
  const tokens = card.tokens ?? []
  const order = slot.order?.length === tokens.length ? slot.order : tokens.map((_, i) => i)
  const picked = Array.isArray(answer) ? answer.map(Number) : []
  return (
    <div className="lg-card-body">
      <div className={`lg-built ${checked ? (result?.ok ? 'right' : 'wrong') : ''}`} role="group" aria-label="Sua frase">
        {picked.length ? (
          picked.map((i, at) => (
            <button key={`${i}-${at}`} type="button" className="lg-chip on" disabled={checked} onClick={() => onAnswer(picked.filter((_, k) => k !== at))} aria-label={`Tirar ${tokens[i]}`}>
              {tokens[i]}
            </button>
          ))
        ) : (
          <span className="faint">Toque nas peças na ordem da frase</span>
        )}
      </div>
      <div className="lg-chips" role="group" aria-label="Peças">
        {order
          .filter(i => !picked.includes(i))
          .map(i => (
            <button key={i} type="button" className="lg-chip" disabled={checked} onClick={() => onAnswer([...picked, i])}>
              {tokens[i]}
            </button>
          ))}
      </div>
      {!checked && picked.length > 0 && (
        <button type="button" className="btn quiet lg-clear" onClick={() => onAnswer([])}>
          Limpar
        </button>
      )}
    </div>
  )
}

/** "Ligue os pares": touch one on the left, then its pair on the right. */
function Match({ card, slot, answer, onAnswer, checked }: Omit<Props, 'lang' | 'result'>) {
  const pairs = card.pairs ?? []
  const order = slot.order?.length === pairs.length ? slot.order : pairs.map((_, i) => i)
  const links = Array.isArray(answer) && answer.length === pairs.length ? answer.map(Number) : pairs.map(() => -1)
  const chosen = links.indexOf(-2)
  const selected = chosen >= 0 ? chosen : null
  const pick = (left: number) => onAnswer(links.map((link, i) => (i === left ? -2 : link === -2 ? -1 : link)))
  const link = (right: number) => {
    if (selected === null) return
    onAnswer(links.map((value, i) => (i === selected ? right : value)))
  }
  return (
    <div className="lg-card-body">
      <div className="lg-match">
        <div className="lg-match-col" role="group" aria-label="Esquerda">
          {pairs.map(([left], i) => {
            const linked = links[i] >= 0 ? pairs[links[i]][1] : null
            const state = checked ? (links[i] === i ? 'right' : 'wrong') : ''
            return (
              <button key={i} type="button" className={`lg-chip ${selected === i ? 'sel' : ''} ${linked ? 'on' : ''} ${state}`} aria-pressed={selected === i} disabled={checked} onClick={() => pick(i)}>
                {linked ? `${left} → ${linked}` : left}
              </button>
            )
          })}
        </div>
        <div className="lg-match-col" role="group" aria-label="Direita">
          {order.map(j => {
            const used = links.includes(j)
            return (
              <button key={j} type="button" className={`lg-chip ${used ? 'on' : ''}`} disabled={checked || used || selected === null} onClick={() => link(j)}>
                {pairs[j][1]}
              </button>
            )
          })}
        </div>
      </div>
      {!checked && links.some(value => value >= 0) && (
        <button type="button" className="btn quiet lg-clear" onClick={() => onAnswer(pairs.map(() => -1))}>
          Limpar
        </button>
      )}
    </div>
  )
}
