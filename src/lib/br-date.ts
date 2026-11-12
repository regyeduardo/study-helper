// Dia no jeito brasileiro (dd/mm/aaaa) e as contas do calendário. O valor que sai daqui é sempre
// o texto aaaa-mm-dd (o mesmo dos filtros da biblioteca); nada passa por fuso horário.

export const MIN_YEAR = 1900
export const MAX_YEAR = 2100
export const MIN_DAY = `${MIN_YEAR}-01-01`
export const MAX_DAY = `${MAX_YEAR}-12-31`

export type BrDayError = 'incomplete' | 'missing' | 'year'
export type BrDayResult = { iso: string } | { error: BrDayError }

const pad = (value: number | string, size = 2) => String(value).padStart(size, '0')
const SIZES = [2, 2, 4]
const SEPARATORS = '/.- '

/** What the field shows while someone types or pastes: digits take their slashes, "5/" becomes "05/", "2026-11-05" becomes "05/11/2026". */
export function maskBrDay(raw: string): string {
  const iso = /^\s*(\d{4})-(\d{1,2})-(\d{1,2})\s*$/.exec(raw)
  if (iso) return `${pad(iso[3])}/${pad(iso[2])}/${iso[1]}`
  const parts = ['']
  for (const char of raw) {
    const at = parts.length - 1
    if (char >= '0' && char <= '9') {
      if (parts[at].length < SIZES[at]) parts[at] += char
      else if (at < 2) parts.push(char)
    } else if (SEPARATORS.includes(char) && parts[at] && at < 2) parts.push('')
  }
  return parts.map((part, at) => (at < parts.length - 1 ? pad(part) : part)).join('/')
}

export const daysIn = (year: number, month: number) => new Date(year, month, 0).getDate()

/** "05/11/2026" to "2026-11-05", or why it is not a day. */
export function parseBrDay(text: string): BrDayResult {
  const match = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(text)
  if (!match) return { error: 'incomplete' }
  const day = Number(match[1])
  const month = Number(match[2])
  const year = Number(match[3])
  if (year < MIN_YEAR || year > MAX_YEAR) return { error: 'year' }
  if (month < 1 || month > 12 || day < 1 || day > daysIn(year, month)) return { error: 'missing' }
  return { iso: `${match[3]}-${match[2]}-${match[1]}` }
}

/** "2026-11-05" to "05/11/2026"; nothing, or something that is not a day, to "". */
export function formatBrDay(iso: string | undefined): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso ?? '')
  return match ? `${match[3]}/${match[2]}/${match[1]}` : ''
}

/* ---------- the calendar ---------- */

const dateOf = (iso: string) => {
  const [year, month, day] = iso.split('-').map(Number)
  return new Date(year, month - 1, day)
}

const isoOf = (date: Date) => `${pad(date.getFullYear(), 4)}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`

const clamp = (iso: string) => (iso < MIN_DAY ? MIN_DAY : iso > MAX_DAY ? MAX_DAY : iso)

export const todayIso = () => isoOf(new Date())

export function shiftDay(iso: string, days: number): string {
  const date = dateOf(iso)
  date.setDate(date.getDate() + days)
  return clamp(isoOf(date))
}

/** The same day of another month; the last one of it when the month is shorter (31 of October, one month on, is 30 of November). */
export function shiftMonth(iso: string, months: number): string {
  const [year, month, day] = iso.split('-').map(Number)
  const target = new Date(year, month - 1 + months, 1)
  const last = daysIn(target.getFullYear(), target.getMonth() + 1)
  target.setDate(Math.min(day, last))
  return clamp(isoOf(target))
}

/** 0 is Sunday: Brazilian calendars start the week there. */
export const weekdayOf = (iso: string) => dateOf(iso).getDay()

/** Six weeks of the month of `iso`, Sunday first; the days outside it are null. Always 42, so the calendar does not change height. */
export function monthCells(iso: string): (string | null)[] {
  const [year, month] = iso.split('-').map(Number)
  const before = new Date(year, month - 1, 1).getDay()
  const cells: (string | null)[] = Array.from({ length: before }, () => null)
  for (let day = 1; day <= daysIn(year, month); day++) cells.push(`${pad(year, 4)}-${pad(month)}-${pad(day)}`)
  while (cells.length < 42) cells.push(null)
  return cells
}

const MONTH_TITLE = new Intl.DateTimeFormat('pt-BR', { month: 'long', year: 'numeric' })
const DAY_NAME = new Intl.DateTimeFormat('pt-BR', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })
const WEEKDAY_SHORT = new Intl.DateTimeFormat('pt-BR', { weekday: 'short' })
const WEEKDAY_LONG = new Intl.DateTimeFormat('pt-BR', { weekday: 'long' })

/** "novembro de 2026" */
export const monthTitle = (iso: string) => MONTH_TITLE.format(dateOf(iso))

/** "quinta-feira, 5 de novembro de 2026" */
export const dayName = (iso: string) => DAY_NAME.format(dateOf(iso))

/** "dom", "seg", ... "sáb", Sunday first, with the name in full for the screen reader. */
export function weekdays(): { short: string; long: string }[] {
  // 1 of November 2026 is a Sunday
  return Array.from({ length: 7 }, (_, index) => {
    const date = new Date(2026, 10, 1 + index)
    return { short: WEEKDAY_SHORT.format(date).replace('.', ''), long: WEEKDAY_LONG.format(date) }
  })
}
