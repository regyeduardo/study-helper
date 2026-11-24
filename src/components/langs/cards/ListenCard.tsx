import { type KeyboardEvent, useEffect, useRef, useState } from 'react'

import type { Card } from '@/controllers/langs.controller'
import { Icon } from '@/components/ui/Icon'
import { type Answer, choices, type Result, type Slot, spoken } from '@/lib/langs/listen'
import { sayAll, stop } from '@/lib/langs/voice'

/** "Ouvir" and "Devagar": the model voice says the card's sentences; the first time it plays by itself. */
export function Player({ texts, locale, autoPlay = true }: { texts: string[]; locale: string; autoPlay?: boolean }) {
  const [playing, setPlaying] = useState<'normal' | 'slow' | null>(null)
  const alive = useRef(true)
  const run = async (slow: boolean) => {
    setPlaying(slow ? 'slow' : 'normal')
    await sayAll(texts, locale, { slow })
    if (alive.current) setPlaying(null)
  }
  const key = texts.join('|')
  useEffect(() => {
    alive.current = true
    const timer = autoPlay ? setTimeout(() => void run(false), 250) : null
    return () => {
      alive.current = false
      if (timer) clearTimeout(timer)
      stop()
    }
  }, [key])
  if (!texts.length) return null
  return (
    <div className="lg-play">
      <button type="button" className="btn lg-play-main" onClick={() => void run(false)} aria-pressed={playing === 'normal'}>
        <Icon name="play" />
        {playing === 'normal' ? 'Tocando…' : 'Ouvir'}
      </button>
      <button type="button" className="btn quiet" onClick={() => void run(true)} aria-pressed={playing === 'slow'}>
        Devagar
      </button>
    </div>
  )
}

interface Props {
  card: Card
  locale: string
  slot: Slot
  answer: Answer
  onAnswer: (answer: Answer) => void
  /** After "Conferir": the answer is fixed and the right one shows. */
  checked: boolean
  result?: Result | null
  autoPlay?: boolean
}

/** Arrow keys move between the answers of a group (the radio pattern); Tab still goes through them. */
export function moveWithArrows(event: KeyboardEvent<HTMLElement>) {
  const step = event.key === 'ArrowDown' || event.key === 'ArrowRight' ? 1 : event.key === 'ArrowUp' || event.key === 'ArrowLeft' ? -1 : 0
  if (!step) return
  const items = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="radio"]:not(:disabled)')]
  const at = items.indexOf(document.activeElement as HTMLButtonElement)
  if (!items.length) return
  event.preventDefault()
  items[(at + step + items.length) % items.length].focus()
}

function rightIndex(card: Card, slot: Slot): number {
  if (card.type === 'minimal_pair') return slot.pick ?? 0
  if (card.type === 'same_diff') return card.a === 'same' ? 0 : 1
  return Number(card.a)
}

/** One listening card (delivery 1): what the voice says and how to answer it. */
export function ListenCard({ card, locale, slot, answer, onAnswer, checked, result, autoPlay = true }: Props) {
  const options = choices(card, slot)
  const right = rightIndex(card, slot)
  const chips = card.type === 'find_diff' || card.type === 'stress'
  return (
    <div className="lg-card-body">
      <Player texts={spoken(card, slot)} locale={locale} autoPlay={autoPlay} />
      {options.length > 0 && (
        <div className={chips ? 'lg-chips' : 'lg-opts'} role="radiogroup" aria-label="Respostas" onKeyDown={moveWithArrows}>
          {options.map(option => {
            const state = checked ? (option.value === right ? 'right' : option.value === answer ? 'wrong' : '') : ''
            return (
              <button
                key={`${option.value}-${option.label}`}
                type="button"
                role="radio"
                aria-checked={answer === option.value}
                disabled={checked}
                className={`${chips ? 'lg-chip' : 'lg-opt'} ${state}`}
                onClick={() => onAnswer(option.value)}
              >
                {option.label}
                {state && <Icon name={state === 'right' ? 'check' : 'x'} />}
                {state && <span className="sr-only">{state === 'right' ? ' (a certa)' : ' (sua resposta)'}</span>}
              </button>
            )
          })}
        </div>
      )}
      {card.type === 'dictation' && (
        <textarea
          className="input lg-dictation"
          rows={2}
          aria-label="O que você ouviu"
          placeholder="Escreva o que ouviu"
          autoComplete="off"
          spellCheck={false}
          autoFocus
          disabled={checked}
          value={typeof answer === 'string' ? answer : ''}
          onChange={event => onAnswer(event.target.value)}
        />
      )}
      {card.type === 'dictation_gap' && <Gaps card={card} answer={answer} onAnswer={onAnswer} checked={checked} result={result} />}
      {checked && result?.diff && !result.ok && (
        <p className="lg-diff" aria-label="Diferença">
          {result.diff.map((word, n) => (
            <span key={n} className={word.k}>
              {word.w}
            </span>
          ))}
        </p>
      )}
    </div>
  )
}

function Gaps({ card, answer, onAnswer, checked, result }: Pick<Props, 'card' | 'answer' | 'onAnswer' | 'checked' | 'result'>) {
  const parts = (card.text ?? '').split('___')
  const values = Array.isArray(answer) ? answer.map(String) : parts.slice(1).map(() => '')
  return (
    <p className="lg-gaps">
      {parts.map((part, n) => (
        <span key={n}>
          {part}
          {n < parts.length - 1 && (
            <input
              className={`input lg-gap ${checked ? (result?.ok ? 'right' : 'wrong') : ''}`}
              aria-label={`Lacuna ${n + 1}`}
              autoComplete="off"
              spellCheck={false}
              autoFocus={n === 0}
              disabled={checked}
              value={values[n] ?? ''}
              onChange={event => onAnswer(values.map((value, k) => (k === n ? event.target.value : value)))}
            />
          )}
        </span>
      ))}
    </p>
  )
}
