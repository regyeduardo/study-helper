import { type MouseEvent, useState } from 'react'

import type { RecordingMark } from '@/types/domain'
import { Icon } from '@/components/ui/Icon'
import { clockTime } from '@/lib/transcription/export'

export interface MarkActions {
  editing: string | null
  onEditing(id: string | null): void
  onChange(mark: RecordingMark): void
  onRemove(id: string): void
}

const apart = (event: MouseEvent) => event.stopPropagation()

const titleOf = (mark: RecordingMark) => `${mark.kind === 'mark' ? 'Momento marcado' : 'Anotação'} em ${clockTime(mark.at)}`
const nameOf = (mark: RecordingMark) => `${mark.kind === 'mark' ? 'a marcação' : 'a anotação'} de ${clockTime(mark.at)}`

export function MarkGlyph({ kind }: { kind: RecordingMark['kind'] }) {
  return (
    <svg className="ic" viewBox="0 0 24 24" aria-hidden="true">
      {kind === 'mark' ? <path d="M6 21V4.5M6 5h11l-2 3.5 2 3.5H6" /> : <path d="M5 5.5h14v10H10l-4 3.5v-3.5H5z" />}
    </svg>
  )
}

function MarkEditor({ mark, actions }: { mark: RecordingMark; actions: MarkActions }) {
  const [text, setText] = useState(mark.text)
  const keep = () => {
    const clean = text.trim()
    if (clean !== mark.text) actions.onChange({ ...mark, text: clean, kind: clean ? 'note' : 'mark' })
    actions.onEditing(null)
  }
  return (
    <span className={`tr-mark editing ${mark.kind}`} role="note" aria-label={titleOf(mark)} onClick={apart}>
      <MarkGlyph kind={mark.kind} />
      <time>{clockTime(mark.at)}</time>
      <input
        className="tr-mark-text"
        aria-label="Texto da anotação"
        placeholder="Anotação (opcional) · Enter guarda"
        autoFocus
        value={text}
        onChange={event => setText(event.target.value)}
        onKeyDown={event => {
          if (event.key === 'Enter') keep()
          if (event.key === 'Escape') actions.onEditing(null)
        }}
      />
      <button className="tr-mark-del" aria-label={`Apagar ${nameOf(mark)}`} title="Apagar" onClick={() => actions.onRemove(mark.id)}>
        <Icon name="trash" />
      </button>
    </span>
  )
}

export function Markers({ marks, actions }: { marks: RecordingMark[]; actions?: MarkActions }) {
  if (!marks.length) return null
  return (
    <div className="tr-marks">
      {marks.map(mark => {
        if (actions?.editing === mark.id) return <MarkEditor key={mark.id} mark={mark} actions={actions} />
        const body = (
          <>
            <MarkGlyph kind={mark.kind} />
            <time>{clockTime(mark.at)}</time>
            {mark.text && <span>{mark.text}</span>}
          </>
        )
        return (
          <span key={mark.id} className={`tr-mark ${mark.kind}`} role="note" aria-label={titleOf(mark)}>
            {actions ? (
              <button
                className="tr-mark-open"
                aria-label={`Editar ${nameOf(mark)}`}
                title="Editar ou apagar"
                onClick={event => {
                  apart(event)
                  actions.onEditing(mark.id)
                }}
              >
                {body}
              </button>
            ) : (
              body
            )}
          </span>
        )
      })}
    </div>
  )
}
