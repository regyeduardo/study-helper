import { useEffect, useRef, useState } from 'react'

import type { TutorArtifact } from '@/types/domain'
import { noteText } from '@/components/dialogs/CardsDialog'
import GithubMarkdownView from '@/components/reader/GithubMarkdownView'
import { MediaPlayer, useMeetingMedia } from '@/components/reader/MediaPlayer'
import { momentIn } from '@/components/reader/MinutesTab'
import { usePlayback } from '@/components/reader/use-playback'
import { Dialog } from '@/components/ui/Dialog'
import { Icon } from '@/components/ui/Icon'
import { artifactsOf } from '@/lib/artifacts'
import { askChat, entryChatContext, type EntryChatContext } from '@/lib/generation/entry-chat'
import { GenerationSession } from '@/lib/generation/session'
import { momentLinks } from '@/lib/generation/moment-links'
import { askTutor, lastConversation, modeOf, recordingAbove, type TutorMode, type TutorTurn, withTurns } from '@/lib/generation/tutor'
import { useLibraryStore } from '@/stores/library'
import { useUiStore } from '@/stores/ui'

interface Recognition {
  lang: string
  interimResults: boolean
  onresult: ((event: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null
  onend: (() => void) | null
  start(): void
  stop(): void
}

function recognizer(): Recognition | null {
  const scope = window as unknown as { SpeechRecognition?: new () => Recognition; webkitSpeechRecognition?: new () => Recognition }
  const Maker = scope.SpeechRecognition ?? scope.webkitSpeechRecognition
  return Maker ? new Maker() : null
}

/**
 * `conversationId`: opens that conversation; `null`: starts a new one; absent: continues the last one.
 * `chat`: the Chat da mídia, on the entrada: reads its transcript and every note born of it, without the tutor's modes.
 */
export function TutorDialog({ fileId, conversationId, chat = false }: { fileId: string; conversationId?: string | null; chat?: boolean }) {
  const close = useUiStore(state => state.close)
  const meta = useLibraryStore(state => state.files.find(file => file.id === fileId))
  const settings = useLibraryStore(state => state.index.settings.ai)
  const [mode, setMode] = useState<TutorMode>('perguntar')
  const [turns, setTurns] = useState<TutorTurn[]>([])
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [listening, setListening] = useState(false)
  const [error, setError] = useState('')
  const note = useRef<Promise<string> | null>(null)
  // the recording the note was born from: the tutor reads it too, as context
  const heard = useRef<Promise<string> | null>(null)
  const family = useRef<Promise<EntryChatContext> | null>(null)
  const canListen = useRef(recognizer() !== null)
  const conversation = useRef<TutorArtifact | null>(null)
  // Bumps when another conversation starts: a late answer then goes only to the conversation it belongs to.
  const round = useRef(0)
  // whose media plays a moment cited in a reply: the entrada of the Chat, or the recording the note was born from
  const [owner, setOwner] = useState<string | null>(chat ? fileId : null)
  const ownerMeta = useLibraryStore(state => (owner ? (state.files.find(file => file.id === owner) ?? null) : null))
  const media = useMeetingMedia(ownerMeta)
  const playback = usePlayback(media)
  const playable = media.available

  useEffect(() => {
    let alive = true
    const library = useLibraryStore.getState()
    if (chat) {
      family.current = entryChatContext(library.files, fileId, id => library.openFile(id))
      setOwner(fileId)
    } else {
      note.current = noteText(fileId)
      const found = recordingAbove(library.files, fileId, id => library.openFile(id)).catch(() => null)
      heard.current = found.then(recording => (recording && recording.id !== fileId ? recording.transcript : ''))
      void found.then(recording => alive && setOwner(recording?.id ?? null))
    }
    const stop = () => {
      alive = false
    }
    if (conversationId === null) return stop
    void useLibraryStore
      .getState()
      .openFile(fileId)
      .then(({ sidecar }) => {
        const list = artifactsOf(sidecar)
        const last = conversationId ? (list.find((item): item is TutorArtifact => item.kind === 'tutor' && item.id === conversationId) ?? null) : lastConversation(list)
        if (!last || conversation.current || round.current) return
        conversation.current = last
        setTurns(last.turns)
        setMode(modeOf(last))
      })
    return stop
  }, [fileId, conversationId, chat])

  const keep = (talk: TutorArtifact | null, list: TutorTurn[]): TutorArtifact | null => {
    if (!list.length) return talk
    const next = withTurns(talk, list)
    void useLibraryStore
      .getState()
      .saveArtifact(fileId, next)
      .catch(failure => setError(failure instanceof Error ? failure.message : String(failure)))
    return next
  }

  const send = async (text: string, nextMode = mode, history = turns) => {
    const said = text.trim()
    const asked: TutorTurn[] = said ? [...history, { who: 'você', text: said }] : history
    const started = round.current
    const talk = (conversation.current = keep(conversation.current, asked))
    setTurns(asked)
    setDraft('')
    setBusy(true)
    setError('')
    try {
      const session = new GenerationSession(settings)
      const reply = chat && family.current ? await askChat(await family.current, asked, session) : await askTutor(await (note.current ?? noteText(fileId)), nextMode, asked, session, (await heard.current) ?? '')
      const answered: TutorTurn[] = [...asked, { who: 'tutor', text: reply }]
      const saved = keep(talk, answered)
      if (round.current !== started) return
      conversation.current = saved
      setTurns(answered)
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure))
    } finally {
      setBusy(false)
    }
  }

