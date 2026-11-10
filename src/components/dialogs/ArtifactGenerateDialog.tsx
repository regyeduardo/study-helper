import { useEffect, useRef, useState } from 'react'

import type { Artifact, GenerationChoice, Settings } from '@/types/domain'
import { noteText } from '@/components/dialogs/CardsDialog'
import { MoreOptions } from '@/components/dialogs/FromNoteFields'
import { ModelPick, useModelChoice } from '@/components/dialogs/ModelPick'
import { Dialog } from '@/components/ui/Dialog'
import { Icon } from '@/components/ui/Icon'
import { aiConfigOf, modelByUid, targetFor } from '@/lib/ai/config'
import { artifactsOf, newCardsArtifact, newMapArtifact } from '@/lib/artifacts'
import { generateCards } from '@/lib/generation/cards'
import { generateMap } from '@/lib/generation/mindmap'
import { GenerationSession } from '@/lib/generation/session'
import { nowIso } from '@/lib/ids'
import { useLibraryStore } from '@/stores/library'
import { useUiStore } from '@/stores/ui'
import { shortDate } from '@/utils/format'

export type GeneratedKind = 'mapa' | 'cartoes'

const WORDS: Record<GeneratedKind, { title: string; again: string; other: string; replaced: string; busy: string; placeholder: string; empty: string }> = {
  mapa: {
    title: 'Novo mapa mental',
    again: 'Gerar de novo o mapa',
    other: 'Criar outro mapa',
    replaced: 'mesmo nome, mapa novo',
    busy: 'Desenhando o mapa da nota',
    placeholder: 'Ex.: só as decisões de preço e prazo',
    empty: 'A IA não devolveu um mapa. Tente de novo.',
  },
  cartoes: {
    title: 'Novo baralho de cartões',
    again: 'Gerar de novo o baralho',
    other: 'Criar outro baralho',
    replaced: 'mesmo nome, cartões novos',
    busy: 'Fazendo os cartões da nota',
    placeholder: 'Ex.: foque nas datas e nos nomes',
    empty: 'A IA não devolveu nenhum cartão. Tente de novo.',
  },
}

/** The name of the model an artifact was made with, while it is in "Meus modelos"; else the model id itself. */
export function madeModelName(uid: string, settings: Settings): string {
  return modelByUid(aiConfigOf(settings), uid)?.name ?? uid.replace(/^.*::/, '')
}

/** "DeepSeek V3 · em 05/11 · com instrução": how it was made the last time. */
function lastTimeLine(before: Artifact, settings: Settings): string {
  const made = before.made
  return [made?.model ? madeModelName(made.model, settings) : '', `em ${shortDate(made?.at ?? before.createdAt, settings.timezone)}`, made?.instruction ? 'com instrução' : ''].filter(Boolean).join(' · ')
}

/** "+ Novo" and "Gerar de novo" of a map or a deck: the model and the instruction; `again`: the one made before, whose choices come back. */
export function ArtifactGenerateDialog({ fileId, artifact, again }: { fileId: string; artifact: GeneratedKind; again?: string }) {
  const close = useUiStore(state => state.close)
  const sidecar = useLibraryStore(state => state.opened[fileId]?.sidecar)
  const [failed, setFailed] = useState('')
  useEffect(() => {
    if (!sidecar) void useLibraryStore.getState().openFile(fileId).catch(error => setFailed(error instanceof Error ? error.message : String(error)))
  }, [fileId, sidecar])
  if (!sidecar)
    return (
      <Dialog title={WORDS[artifact].title} size="narrow" onClose={close}>
        <div className="db">
          <span className={failed ? 'banner' : 'muted'}>{failed || 'Abrindo…'}</span>
        </div>
      </Dialog>
    )
  // the choices of the last time fill the fields when the window opens
  const before = again ? artifactsOf(sidecar).find(item => item.id === again && item.kind === artifact) : undefined
  return <GenerateForm fileId={fileId} artifact={artifact} before={before} />
}

