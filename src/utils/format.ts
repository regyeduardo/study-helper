const WORDS_READ_PER_MINUTE = 200

export function wordCount(text: string): number {
  return text.split(/\s+/).filter(Boolean).length
}

export function readingMinutes(text: string): number {
  const words = wordCount(text)
  return words ? Math.max(1, Math.ceil(words / WORDS_READ_PER_MINUTE)) : 0
}

export function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined) return '—'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit++
  }
  return `${value.toLocaleString('pt-BR', { maximumFractionDigits: unit >= 2 ? 1 : 0 })} ${units[unit]}`
}

export function agoText(iso: string | number | null, now = Date.now()): string {
  if (iso === null) return 'nunca'
  const minutes = Math.round((now - (typeof iso === 'number' ? iso : Date.parse(iso))) / 60000)
  if (minutes < 1) return 'agora'
  if (minutes === 1) return 'há 1 min'
  if (minutes < 60) return `há ${minutes} min`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `há ${hours} h`
  const days = Math.round(hours / 24)
  return days === 1 ? 'há 1 dia' : `há ${days} dias`
}

export function dateTime(iso: string | null | undefined, timeZone: string): string {
  if (!iso) return '—'
  return new Date(iso).toLocaleString('pt-BR', { timeZone, day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' })
}

export function shortDate(iso: string, timeZone: string): string {
  return new Date(iso).toLocaleString('pt-BR', { timeZone, day: '2-digit', month: '2-digit' })
}

export function duration(seconds: number | null | undefined): string {
  if (!seconds) return '—'
  const total = Math.round(seconds)
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const rest = total % 60
  return hours ? `${hours} h ${minutes} min` : minutes ? `${minutes} min ${rest} s` : `${rest} s`
}

export function plainText(markdown: string): string {
  return markdown
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/[#>*_`|[\]()-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}
