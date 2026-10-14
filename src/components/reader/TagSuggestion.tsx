import { useState } from 'react'

import type { FileMeta } from '@/types/domain'
import { useLibraryStore } from '@/stores/library'

export function TagSuggestion({ meta }: { meta: FileMeta }) {
  const updateFile = useLibraryStore(state => state.updateFile)
  const suggested = meta.suggestedTags ?? []
  const [off, setOff] = useState<Set<string>>(new Set())
  if (!suggested.length) return null
  const chosen = suggested.filter(tag => !off.has(tag))
  const toggle = (tag: string) =>
    setOff(current => {
      const next = new Set(current)
      if (next.has(tag)) next.delete(tag)
      else next.add(tag)
      return next
    })
  return (
    <div className="tag-suggest" role="region" aria-label="Etiquetas sugeridas">
      <b>Etiquetas sugeridas</b>
      <span className="tag-suggest-chips">
        {suggested.map(tag => (
          <button key={tag} className="chip" aria-pressed={!off.has(tag)} onClick={() => toggle(tag)}>
            {tag}
          </button>
        ))}
      </span>
      <span className="spacer" />
      <button className="btn primary" disabled={!chosen.length} onClick={() => void updateFile(meta.id, { tags: [...new Set([...meta.tags, ...chosen])], suggestedTags: [] })}>
        Aceitar
      </button>
      <button className="btn" onClick={() => void updateFile(meta.id, { suggestedTags: [] })}>
        Ignorar
      </button>
    </div>
  )
}
