import { useEffect, useMemo, useRef, useState } from 'react'

import type { TutorArtifact, TutorScope } from '@/types/domain'
import { ChatConversations } from '@/components/dialogs/ChatConversations'
import { noteText } from '@/components/dialogs/CardsDialog'
import GithubMarkdownView from '@/components/reader/GithubMarkdownView'
import { MediaPlayer, useMeetingMedia } from '@/components/reader/MediaPlayer'
import { momentIn } from '@/components/reader/MinutesTab'
import { usePlayback } from '@/components/reader/use-playback'
import { OpeningWait } from '@/components/ui/OpeningWait'
import { Dialog } from '@/components/ui/Dialog'
import { Icon } from '@/components/ui/Icon'
import { artifactsOf } from '@/lib/artifacts'
import { blocking } from '@/lib/blocking'
import { unheld } from '@/lib/working'
import { askChat, entryChatContext, type EntryChatContext } from '@/lib/generation/entry-chat'
import { GenerationSession } from '@/lib/generation/session'
import { momentLinks, momentPieces } from '@/lib/generation/moment-links'
import { askTutor, conversationsOf, lastConversation, modeOf, recordingAbove, type TutorMode, type TutorTurn, withTurns } from '@/lib/generation/tutor'
import { clockTime } from '@/lib/transcription/export'
import { useLibraryStore } from '@/stores/library'
import { useUiStore } from '@/stores/ui'
import '@/styles/entry-chat.css'
import { isSourceNote } from '@/lib/file-types'

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

/** What the person said: a time typed in it ("volta no 01:40") plays that moment, like the one in a reply. */
function YourWords({ text, limit }: { text: string; limit?: number }) {
  return (
    <p>
      {momentPieces(text, limit).map((piece, index) =>
        typeof piece === 'string' ? (
          piece
        ) : (
          <a key={index} className="moment" href={`#t=${piece.at}`} title={`Tocar a partir de ${clockTime(piece.at)}`}>
            ▸{' '}
            {clockTime(piece.at)}
          </a>
        ),
      )}
    </p>
  )
}

/**
 * `conversationId`: opens that conversation; `null`: starts a new one; absent: continues the last one.
 * `chat`: the Chat da mídia, on the entrada: reads its transcript and every note born of it, without the tutor's modes;
 * it lists the entrada's conversations (open, rename, delete) and, for a video, keeps the player beside the conversation.
 */
