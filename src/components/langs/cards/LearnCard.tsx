import type { Item } from '@/controllers/langs.controller'
import { Player } from '@/components/langs/cards/ListenCard'

interface Props {
  item: Item
  /** The labels of the items the base has, to say what this one uses. */
  labels: Record<string, string>
  facets: { id: string; area: string; name: string }[]
  locale: string
  language: string
}

/**
 * The learn card (spec 004, US3/AC4; the prototype's "Aprender"): after a wrong answer, what the item is, before it is tested again
 * another way. In a sense of a word, its pattern and the central sense that links the others; "Tudo sobre" keeps the 9 aspects folded.
 */
export function LearnCard({ item, labels, facets, locale, language }: Props) {
  const aspects = facets.filter(facet => item.facets?.[facet.id])
  const uses = (item.needs ?? []).map(id => labels[id]).filter(Boolean)
  return (
    <div className="lg-card-body lg-learn">
      <h1 className="lg-q" tabIndex={-1} lang={language}>
        {item.label}
      </h1>
      <Player texts={[item.say || item.label]} locale={locale} autoPlay={false} />
      <p className="lg-meaning">{item.meaning}</p>
      {item.word && item.pattern && <p className="faint">{`Sentido de “${item.word}” · padrão: ${item.pattern}`}</p>}
      {item.core && <p className="lg-core">{`Sentido central de “${item.word || item.label}”: ${item.core}`}</p>}
      {uses.length > 0 && <p className="faint">{`Usa: ${uses.join(', ')}`}</p>}
      {item.expl && <p className="lg-explain">{item.expl}</p>}
      {(item.ex ?? []).length > 0 && (
        <ul className="lg-examples">
          {item.ex!.map(example => (
            <li key={example} lang={language}>
              {example}
            </li>
          ))}
        </ul>
      )}
      {aspects.length > 0 && (
        <details className="lg-aspects">
          <summary>{`Tudo sobre “${item.label}” (${aspects.length})`}</summary>
          <ul>
            {aspects.map(facet => (
              <li key={facet.id}>
                <b>{facet.name}:</b> {item.facets![facet.id]}
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  )
}
