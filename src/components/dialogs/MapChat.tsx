// The map's own conversation (a subartefato): questions answer from the note, requests change the map at once.
import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react'

import type { MapArtifact, MapChatTurn } from '@/types/domain'
import { noteText } from '@/components/dialogs/CardsDialog'
import { ModelPick, useModelChoice } from '@/components/dialogs/ModelPick'
import { Icon } from '@/components/ui/Icon'
import { aiConfigOf, modelByUid, targetFor } from '@/lib/ai/config'
import { applyChange, askMap, clearHighlight, undo } from '@/lib/generation/map-chat'
import { GenerationSession } from '@/lib/generation/session'
import { nowIso } from '@/lib/ids'
import { useLibraryStore } from '@/stores/library'

/** Shown while the conversation is empty: they fill the field, so nothing goes to the AI by a slip. */
const STARTERS = ['O que ficou de fora do mapa?', 'Explique o mapa em poucas linhas']

function changedText(changed: string[]): string {
  if (!changed.length) return 'Mudei a forma do mapa'
  return changed.length === 1 ? 'Mudei 1 ramo' : `Mudei ${changed.length} ramos`
}

const messageOf = (failure: unknown) => (failure instanceof Error ? failure.message : String(failure))

interface MapChatProps {
  fileId: string
  map: MapArtifact
  /** `column`: beside the map, collapsible; `sheet`: rises from the bottom, on the phone. */
  layout: 'column' | 'sheet'
  open: boolean
  onToggle(): void
  /** While an answer is on its way, so the screen holds what would race with it (Desfazer). */
  onBusy(busy: boolean): void
  /** More actions in the head of the open conversation ("Salvar como outro mapa" on the phone). */
  actions?: ReactNode
}

