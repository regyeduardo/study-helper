import { useState } from 'react'

import { moveWithArrows } from '@/components/langs/cards/ListenCard'
import { Dialog } from '@/components/ui/Dialog'
import { Icon } from '@/components/ui/Icon'
import { langsMessage, reportCard, type ReportReason } from '@/controllers/langs.controller'

/** The problems one can report (the same as the server's). */
export const REASONS: [ReportReason, string][] = [
  ['two_right', 'Duas opções estão certas'],
  ['wrong_answer', 'A resposta certa está errada'],
  ['bad_audio', 'O áudio está ruim'],
  ['confusing', 'O enunciado confunde'],
  ['other', 'Outro problema'],
]

/**
 * "Reportar este card" (spec 004, wireframe C of 23/11, "mais discreto"): what is wrong, an optional note, and "Refazer o card". The
 * server makes the card again another way (the other model, with the reason); the new one comes next time, for everyone.
 */
export function ReportDialog({ code, textId, cardId, onClose, onSent }: { code: string; textId: string; cardId: string; onClose: () => void; onSent: () => void }) {
  const [reason, setReason] = useState<ReportReason | null>(null)
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const send = async () => {
    if (!reason || busy) return
    setBusy(true)
    setError(null)
    try {
      await reportCard(code, textId, cardId, { reason, note: note.trim() })
      onSent()
    } catch (failure) {
      setError(langsMessage(failure))
      setBusy(false)
    }
  }
  return (
    <Dialog
      title="Reportar este card"
      size="narrow"
      onClose={onClose}
      footer={
        <>
          <button className="btn quiet" onClick={onClose}>
            Cancelar
          </button>
          <button className="btn primary" disabled={!reason || busy} onClick={() => void send()}>
            {busy ? 'Mandando…' : 'Refazer o card'}
          </button>
        </>
      }
    >
      <div className="db lg-report">
        <div className="lg-pick" role="radiogroup" aria-label="O que está errado" onKeyDown={moveWithArrows}>
          {REASONS.map(([value, label], n) => (
            <button key={value} type="button" role="radio" aria-checked={reason === value} className="lg-pick-row lg-reason" autoFocus={n === 0} onClick={() => setReason(value)}>
              <span>{label}</span>
              {reason === value && <Icon name="check" />}
            </button>
          ))}
        </div>
        <label className="lg-report-note">
          Conte o que foi (opcional)
          <textarea className="input" rows={2} maxLength={1000} value={note} onChange={event => setNote(event.target.value)} />
        </label>
        {error && (
          <p className="lg-error" role="alert">
            {error}
          </p>
        )}
      </div>
    </Dialog>
  )
}
