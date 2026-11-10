import { useEffect, useState } from 'react'

import type { CardsArtifact } from '@/types/domain'
import { MoreOptions } from '@/components/dialogs/FromNoteFields'
import { ModelPick, useModelChoice } from '@/components/dialogs/ModelPick'
import { Dialog } from '@/components/ui/Dialog'
import { Icon } from '@/components/ui/Icon'
import { targetFor } from '@/lib/ai/config'
import { artifactsOf, decksOf, newCardsArtifact } from '@/lib/artifacts'
import { generateCards, reviewed, today } from '@/lib/generation/cards'
import { GenerationSession } from '@/lib/generation/session'
import { nowIso } from '@/lib/ids'
import { transcriptText } from '@/lib/transcription/export'
import { useLibraryStore } from '@/stores/library'
import { useUiStore } from '@/stores/ui'

export async function noteText(fileId: string): Promise<string> {
  const { content, sidecar } = await useLibraryStore.getState().openFile(fileId)
  return sidecar.recording?.blocks.length ? transcriptText(sidecar.recording) : content
}

/** Without `deckId` it reviews the due cards of every deck of the note ("Revisar"); with it, only that deck. */
export function CardsDialog({ fileId, deckId }: { fileId: string; deckId?: string }) {
  const close = useUiStore(state => state.close)
  const meta = useLibraryStore(state => state.files.find(file => file.id === fileId))
  const settings = useLibraryStore(state => state.index.settings)
  const choice = useModelChoice('cartoes')
  const [decks, setDecks] = useState<CardsArtifact[] | null>(null)
  const [only, setOnly] = useState(deckId)
  const [queue, setQueue] = useState<string[]>([])
  const [showing, setShowing] = useState(false)
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const [done, setDone] = useState(0)
  const [instruction, setInstruction] = useState('')

  const start = (all: CardsArtifact[], deck = only) => {
    setDecks(all)
    setOnly(deck)
    setQueue(
      decksOf(all, deck)
        .flatMap(item => item.cards)
        .filter(card => card.due <= today())
        .map(card => card.id),
    )
    setShowing(false)
  }

  useEffect(() => {
    void useLibraryStore
      .getState()
      .openFile(fileId)
      .then(({ sidecar }) => start(decksOf(artifactsOf(sidecar))))
  }, [fileId])

  const make = async () => {
    setBusy('Fazendo os cartões da nota')
    setError('')
    try {
      const said = instruction.trim()
      const made = await generateCards(await noteText(fileId), new GenerationSession(targetFor(settings, 'cartoes', choice.model)), said)
      if (!made.cards.length) throw new Error('A IA não devolveu nenhum cartão. Tente de novo.')
      const deck = newCardsArtifact({ name: made.name, cards: made.cards, made: { ...(choice.model ? { model: choice.model } : {}), ...(said ? { instruction: said } : {}), at: nowIso() } })
      await useLibraryStore.getState().saveArtifact(fileId, deck)
      start([...(decks ?? []), deck], deck.id)
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure))
    } finally {
      setBusy('')
    }
  }

  const answer = async (right: boolean) => {
    const id = queue[0]
    const deck = decks?.find(item => item.cards.some(card => card.id === id))
    if (!decks || !deck) return
    const next = { ...deck, cards: deck.cards.map(card => (card.id === id ? reviewed(card, right) : card)) }
    setDecks(decks.map(item => (item.id === deck.id ? next : item)))
    setQueue(right ? queue.slice(1) : [...queue.slice(1), id])
    setShowing(false)
    setDone(count => count + (right ? 1 : 0))
    await useLibraryStore.getState().saveArtifact(fileId, next)
  }

  const cards = decks && decksOf(decks, only).flatMap(item => item.cards)
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
            <ModelPick choice={choice} />
            <MoreOptions instruction={instruction} onInstruction={setInstruction} placeholder="Ex.: foque nas datas e nos nomes" />
            <button className="btn primary" disabled={!choice.ready} onClick={() => void make()}>
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
            <button className="btn quiet" onClick={() => useUiStore.getState().open({ kind: 'generate-artifact', fileId, artifact: 'cartoes' })}>
              Fazer outro baralho
            </button>
          </div>
        )}
      </div>
    </Dialog>
  )
}
