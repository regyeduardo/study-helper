import type { Card, Item } from '@/controllers/langs.controller'

/**
 * What the generation gives for a text (spec 004; api/internal/langs/content.go): its items in the order they came, the language
 * practice, the context part and the equivalent forms. `reuse` are ready items the piece only names.
 */
export interface Content {
  lines?: string[]
  equivalences: string[][]
  reuse?: string[]
  items: Record<string, Item>
  practice: Card[]
  context: Card[]
}

/** What the voice says, one after the other: a sentence alone or a list of them. */
export const sayList = (card: Card): string[] => (Array.isArray(card.say) ? card.say : card.say ? [card.say] : [])

/** The text's sentences as the person sent them, without the empty lines. */
export const linesOf = (body: string): string[] =>
  body
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)

/** The 9 aspects of "Tudo sobre" an item. */
export const FACETS = [
  { id: 'spoken', area: 'form', name: 'Pronúncia' },
  { id: 'written', area: 'form', name: 'Escrita' },
  { id: 'parts', area: 'form', name: 'Partes e família' },
  { id: 'meaning', area: 'meaning', name: 'Sentido no trecho' },
  { id: 'senses', area: 'meaning', name: 'Outros sentidos' },
  { id: 'associations', area: 'meaning', name: 'Parecidas e opostas' },
  { id: 'grammar', area: 'use', name: 'Gramática' },
  { id: 'collocations', area: 'use', name: 'Combinações' },
  { id: 'use', area: 'use', name: 'Quando usar' },
]