function GenerateForm({ fileId, artifact, before }: { fileId: string; artifact: GeneratedKind; before?: Artifact }) {
  const close = useUiStore(state => state.close)
  const open = useUiStore(state => state.open)
  const toast = useUiStore(state => state.toast)
  const note = useLibraryStore(state => state.files.find(file => file.id === fileId))
  const settings = useLibraryStore(state => state.index.settings)
  const lastModel = before?.made?.model
  const choice = useModelChoice(artifact, false, lastModel && modelByUid(aiConfigOf(settings), lastModel) ? { pick: lastModel } : {})
  const [instruction, setInstruction] = useState(before?.made?.instruction ?? '')
  const [replace, setReplace] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const alive = useRef(true)
  // StrictMode (dev) runs mount, cleanup, mount: the flag has to come back on
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])
  const words = WORDS[artifact]
  const talk = before?.kind === 'mapa' ? before.chat.length : 0

  const start = async () => {
    setBusy(true)
    setError('')
    try {
      const said = instruction.trim()
      const made: GenerationChoice = { ...(choice.model ? { model: choice.model } : {}), ...(said ? { instruction: said } : {}), at: nowIso() }
      const session = new GenerationSession(targetFor(settings, artifact, choice.model))
      const content = await noteText(fileId)
      // "Substituir este": same name, unless it still has the placeholder
      const kept = replace && before && !before.provisionalName ? before.name : null
      let next: Artifact
      if (artifact === 'mapa') {
        const map = await generateMap(content, session, said)
        if (!map) throw new Error(words.empty)
        next = newMapArtifact({ name: kept ?? map.name, diagram: map.diagram, made })
      } else {
        const deck = await generateCards(content, session, said)
        if (!deck.cards.length) throw new Error(words.empty)
        next = newCardsArtifact({ name: kept ?? deck.name, cards: deck.cards, made })
      }
      const saved = await useLibraryStore.getState().saveArtifact(fileId, next, replace && before ? before.id : undefined)
      if (!alive.current) return toast(`“${saved.name}” ficou pronto`)
      open(artifact === 'mapa' ? { kind: 'mindmap', fileId, artifactId: saved.id } : { kind: 'cards', fileId, deckId: saved.id })
    } catch (failure) {
      const reason = failure instanceof Error ? failure.message : String(failure)
      if (alive.current) setError(reason)
      else toast(reason)
    } finally {
      if (alive.current) setBusy(false)
    }
  }

  return (
    <Dialog
      title={before ? words.again : words.title}
      size="narrow"
      onClose={close}
      footer={
        <>
          <button className="btn quiet" onClick={close}>
            Cancelar
          </button>
          <button className="btn primary" disabled={!choice.ready || busy} onClick={() => void start()}>
            Gerar
          </button>
        </>
      }
    >
      <div className="db">
        {before ? (
          <div>
            <p className="muted" style={{ margin: 0 }}>
              {`“${before.name}”, de “${note?.name ?? ''}”`}
            </p>
            <p className="muted" style={{ margin: '2px 0 0', fontSize: 12.5 }}>
              {`Da última vez: ${lastTimeLine(before, settings)}`}
            </p>
          </div>
        ) : (
          note && (
            <p className="muted" style={{ margin: 0 }}>
              {`De “${note.name}”`}
            </p>
          )
        )}
        <ModelPick choice={choice} />
        <MoreOptions instruction={instruction} onInstruction={setInstruction} placeholder={words.placeholder} open={Boolean(before?.made?.instruction)} />
        {before ? (
          <div className="field">
            <span className="lab">O que fazer com o resultado</span>
            <div className="opts cols2" role="radiogroup" aria-label="O que fazer com o resultado">
              {[false, true].map(option => (
                <button key={String(option)} className="opt" role="radio" aria-checked={replace === option} onClick={() => setReplace(option)}>
                  <span className="radio" />
                  <span>
                    <b>{option ? 'Substituir este' : words.other}</b>
                    <span>{option ? words.replaced : 'este fica; o novo entra na lista'}</span>
                  </span>
                </button>
              ))}
            </div>
          </div>
        ) : (
          <span className="muted" style={{ fontSize: 12.5 }}>
            O nome sai da IA quando terminar; dá para renomear depois.
          </span>
        )}
        {replace && talk > 0 && (
          <div className="banner" role="alert">
            <Icon name="warn" />
            <span>{`A conversa deste mapa (${talk} ${talk === 1 ? 'mensagem' : 'mensagens'}) será apagada ao gerar. O mapa novo começa com a conversa vazia.`}</span>
          </div>
        )}
        {error && <div className="banner">{error}</div>}
        {busy && (
          <div className="reader-live" role="status" style={{ marginBottom: 0 }}>
            <Icon name="sync" className="spinning" />
            <span>{words.busy}…</span>
          </div>
        )}
      </div>
    </Dialog>
  )
}
