import type { ModelPrice, ReadError } from '@/controllers/models.controller'

export const plain = (text: string) => text.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
export const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`
export const nem = (list: string[]) => (list.length < 2 ? list.join('') : `${list.slice(0, -1).join(', ')} nem ${list[list.length - 1]}`)
export const eLista = (list: string[]) => (list.length < 2 ? list.join('') : `${list.slice(0, -1).join(', ')} e ${list[list.length - 1]}`)
export const keyMask = (key: string) => (key ? `••••${key.length > 8 ? key.slice(-4) : ''}` : 'sem chave')

export const money = (value: number) => `US$ ${value.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: value >= 1 ? 2 : value >= 0.0001 ? 4 : 6 })}`

export const NO_PRICE = 'preço não disponível'
export const PER_TOKEN = 'por 1M de tokens'

export type PriceSide = { group: 0 | 1; value: number; text: string; about: string; unit?: string } | { group: 2 }

/** One side of the price column: per-token first, other units next, no price last. */
export function priceSide(price: ModelPrice | null | undefined, side: 'in' | 'out'): PriceSide {
  if (price && 'unit' in price) return side === 'in' ? { group: 1, unit: price.unit, value: price.value, text: money(price.value) + price.unit, about: price.about } : { group: 2 }
  const value = price ? (side === 'in' ? price.input : price.output) : null
  return value === null || value === undefined ? { group: 2 } : { group: 0, value, text: money(value), about: PER_TOKEN }
}

export interface SortState {
  key: 'name' | 'in' | 'out' | null
  dir: number
}

/** Click: ascending, descending, back to the original order. */
export function nextSort(sort: SortState, key: 'name' | 'in' | 'out'): void {
  if (sort.key !== key) {
    sort.key = key
    sort.dir = 1
  } else if (sort.dir > 0) sort.dir = -1
  else {
    sort.key = null
    sort.dir = 1
  }
}

export function sortedModels<T extends { name: string }>(list: T[], sort: SortState, priceOf: (item: T) => ModelPrice | null | undefined): T[] {
  if (!sort.key) return list
  const out = [...list]
  if (sort.key === 'name') return out.sort((a, b) => sort.dir * a.name.localeCompare(b.name, 'pt-BR', { sensitivity: 'base', numeric: true }))
  const side = sort.key
  const keys = new Map(out.map(item => [item, priceSide(priceOf(item), side)]))
  return out.sort((a, b) => {
    const x = keys.get(a)!
    const y = keys.get(b)!
    if (x.group !== y.group) return x.group - y.group
    if (x.group === 2 || y.group === 2) return 0
    if (x.unit !== y.unit) return (x.unit ?? '') < (y.unit ?? '') ? -1 : 1
    return sort.dir * (x.value - y.value)
  })
}

export function errShort(error: ReadError): string {
  if (error.kind === 'nokey') return 'sem chave'
  if (error.kind === 'key') return `recusada (${error.code})`
  if (error.kind === 'http') return `erro (${error.code})`
  if (error.kind === 'net') return 'sem resposta'
  return 'resposta inválida'
}

export function errLong(error: ReadError): string {
  if (error.kind === 'nokey') return 'sem chave'
  if (error.kind === 'key') return `chave recusada (${error.code})`
  if (error.kind === 'http') return `o provedor devolveu erro (${error.code})`
  if (error.kind === 'net') return 'o provedor não respondeu'
  return 'a resposta veio num formato que não dá para ler'
}

export function errAdvice(error: ReadError): string {
  if (error.kind === 'nokey') return 'Cole a chave e teste.'
  if (error.kind === 'key') return 'Cole a chave de novo e teste.'
  return 'Confira e teste de novo.'
}

export function validUrl(text: string): boolean {
  try {
    return /^https?:$/.test(new URL(text).protocol)
  } catch {
    return false
  }
}
