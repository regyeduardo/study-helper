import type { LinkDeadline } from '@/controllers/live-share.controller'

/** The deadlines of a link (spec 007, FR-032), in the order of the row of buttons; a copy has no Permanente (FR-039). */
export const DEADLINES: { id: LinkDeadline; label: string }[] = [
  { id: '1d', label: '1 dia' },
  { id: '3d', label: '3 dias' },
  { id: '7d', label: '7 dias' },
  { id: 'never', label: 'Permanente' },
]

const DAY_MS = 24 * 3600 * 1000

function dayKey(time: number, timeZone?: string): string {
  return new Date(time).toLocaleDateString('pt-BR', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' })
}

/** "vence hoje às 18:00", "vence amanhã às 14:00", "vence em 01/12 às 09:30", "Permanente" or "Venceu em 24/11 às 14:00". */
export function deadlineText(expiresAt: string | null | undefined, now = Date.now(), timeZone?: string): string {
  if (!expiresAt) return 'Permanente: vale até você parar de compartilhar'
  const end = Date.parse(expiresAt)
  const hour = new Date(end).toLocaleTimeString('pt-BR', { timeZone, hour: '2-digit', minute: '2-digit' })
  // a date of another year says the year: "Venceu em 31/12" of a year gone by reads as a day still to come
  const otherYear = dayKey(end, timeZone).slice(-4) !== dayKey(now, timeZone).slice(-4)
  const day = new Date(end).toLocaleDateString('pt-BR', { timeZone, day: '2-digit', month: '2-digit', ...(otherYear ? { year: 'numeric' as const } : {}) })
  if (end <= now) return `Venceu em ${day} às ${hour}`
  if (dayKey(end, timeZone) === dayKey(now, timeZone)) return `vence hoje às ${hour}`
  if (dayKey(end, timeZone) === dayKey(now + DAY_MS, timeZone)) return `vence amanhã às ${hour}`
  return `vence em ${day} às ${hour}`
}