export function MapChat({ fileId, map, layout, open, onToggle, onBusy, actions }: MapChatProps) {
  const settings = useLibraryStore(state => state.index.settings)
  const config = useMemo(() => aiConfigOf(settings), [settings])
  // The model that made the map, while it is still in the settings; else the one of Mapa mental.
  const made = map.made?.model && modelByUid(config, map.made.model) ? map.made.model : undefined
  const choice = useModelChoice('mapa', false, made ? { pick: made } : {})
  const [draft, setDraft] = useState('')
  const [asking, setAsking] = useState<string | null>(null)
  const [error, setError] = useState('')
  const note = useRef<Promise<string> | null>(null)
  const list = useRef<HTMLOListElement>(null)
  const field = useRef<HTMLInputElement>(null)
  const busy = asking !== null

  useEffect(() => onBusy(busy), [busy, onBusy])
  useEffect(() => () => onBusy(false), [onBusy])

  useEffect(() => {
    const box = list.current
    if (box) box.scrollTop = box.scrollHeight
  }, [map.chat.length, asking, open])

  const send = async (text: string) => {
    const said = text.trim()
    if (!said || busy) return
    setAsking(said)
    setDraft('')
    setError('')
    // The blink of the last request ends with this one.
    const base = clearHighlight(map)
    try {
      note.current ??= noteText(fileId)
      const reply = await askMap(await note.current, base, said, new GenerationSession(targetFor(settings, 'mapa', choice.model)))
      const at = nowIso()
      const asked: MapChatTurn = { who: 'você', text: said, at }
      const next = reply.diagram
        ? applyChange(base, reply.diagram, reply.changed, [asked, { who: 'ia', text: reply.answer, at, changed: reply.changed }])
        : {
            ...base,
            chat: [...base.chat, asked, { who: 'ia' as const, text: reply.answer, at }],
          }
      await useLibraryStore.getState().saveArtifact(fileId, next)
    } catch (failure) {
      // The map stays as it was, and what was typed comes back to the field.
      note.current = null
      setError(messageOf(failure))
      setDraft(current => current || said)
    } finally {
      setAsking(null)
    }
  }

  const undoHere = () =>
    void useLibraryStore
      .getState()
      .saveArtifact(fileId, undo(map))
      .catch(failure => setError(messageOf(failure)))

  const last = map.chat.length - 1
  // "Desfazer" in the answer only while that change is the one in the map: undoing or the next request ends it.
  const undoable = (turn: MapChatTurn, index: number) => index === last && turn.changed !== undefined && map.highlight !== undefined && map.versions.length > 0 && !busy

  if (layout === 'column' && !open) {
    return (
      <section className="map-chat column shut">
        {/* the whole strip opens it, not only the arrow: it reads as a tab */}
        <button className="map-chat-open" aria-label="Abrir a conversa" title="Abrir a conversa" aria-expanded={false} onClick={onToggle}>
          <span className="ibtn" aria-hidden="true">
            <Icon name="back" />
          </span>
          <span className="map-chat-strip">Conversa{map.chat.length ? ` · ${map.chat.length}` : ''}</span>
        </button>
      </section>
    )
  }

  return (
    <section className={`map-chat ${layout} ${open ? 'open' : 'shut'}`}>
      {layout === 'sheet' && (
        <button className="map-handle" aria-label={open ? 'Recolher a conversa' : 'Abrir a conversa'} aria-expanded={open} onClick={onToggle}>
          <i />
        </button>
      )}
      {(layout === 'column' || open) && (
        <div className="map-chat-head">
          <h3>{layout === 'column' ? 'Conversa do mapa' : 'Conversa'}</h3>
          <span className="faint">salva com o mapa</span>
          <span className="grow" />
          {open && actions}
          {layout === 'column' && (
            <button className="ibtn" aria-label="Recolher a conversa" title="Recolher a conversa" aria-expanded={true} onClick={onToggle}>
              <Icon name="fwd" />
            </button>
          )}
        </div>
      )}
      <ol ref={list} className="map-talk" aria-label="Conversa do mapa" aria-live="polite">
        {map.chat.map((turn, index) => (
          <li key={index} className={turn.who === 'ia' ? 'from-ia' : 'from-you'}>
            <b>{turn.who === 'ia' ? 'IA' : 'Você'}</b>
            <p>{turn.text}</p>
            {turn.changed && (
              <div className="map-change">
                <span aria-hidden="true">✦</span>
                <b>{changedText(turn.changed)}</b>
                {undoable(turn, index) && (
                  <button className="btn" aria-label="Desfazer esta mudança" onClick={undoHere}>
                    Desfazer
                  </button>
                )}
              </div>
            )}
          </li>
        ))}
        {asking !== null && (
          <li className="from-you">
            <b>Você</b>
            <p>{asking}</p>
          </li>
        )}
        {asking !== null && (
          <li className="from-ia map-thinking">
            <Icon name="sync" className="spinning" /> pensando…
          </li>
        )}
      </ol>
      {!map.chat.length && asking === null && (layout === 'column' || open) && (
        <div className="map-chat-empty">
          <p className="faint">Pergunte sobre o mapa ou a nota, ou peça uma mudança: criar, juntar, mudar ou tirar ramos.</p>
          <div className="map-starters">
            {STARTERS.map(starter => (
              <button
                key={starter}
                className="chip"
                onClick={() => {
                  setDraft(starter)
                  field.current?.focus()
                }}
              >
                {starter}
              </button>
            ))}
          </div>
        </div>
      )}
      {error && (
        <div className="banner" role="alert">
          <Icon name="warn" />
          <span>{error}</span>
        </div>
      )}
      <form
        className="map-ask"
        onSubmit={event => {
          event.preventDefault()
          void send(draft)
        }}
      >
        <input ref={field} className="input" aria-label="Pergunte ou peça uma mudança" placeholder="Pergunte ou peça uma mudança" value={draft} onChange={event => setDraft(event.target.value)} />
        <button className="btn primary" type="submit" aria-label="Enviar" title="Enviar" disabled={!draft.trim() || busy || !choice.ready}>
          {layout === 'sheet' ? <Icon name="up" /> : 'Enviar'}
        </button>
      </form>
      {(layout === 'column' || open) && (
        <div className="map-model">
          <ModelPick choice={choice} label="Modelo" />
        </div>
      )}
    </section>
  )
}
