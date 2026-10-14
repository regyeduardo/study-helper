import { useEffect, useState } from 'react'

import type { StudyCard } from '@/types/domain'
import { Dialog } from '@/components/ui/Dialog'
import { Icon } from '@/components/ui/Icon'
import { generateCards, reviewed, today } from '@/lib/generation/cards'
import { GenerationSession } from '@/lib/generation/session'
import { transcriptText } from '@/lib/transcription/export'
import { useLibraryStore } from '@/stores/library'
import { useUiStore } from '@/stores/ui'

export async function noteText(fileId: string): Promise<string> {
  const { content, sidecar } = await useLibraryStore.getState().openFile(fileId)
  return sidecar.recording?.blocks.length ? transcriptText(sidecar.recording) : content
}

async function saveCards(fileId: string, cards: StudyCard[]): Promise<void> {
  const library = useLibraryStore.getState()
  await library.updateSidecar(fileId, sidecar => ({ ...sidecar, cards }))
  await library.updateFile(fileId, { cardDue: cards.map(card => card.due) })
}

export function CardsDialog({ fileId }: { fileId: string }) {
  const close = useUiStore(state => state.close)
  const meta = useLibraryStore(state => state.files.find(file => file.id === fileId))
  const settings = useLibraryStore(state => state.index.settings.ai)
  const [cards, setCards] = useState<StudyCard[] | null>(null)
  const [queue, setQueue] = useState<string[]>([])
  const [showing, setShowing] = useState(false)
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const [done, setDone] = useState(0)

  const start = (list: StudyCard[]) => {
    setCards(list)
    setQueue(list.filter(card => card.due <= today()).map(card => card.id))
    setShowing(false)
  }

  useEffect(() => {
    void useLibraryStore
      .getState()
      .openFile(fileId)
      .then(({ sidecar }) => start(sidecar.cards ?? []))
  }, [fileId])

  const make = async () => {
    setBusy('Fazendo os cartões da nota')
    setError('')
    try {
      const made = await generateCards(await noteText(fileId), new GenerationSession(settings))
      if (!made.length) throw new Error('A IA não devolveu nenhum cartão. Tente de novo.')
      await saveCards(fileId, made)
      start(made)
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure))
    } finally {
      setBusy('')
    }
  }

  const answer = async (right: boolean) => {
    if (!cards) return
    const id = queue[0]
    const next = cards.map(card => (card.id === id ? reviewed(card, right) : card))
    setCards(next)
    setQueue(right ? queue.slice(1) : [...queue.slice(1), id])
    setShowing(false)
    setDone(count => count + (right ? 1 : 0))
    await saveCards(fileId, next)
  }

  const current = cards?.find(card => card.id === queue[0])
  return (
    <Dialog title={`Cartões${meta ? `: ${meta.name}` : ''}`} size="narrow" onClose={close}>
      <div className="db cards">
        {error && <div className="banner">{error}</div>}
        {busy ? (
          <div className="reader-live" role="status">
            <Icon name="sync" className="spinning" />
            <span>{busy}…</span>
          </div>
        ) : cards === null ? (
          <div className="muted">Abrindo…</div>
        ) : !cards.length ? (
          <div className="cards-empty">
            <p>Esta nota ainda não tem cartões.</p>
            <button className="btn primary" onClick={() => void make()}>
              Fazer os cartões
            </button>
          </div>
        ) : current ? (
          <>
            <div className="muted" role="status">
              {queue.length} para hoje · {cards.length} cartões
            </div>
            <div className="card-face" aria-label="Cartão">
              <b>{current.front}</b>
              {showing && <p>{current.back}</p>}
            </div>
            {showing ? (
              <div className="tr-tools">
                <button className="btn" onClick={() => void answer(false)}>
                  Errei
                </button>
                <button className="btn primary" onClick={() => void answer(true)}>
                  Acertei
                </button>
              </div>
            ) : (
              <button className="btn primary" onClick={() => setShowing(true)}>
                Mostrar a resposta
              </button>
            )}
          </>
        ) : (
          <div className="cards-empty" role="status">
            <p>{done ? `Pronto por hoje: ${done} revisados.` : 'Nada para revisar hoje.'}</p>
            <p className="muted">
              {cards.length} cartões · próximos em {[...new Set(cards.map(card => card.due))].sort()[0] ?? '—'}
            </p>
            <button className="btn quiet" onClick={() => void make()}>
              Fazer os cartões de novo
            </button>
          </div>
        )}
      </div>
    </Dialog>
  )
}