export function TutorDialog({ fileId, conversationId, chat = false }: { fileId: string; conversationId?: string | null; chat?: boolean }) {
  const close = useUiStore(state => state.close)
  const meta = useLibraryStore(state => state.files.find(file => file.id === fileId))
  const settings = useLibraryStore(state => state.index.settings.ai)
  const timezone = useLibraryStore(state => state.index.settings.timezone)
  const sidecar = useLibraryStore(state => state.opened[fileId]?.sidecar)
  const scope: TutorScope = chat ? 'chat' : 'tutor'
  const onEntry = Boolean(meta && isSourceNote(meta))
  const [mode, setMode] = useState<TutorMode>('perguntar')
  const [turns, setTurns] = useState<TutorTurn[]>([])
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [listening, setListening] = useState(false)
  const [error, setError] = useState('')
  // the Chat's list of conversations takes the place of the conversation while it is open
  const [listing, setListing] = useState(false)
  const [currentId, setCurrentId] = useState<string | null>(null)
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
  // a video of the Chat sits beside the conversation; an audio stays the bar under it
  const split = chat && playable && media.video
  // how long the media is: what the player reports once it loads, before that what the library kept of it
  const kept = useLibraryStore(state => (owner ? state.localMedia.find(item => item.fileIds.includes(owner))?.durationSeconds : undefined) || ownerMeta?.origin?.durationSeconds || undefined)
  const [loadedLength, setLoadedLength] = useState<number | null>(null)
  const length = loadedLength ?? kept
  // T194: a conversation renamed shows its new name at once while it is saved, without holding the app; a failure puts the old one back
  const [renamed, setRenamed] = useState<Record<string, string>>({})
  const conversations = useMemo(
    () => (sidecar ? conversationsOf(artifactsOf(sidecar), scope, onEntry) : []).map(item => (renamed[item.id] ? { ...item, name: renamed[item.id] } : item)),
    [sidecar, scope, onEntry, renamed],
  )

  useEffect(() => {
    const element = playback.player.current
    if (!element) return
    const sync = () => setLoadedLength(Number.isFinite(element.duration) && element.duration > 0 ? element.duration : null)
    sync()
    element.addEventListener('durationchange', sync)
    return () => element.removeEventListener('durationchange', sync)
  }, [playable, media.video, media.url, playback.player])

  const adopt = (talk: TutorArtifact | null) => {
    conversation.current = talk
    setCurrentId(talk?.id ?? null)
    return talk
  }

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
        const last = conversationId ? (list.find((item): item is TutorArtifact => item.kind === 'tutor' && item.id === conversationId) ?? null) : lastConversation(list, scope, onEntry)
        if (!last || conversation.current || round.current) return
        adopt(last)
        setTurns(last.turns)
        setMode(modeOf(last))
      })
    return stop
  }, [fileId, conversationId, chat, scope, onEntry])

  const fail = (failure: unknown) => setError(failure instanceof Error ? failure.message : String(failure))

  const keep = (talk: TutorArtifact | null, list: TutorTurn[]): TutorArtifact | null => {
    if (!list.length) return talk
    const next = withTurns(talk, list, scope)
    void useLibraryStore.getState().saveArtifact(fileId, next).catch(fail)
    return next
  }

  const send = async (text: string, nextMode = mode, history = turns) => {
    const said = text.trim()
    const asked: TutorTurn[] = said ? [...history, { who: 'você', text: said }] : history
    const started = round.current
    const talk = adopt(keep(conversation.current, asked))
    setTurns(asked)
    setDraft('')
    setBusy(true)
    setError('')
    try {
      const session = new GenerationSession(settings)
      const reply = chat && family.current ? await askChat(await family.current, asked, session) : await askTutor(await (note.current ?? noteText(fileId)), nextMode, asked, session, (await heard.current) ?? '')
      const answered: TutorTurn[] = [...asked, { who: 'tutor', text: reply }]
      // renamed while the answer was coming: the name now is the one that stays
      const latest = conversation.current && conversation.current.id === talk?.id ? conversation.current : talk
      const saved = keep(latest, answered)
      if (round.current !== started) return
      adopt(saved)
      setTurns(answered)
    } catch (failure) {
      fail(failure)
    } finally {
      setBusy(false)
    }
  }

  /** Leaves the conversation: the next question starts another. Deleting from the list keeps the list open. */
  const leave = (keepList = false) => {
    round.current++
    adopt(null)
    setTurns([])
    if (!keepList) setListing(false)
    setError('')
  }

  const startOver = (nextMode: TutorMode) => {
    leave()
    if (nextMode === 'testar') void send('', nextMode, [])
  }

  const switchTo = (next: TutorMode) => {
    setMode(next)
    startOver(next)
  }

  const openConversation = (id: string) => {
    const found = conversations.find(item => item.id === id)
    if (!found) return
    if (found.id !== currentId) {
      round.current++
      adopt(found)
      setTurns(found.turns)
      setMode(modeOf(found))
      setError('')
    }
    setListing(false)
  }

  const renameConversation = (id: string, name: string) => {
    const said = name.trim()
    if (!said) return
    const before = conversations.find(item => item.id === id)?.name ?? said
    setRenamed(names => ({ ...names, [id]: said }))
    void unheld(`Renomeando “${before}”…`, () => useLibraryStore.getState().renameArtifact(fileId, id, said), { failed: `Não deu para renomear “${before}”` }).then(() =>
      setRenamed(({ [id]: _done, ...rest }) => rest),
    )
    // the open one is kept in memory: it must not save the old name again with the next message
    if (conversation.current?.id === id) conversation.current = { ...conversation.current, name: said, provisionalName: false }
  }

  const deleteConversation = (id: string) => {
    const name = conversations.find(item => item.id === id)?.name
    void blocking(name ? `Apagando “${name}”…` : 'Apagando a conversa…', () => useLibraryStore.getState().deleteArtifact(fileId, id))
      .then(() => {
        if (conversation.current?.id === id) leave(true)
      })
      .catch(fail)
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

  const player = playable && <MediaPlayer player={playback.player} media={media} onTime={playback.setTime} onPlayFrom={playback.playFrom} docked={split} />
  const nowName = conversations.find(item => item.id === currentId)?.name ?? ''

  return (
    <Dialog title={`${chat ? 'Chat' : 'Tutor'}${meta ? `: ${meta.name}` : ''}`} onClose={close} style={split ? { width: 'min(1200px, 100%)' } : undefined}>
      <div className={split ? 'db tutor tutor-split' : 'db tutor'}>
        {split && <div className="tutor-media">{player}</div>}
        <div className="tutor-chat">
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
            {chat && (
              <>
                <button className="btn quiet chat-lists" style={{ height: 26 }} aria-expanded={listing} onClick={() => setListing(!listing)}>
                  <Icon name="chat" />
                  Conversas
                  <span className="chat-count">{conversations.length}</span>
                </button>
                {nowName && !listing && (
                  <span className="chat-now faint" title={nowName}>
                    {nowName}
                  </span>
                )}
              </>
            )}
            <button className="btn quiet" style={{ marginLeft: 'auto', height: 26 }} disabled={busy || (!turns.length && !listing)} onClick={() => startOver(mode)}>
              <Icon name="plus" />
              Nova conversa
            </button>
          </div>
          {chat && listing ? (
            <ChatConversations items={conversations} currentId={currentId} busy={busy} timezone={timezone} onOpen={openConversation} onRename={renameConversation} onDelete={deleteConversation} />
          ) : (
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
                  {turn.who === 'tutor' ? <GithubMarkdownView markdown={playable ? momentLinks(turn.text, length) : turn.text} /> : playable ? <YourWords text={turn.text} limit={length} /> : <p>{turn.text}</p>}
                </li>
              ))}
              {busy && (
                <li className="from-tutor">
                  {/* spec 007 (FR-060): what happens, when it should end by the last answers, and that it did not freeze */}
                  <OpeningWait kind="conversa" what="Pensando na resposta" history="respostas" />
                </li>
              )}
            </ol>
          )}
          {!split && player}
          {error && <div className="banner">{error}</div>}
          {!(chat && listing) && (
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
          )}
        </div>
      </div>
    </Dialog>
  )
}
