// A date field in Brazilian Portuguese: shows and takes dd/mm/aaaa, and opens a pt-BR calendar. The value it gives is
// aaaa-mm-dd (or undefined, when empty). It replaces <input type="date">, which draws in the browser's language.
import { type KeyboardEvent, type RefObject, useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

import { Icon } from '@/components/ui/Icon'
import { type BrDayError, dayName, formatBrDay, MAX_DAY, MAX_YEAR, MIN_DAY, MIN_YEAR, maskBrDay, monthCells, monthTitle, parseBrDay, shiftDay, shiftMonth, todayIso, weekdayOf, weekdays } from '@/lib/br-date'
import '@/styles/filter-panel.css'

export interface DateFieldProps {
  /** What the field is called ("De", "Até"). */
  label: string
  /** aaaa-mm-dd, or nothing. */
  value: string | undefined
  onChange(value: string | undefined): void
}

const MESSAGES: Record<BrDayError, string> = {
  missing: 'Essa data não existe.',
  year: `Escolha um ano entre ${MIN_YEAR} e ${MAX_YEAR}.`,
  incomplete: 'Escreva dia, mês e ano, como 05/11/2026.',
}

const FULL = 'dd/mm/aaaa'.length
const GAP = 4
const MARGIN = 8

/* ---------- the calendar ---------- */

interface CalendarProps {
  label: string
  value: string | undefined
  anchor: RefObject<HTMLElement | null>
  opener: RefObject<HTMLElement | null>
  /** `undefined` clears. */
  onPick(day: string | undefined): void
  /** `back`: Esc or a pick, so the focus returns to the button; a click elsewhere leaves it where the click put it. */
  onClose(back: boolean): void
}

function Calendar({ label, value, anchor, opener, onPick, onClose }: CalendarProps) {
  const box = useRef<HTMLDivElement>(null)
  const grid = useRef<HTMLTableElement>(null)
  const moved = useRef(true)
  const [cursor, setCursor] = useState(() => (value && value >= MIN_DAY && value <= MAX_DAY ? value : todayIso()))
  const [position, setPosition] = useState({ left: 0, top: 0 })
  const today = todayIso()
  const names = weekdays()

  // below the field, or above it when there is no room; never out of the screen
  useLayoutEffect(() => {
    const place = () => {
      const field = anchor.current?.getBoundingClientRect()
      const popup = box.current?.getBoundingClientRect()
      if (!field || !popup) return
      const below = field.bottom + GAP
      const room = window.innerHeight - below - MARGIN
      const top = popup.height <= room || field.top - GAP - popup.height < MARGIN ? below : field.top - GAP - popup.height
      setPosition({ left: Math.max(MARGIN, Math.min(field.left, window.innerWidth - popup.width - MARGIN)), top: Math.max(MARGIN, top) })
    }
    place()
    window.addEventListener('resize', place)
    window.addEventListener('scroll', place, true)
    return () => {
      window.removeEventListener('resize', place)
      window.removeEventListener('scroll', place, true)
    }
  }, [anchor])

  useEffect(() => {
    const away = (event: PointerEvent) => {
      const target = event.target as Node
      if (!box.current?.contains(target) && !opener.current?.contains(target)) onClose(false)
    }
    document.addEventListener('pointerdown', away)
    return () => document.removeEventListener('pointerdown', away)
  }, [opener, onClose])

  // the day in focus takes the keyboard when the calendar opens and when an arrow moves it, not when the month buttons are clicked
  useEffect(() => {
    if (!moved.current) return
    moved.current = false
    grid.current?.querySelector<HTMLButtonElement>('button[tabindex="0"]')?.focus()
  }, [cursor])

  const go = (next: string) => {
    moved.current = true
    setCursor(next)
  }

  const onGridKey = (event: KeyboardEvent) => {
    if (event.ctrlKey || event.metaKey || event.altKey) return
    const week = weekdayOf(cursor)
    const next: Record<string, string> = {
      ArrowLeft: shiftDay(cursor, -1),
      ArrowRight: shiftDay(cursor, 1),
      ArrowUp: shiftDay(cursor, -7),
      ArrowDown: shiftDay(cursor, 7),
      Home: shiftDay(cursor, -week),
      End: shiftDay(cursor, 6 - week),
      PageUp: shiftMonth(cursor, -1),
      PageDown: shiftMonth(cursor, 1),
    }
    if (!(event.key in next)) return
    event.preventDefault()
    go(next[event.key])
  }

  const onKey = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      // the drawer under it listens for Esc too, and leaves it alone when it is taken
      event.preventDefault()
      onClose(true)
      return
    }
    if (event.key !== 'Tab') return
    const stops = Array.from(box.current?.querySelectorAll<HTMLButtonElement>('button:not([disabled]):not([tabindex="-1"])') ?? [])
    const edge = event.shiftKey ? stops[0] : stops[stops.length - 1]
    if (stops.length && document.activeElement === edge) {
      event.preventDefault()
      stops[event.shiftKey ? stops.length - 1 : 0].focus()
    }
  }

  const rows = monthCells(cursor)
  const title = monthTitle(cursor)
  return createPortal(
    <div ref={box} className="df-pop" role="dialog" aria-label={`Calendário: ${label}`} style={position} onKeyDown={onKey}>
      <div className="df-head">
        <button type="button" className="ibtn df-nav" aria-label="Mês anterior" disabled={shiftMonth(cursor, -1) === cursor} onClick={() => setCursor(shiftMonth(cursor, -1))}>
          <Icon name="back" />
        </button>
        <div className="df-title" aria-live="polite">
          {title}
        </div>
        <button type="button" className="ibtn df-nav" aria-label="Próximo mês" disabled={shiftMonth(cursor, 1) === cursor} onClick={() => setCursor(shiftMonth(cursor, 1))}>
          <Icon name="fwd" />
        </button>
      </div>
      <table ref={grid} className="df-grid" role="grid" aria-label={title} onKeyDown={onGridKey}>
        <thead>
          <tr>
            {names.map(name => (
              <th key={name.long} scope="col" aria-label={name.long}>
                {name.short}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {Array.from({ length: 6 }, (_, week) => (
            <tr key={week}>
              {rows.slice(week * 7, week * 7 + 7).map((day, column) =>
                day ? (
                  <td key={day} role="gridcell" aria-selected={day === value}>
                    <button type="button" className="df-day" tabIndex={day === cursor ? 0 : -1} aria-label={dayName(day)} aria-current={day === today ? 'date' : undefined} onClick={() => onPick(day)}>
                      {Number(day.slice(8))}
                    </button>
                  </td>
                ) : (
                  <td key={`blank-${column}`} role="gridcell" />
                ),
              )}
            </tr>
          ))}
        </tbody>
      </table>
      <div className="df-foot">
        <button type="button" className="df-link" onClick={() => onPick(todayIso())}>
          Hoje
        </button>
        <button type="button" className="df-link" disabled={!value} onClick={() => onPick(undefined)}>
          Limpar
        </button>
      </div>
    </div>,
    document.body,
  )
}

/* ---------- the field ---------- */

export function DateField({ label, value, onChange }: DateFieldProps) {
  const id = useId()
  const box = useRef<HTMLDivElement>(null)
  const opener = useRef<HTMLButtonElement>(null)
  const [text, setText] = useState(() => formatBrDay(value))
  const [error, setError] = useState<BrDayError | null>(null)
  const [open, setOpen] = useState(false)
  const [seen, setSeen] = useState(value)

  // a value that changes from outside (clear all the filters) wins over what is typed, right or wrong
  if (seen !== value) {
    setSeen(value)
    const typed = parseBrDay(text)
    if (!('iso' in typed) || typed.iso !== value) {
      setText(formatBrDay(value))
      setError(null)
    }
  }

  const commit = (next: string | undefined) => next !== value && onChange(next)

  const edit = (raw: string) => {
    const masked = maskBrDay(raw)
    setText(masked)
    if (!masked) {
      setError(null)
      commit(undefined)
    } else if (masked.length < FULL) {
      setError(null)
    } else {
      const parsed = parseBrDay(masked)
      setError('iso' in parsed ? null : parsed.error)
      if ('iso' in parsed) commit(parsed.iso)
    }
  }

  const pick = (day: string | undefined) => {
    setText(formatBrDay(day))
    setError(null)
    commit(day)
    close(true)
  }

  const close = (back: boolean) => {
    setOpen(false)
    if (back) opener.current?.focus()
  }

  return (
    <div className="df-field">
      <div className="df-row">
        <label className="df-label" htmlFor={id}>
          {label}
        </label>
        <div ref={box} className="df-box">
          <input
            id={id}
            className="input df-input"
            type="text"
            inputMode="numeric"
            autoComplete="off"
            placeholder="dd/mm/aaaa"
            value={text}
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? `${id}-error` : undefined}
            onChange={event => edit(event.target.value)}
            onBlur={() => text && text.length < FULL && setError('incomplete')}
          />
          <button ref={opener} type="button" className="ibtn df-open" aria-label={`Abrir o calendário: ${label}`} aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen(current => !current)}>
            <Icon name="calendar" />
          </button>
        </div>
      </div>
      {error && (
        <p id={`${id}-error`} className="df-error" role="alert">
          {MESSAGES[error]}
        </p>
      )}
      {open && <Calendar label={label} value={value} anchor={box} opener={opener} onPick={pick} onClose={close} />}
    </div>
  )
}
