// O que o Início mostra: as últimas coisas feitas, da mais nova para a mais antiga, em dias do fuso das configurações.
import type { FileMeta } from '@/types/domain'

export type RecentDay = 'hoje' | 'ontem' | 'semana' | 'antes'

export const RECENT_LABEL: Record<RecentDay, string> = { hoje: 'Hoje', ontem: 'Ontem', semana: 'Esta semana', antes: 'Antes' }

export interface RecentGroup {
  id: RecentDay
  label: string
  items: FileMeta[]
}

/** When it was last done: created, generated or changed, whichever came later. */
export function doneAt(file: Pick<FileMeta, 'created' | 'updated'>): number {
  const times = [Date.parse(file.created.at), Date.parse(file.updated.at)].filter(time => !Number.isNaN(time))
  return times.length ? Math.max(...times) : 0
}

/** Notes and entradas done, newest first. A lesson still to be written is not done yet; the Lixeira is out before this (`useLiveLibrary`). */
export function recentItems(files: FileMeta[]): FileMeta[] {
  return files
    .filter(file => !file.deletedAt && file.status !== 'pending')
    .map(file => ({ file, at: doneAt(file) }))
    .sort((a, b) => b.at - a.at)
    .map(item => item.file)
}

const dayFormats = new Map<string, Intl.DateTimeFormat>()

/** The calendar day ("2026-11-14") of a moment in the timezone. */
function dayOf(time: number, timeZone: string): string {
  let format = dayFormats.get(timeZone)
  if (!format) {
    format = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' })
    dayFormats.set(timeZone, format)
  }
  const parts = Object.fromEntries(format.formatToParts(new Date(time)).map(part => [part.type, part.value]))
  return `${parts.year}-${parts.month}-${parts.day}`
}

/** Whole calendar days from `earlier` to `later`, DST-proof since it counts days, not hours. */
function daysBetween(earlier: string, later: string): number {
  const number = (day: string) => {
    const [year, month, date] = day.split('-').map(Number)
    return Date.UTC(year, month - 1, date) / 86_400_000
  }
  return number(later) - number(earlier)
}

/** Hoje, Ontem, Esta semana (the six days before yesterday at most) or Antes. */
export function dayGroupOf(time: number, now: number, timeZone: string): RecentDay {
  const age = daysBetween(dayOf(time, timeZone), dayOf(now, timeZone))
  return age <= 0 ? 'hoje' : age === 1 ? 'ontem' : age <= 6 ? 'semana' : 'antes'
}

/** Only the groups that have something, in order, each newest first; `items` must already be newest first. */
export function groupByDay(items: FileMeta[], now: number, timeZone: string): RecentGroup[] {
  const groups: RecentGroup[] = []
  for (const file of items) {
    const id = dayGroupOf(doneAt(file), now, timeZone)
    const last = groups[groups.length - 1]
    if (last?.id === id) last.items.push(file)
    else groups.push({ id, label: RECENT_LABEL[id], items: [file] })
  }
  return groups
}

/** "14:32" for today, "13/11" for any other day of this year, "13/11/2025" for another year. */
export function whenLabel(time: number, now: number, timeZone: string): string {
  const day = dayOf(time, timeZone)
  const date = new Date(time)
  if (day === dayOf(now, timeZone)) return date.toLocaleTimeString('pt-BR', { timeZone, hour: '2-digit', minute: '2-digit' })
  const sameYear = day.slice(0, 4) === dayOf(now, timeZone).slice(0, 4)
  return date.toLocaleDateString('pt-BR', { timeZone, day: '2-digit', month: '2-digit', ...(sameYear ? {} : { year: 'numeric' }) })
}
