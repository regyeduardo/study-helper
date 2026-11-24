import { useEffect, useState } from 'react'

import { Dialog } from '@/components/ui/Dialog'
import { addText, langsMessage } from '@/controllers/langs.controller'

/** What was typed and not sent, per language: closing the window by mistake does not lose a pasted text. */
const drafts = new Map<string, { title: string; text: string }>()

/** The biggest text one can send (the server's limit). */
export const MAX_TEXT = 100_000

/**
 * "Novo texto" (spec 004, wireframe D of 21/11): the title and the whole text. The text stays whole as it was sent; the server makes the
 * sentences and the cards from it, and the page follows while it is being made.
 */
export function NewTextDialog({ code, languageName, onClose, onSent }: { code: string; languageName: string; onClose: () => void; onSent: () => void }) {
  const [title, setTitle] = useState(() => drafts.get(code)?.title ?? '')
  const [text, setText] = useState(() => drafts.get(code)?.text ?? '')
  useEffect(() => {
    if (title || text) drafts.set(code, { title, text })
    else drafts.delete(code)
  }, [code, title, text])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const size = [...text].length
  const tooLong = size > MAX_TEXT
  const can = title.trim() !== '' && text.trim() !== '' && !tooLong && !busy
  const send = async () => {
    if (!can) return
    setBusy(true)
    setError(null)
    try {
      await addText(code, { title: title.trim(), text })
      drafts.delete(code)
      onSent()
    } catch (failure) {
      setError(langsMessage(failure))
      setBusy(false)
    }
  }
  return (
    <Dialog
      title={`Novo texto em ${languageName}`}
      onClose={onClose}
      footer={
        <>
          <button className="btn quiet" onClick={onClose}>
            Cancelar
          </button>
          <button className="btn primary" disabled={!can} onClick={() => void send()}>
            {busy ? 'Mandando…' : 'Mandar'}
          </button>
        </>
      }
    >
      <div className="db lg-newtext">
        <label>
          Título
          <input className="input" placeholder="Ex.: Música que eu gosto" maxLength={200} autoFocus value={title} onChange={event => setTitle(event.target.value)} />
        </label>
        <label>
          Texto
          <textarea className="input" rows={10} placeholder={`Cole aqui o texto em ${languageName}, inteiro.`} value={text} onChange={event => setText(event.target.value)} aria-describedby="lg-newtext-count" />
        </label>
        <p id="lg-newtext-count" className={`lg-count ${tooLong ? 'bad' : ''}`}>
          {size.toLocaleString('pt-BR')} de {MAX_TEXT.toLocaleString('pt-BR')} caracteres{tooLong ? '. Mande uma parte de cada vez.' : ''}
        </p>
        {error && (
          <p className="lg-error" role="alert">
            {error}
          </p>
        )}
      </div>
    </Dialog>
  )
}
