import type { Area, Card, Item, LanguageText } from '@/controllers/langs.controller'

/**
 * The study of an area with all the texts (spec 004, FR-044; owner, 25/11: "o estudo geral de todos os textos (tudo que foi
 * gerado)"): one text made of what the language's ready texts have in that area, studied like a text without the Contexto (it
 * needs a text in sight). An item that is in several texts brings the test cards of all of them; what the area's items need from
 * other areas comes as `needed` (tested and taught after a wrong answer, never an item of the area). `origin` says which text each
 * card came from: the answer and "Reportar" go to it.
 */
export interface AreaStudy {
  text: LanguageText
  origin: Record<string, string>
}

export function areaText(texts: LanguageText[], area: Area, title: string): AreaStudy {
  const items: Record<string, Item> = {}
  const needed: Record<string, Item> = {}
  const origin: Record<string, string> = {}
  const practice: Card[] = []
  const equivalences: string[][] = []
  const facets: LanguageText['facets'] = []
  let schedules: LanguageText['schedules'] = {}
  const from = (card: Card, text: LanguageText) => (origin[card.id] ??= text.id)

  for (const text of texts) {
    schedules = { ...schedules, ...text.schedules }
    for (const [id, item] of [...Object.entries(text.items), ...Object.entries(text.needed ?? {})]) {
      const into = item.area === area ? items : needed
      const kept = (into[id] ??= { ...item, test: [] })
      for (const card of item.test) {
        if (kept.test.some(known => known.id === card.id)) continue
        kept.test.push(card)
        from(card, text)
      }
    }
    for (const card of text.practice) {
      const first = card.covers?.[0]
      const item = first ? (text.items[first] ?? text.needed?.[first]) : undefined
      if (item?.area !== area || practice.some(known => known.id === card.id)) continue
      practice.push(card)
      from(card, text)
    }
    for (const group of text.equivalences) if (!equivalences.some(known => known.join('\n') === group.join('\n'))) equivalences.push(group)
    for (const facet of text.facets) if (!facets.some(known => known.id === facet.id)) facets.push(facet)
  }

  return {
    text: {
      id: `area:${area}`,
      language: texts[0]?.language ?? '',
      locale: texts[0]?.locale ?? '',
      title,
      status: 'ready',
      lines: [],
      equivalences,
      items,
      practice,
      context: [],
      facets,
      needed,
      schedules,
    },
    origin,
  }
}