  const startOver = (nextMode: TutorMode) => {
    round.current++
    conversation.current = null
    setTurns([])
    if (nextMode === 'testar') void send('', nextMode, [])
  }

  const switchTo = (next: TutorMode) => {
    setMode(next)
    startOver(next)
  }

  const listen = () => {
    const recognition = recognizer()
    if (!recognition) return
    recognition.lang = 'pt-BR'
    recognition.interimResults = false
    recognition.onresult = event => void send(Array.from(event.results, result => result[0].transcript).join(' '))
    recognition.onend = () => setListening(false)
    setListening(true)
    recognition.start()
  }

  return (
    <Dialog title={`${chat ? 'Chat' : 'Tutor'}${meta ? `: ${meta.name}` : ''}`} onClose={close}>
      <div className="db tutor">
        <div className="tr-tools" style={{ justifyContent: 'flex-start' }}>
          {!chat && (
            <div className="ex-chips" role="group" aria-label="Modo do tutor">
              <button className="chip" aria-pressed={mode === 'perguntar'} onClick={() => switchTo('perguntar')}>
                Tirar dúvida
              </button>
              <button className="chip" aria-pressed={mode === 'testar'} onClick={() => switchTo('testar')}>
                Testar o que sei
              </button>
            </div>
          )}
          <button className="btn quiet" style={{ marginLeft: 'auto', height: 26 }} disabled={busy || !turns.length} onClick={() => startOver(mode)}>
            <Icon name="plus" />
            Nova conversa
          </button>
        </div>
        <ol
          className="tutor-talk"
          aria-label={chat ? 'Conversa do chat' : 'Conversa com o tutor'}
          onClick={
            playable
              ? event => {
                  const seconds = momentIn(event)
                  if (seconds === null) return
                  event.preventDefault()
                  playback.playFrom(seconds)
                }
              : undefined
          }
        >
          {turns.map((turn, index) => (
            <li key={index} className={turn.who === 'tutor' ? 'from-tutor' : 'from-you'}>
              <b>{turn.who === 'tutor' ? (chat ? 'Chat' : 'Tutor') : 'Você'}</b>
              {turn.who === 'tutor' ? <GithubMarkdownView markdown={playable ? momentLinks(turn.text) : turn.text} /> : <p>{turn.text}</p>}
            </li>
          ))}
          {busy && (
            <li className="from-tutor" role="status">
              <Icon name="sync" className="spinning" /> pensando…
            </li>
          )}
        </ol>
        {playable && <MediaPlayer player={playback.player} media={media} onTime={playback.setTime} onPlayFrom={playback.playFrom} />}
        {error && <div className="banner">{error}</div>}
        <form
          className="tutor-ask"
          onSubmit={event => {
            event.preventDefault()
            if (draft.trim() && !busy) void send(draft)
          }}
        >
          <input className="input" aria-label="Sua pergunta ou resposta" placeholder={chat ? 'Sua pergunta sobre a mídia e as notas' : mode === 'testar' ? 'Sua resposta' : 'Sua dúvida sobre a nota'} value={draft} onChange={event => setDraft(event.target.value)} />
          {canListen.current && (
            <button type="button" className="ibtn" aria-label={listening ? 'Ouvindo' : 'Falar'} aria-pressed={listening} onClick={listen}>
              <Icon name="mic" />
            </button>
          )}
          <button className="btn primary" type="submit" disabled={!draft.trim() || busy}>
            Enviar
          </button>
        </form>
      </div>
    </Dialog>
  )
}
