import { useId, useRef, useState } from 'react'

import type { TutorArtifact } from '@/types/domain'
import { Icon } from '@/components/ui/Icon'
import { shortDate } from '@/utils/format'

interface Props {
  items: TutorArtifact[]
  /** The conversation open in the Chat (absent: a new one not asked yet). */
  currentId: string | null
  /** An answer is coming: the open conversation cannot be left nor deleted. */
  busy: boolean
  timezone: string
  onOpen(id: string): void
  onRename(id: string, name: string): void
  onDelete(id: string): void
}

const count = (total: number) => `${total} ${total === 1 ? 'mensagem' : 'mensagens'}`

function Row({ item, current, busy, timezone, onOpen, onRename, onDelete }: Omit<Props, 'items' | 'currentId'> & { item: TutorArtifact; current: boolean }) {
  const lineId = useId()
  const [naming, setNaming] = useState<string | null>(null)
  const [asking, setAsking] = useState(false)
  // Enter and Esc end the field, and the field leaving the page fires a blur: only the first of them counts
  const settled = useRef(false)

  const startNaming = () => {
    settled.current = false
    setNaming(item.name)
  }
  const finishNaming = (save: boolean) => {
    if (settled.current) return
    settled.current = true
    const said = naming?.trim() ?? ''
    setNaming(null)
    if (save && said && said !== item.name) onRename(item.id, said)
  }

  if (asking) {
    return (
      <li className="art chat-confirm">
        <div role="group" aria-label={`Apagar “${item.name}”`}>
          <span>
            Apagar “{item.name}”? A conversa sai desta entrada e não volta.
          </span>
          <span className="chat-confirm-act">
            <button className="btn quiet" onClick={() => setAsking(false)}>
              Cancelar
            </button>
            <button
              className="btn danger"
              onClick={() => {
                setAsking(false)
                onDelete(item.id)
              }}
            >
              Apagar
            </button>
          </span>
        </div>
      </li>
    )
  }

  return (
    <li className={current ? 'art is-current' : 'art'}>
      {naming === null ? (
        <button className="art-open" title={item.name} aria-label={item.name} aria-describedby={lineId} aria-current={current ? 'true' : undefined} disabled={busy && !current} onClick={() => onOpen(item.id)}>
          <b>{item.name}</b>
          <span className="faint" id={lineId}>
            {shortDate(item.updatedAt, timezone)} · {count(item.turns.length)}
          </span>
        </button>
      ) : (
        <input
          className="input"
          aria-label="Novo nome"
          autoFocus
          value={naming}
          onChange={event => setNaming(event.target.value)}
          onBlur={() => finishNaming(true)}
          onKeyDown={event => {
            if (event.key === 'Enter') finishNaming(true)
            if (event.key === 'Escape') {
              // the Esc of the field must not close the window
              event.stopPropagation()
              finishNaming(false)
            }
          }}
        />
      )}
      <button className="ibtn" aria-label={`Renomear “${item.name}”`} onClick={startNaming}>
        <Icon name="pen" />
      </button>
      <button className="ibtn" aria-label={`Apagar “${item.name}”`} disabled={busy && current} onClick={() => setAsking(true)}>
        <Icon name="trash" />
      </button>
    </li>
  )
}

/** The Chat's conversations of this entrada: open one, rename, delete (asked first). */
export function ChatConversations({ items, currentId, ...rest }: Props) {
  if (!items.length) return <p className="muted chat-empty">Nenhuma conversa ainda. Faça uma pergunta e ela fica guardada aqui.</p>
  return (
    <ul className="arts chat-list" aria-label="Conversas do chat">
      {items.map(item => (
        <Row key={item.id} item={item} current={item.id === currentId} {...rest} />
      ))}
    </ul>
  )
}
