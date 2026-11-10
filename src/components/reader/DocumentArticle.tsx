import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'

import type { FileMeta, FileSidecar, FileType, HighlightColor, RecordingMark } from '@/types/domain'
import { SaveToDrive } from '@/components/library/SaveToDrive'
import { SharedBadge } from '@/components/library/SharedBadge'
import { Icon } from '@/components/ui/Icon'
import { MasteryMeter, MotherBadge, TypeDot } from '@/components/library/Badges'
import { DocumentNav } from '@/components/reader/DocumentNav'
import GithubMarkdownView, { type PaintedQuote, type ReaderSelection } from '@/components/reader/GithubMarkdownView'
import { MediaPlayer, type MeetingMedia, playAt, useMeetingMedia } from '@/components/reader/MediaPlayer'
import { MeetingTabs } from '@/components/reader/MeetingTabs'
import { MinutesTab } from '@/components/reader/MinutesTab'
import { TagSuggestion } from '@/components/reader/TagSuggestion'
import { useDocument } from '@/hooks/use-document'
import { withImages } from '@/lib/generation/ata'
import { forReading } from '@/lib/generation/ata-reading'
import { courseOf } from '@/lib/generation/course-lesson'
import { usePathName } from '@/hooks/use-library-view'
import { MEDIA_LABEL, mediaOf } from '@/lib/file-types'
import { newId, nowIso } from '@/lib/ids'
import { paths } from '@/lib/paths'
import { transcriptText } from '@/lib/transcription/export'
import { renameInText, renameSpeaker, withRecorder } from '@/lib/transcription/turns'
import { recorderName, useAccountStore } from '@/stores/account'
import { type Heading, useDocumentStore } from '@/stores/document'
import { useJobsStore } from '@/stores/jobs'
import { useLibraryStore } from '@/stores/library'
import { useUiStore } from '@/stores/ui'

const ORIGIN_LABEL: Record<string, string> = {
  file: 'Arquivo',
  url: 'Link',
  youtube: 'YouTube',
  topic: 'Tema',
  text: 'Texto',
  recording: 'Gravação',
  import: 'Importado',
}

const SECOND_TAB: Partial<Record<FileType, string>> = { meeting: 'Ata', class: 'Aula' }

function MediaOnly({ media, onTranscribe }: { media: MeetingMedia; onTranscribe?(): void }) {
  const player = useRef<HTMLMediaElement | null>(null)
  const play = (seconds: number) => {
    const element = player.current
    if (!media.url || !element) return void media.request()
    playAt(element, seconds)
  }
  return (
    <div className="media-only">
      {media.available ? <MediaPlayer player={player} media={media} onTime={() => undefined} onPlayFrom={play} /> : <div className="banner">{media.notice ?? 'A mídia desta nota não está mais guardada.'}</div>}
      {onTranscribe && media.available && (
        <div className="media-only-act">
          <button className="btn primary" onClick={onTranscribe}>
            <Icon name="mic" />
            Transcrever agora
          </button>
          <span className="muted">necessário para gerar Ata e Aula e para a busca achar o que foi dito</span>
        </div>
      )}
    </div>
  )
}

/** A note made from a recording: its minute links play that recording here, in its own player. */
function SourceMinutes({ media, children }: { media: MeetingMedia; children: ReactNode }) {
  const player = useRef<HTMLMediaElement | null>(null)
  const [waiting, setWaiting] = useState<number | null>(null)
  const playFrom = (seconds: number) => {
    if (media.url && player.current) return playAt(player.current, seconds)
    setWaiting(seconds)
    void media.request()
  }
  useEffect(() => {
    if (waiting === null || !media.url || !player.current) return
    setWaiting(null)
    playAt(player.current, waiting)
  }, [waiting, media.url])
  return (
    <div className="meeting">
      <MinutesTab onMoment={playFrom}>{children}</MinutesTab>
      <div className="meeting-dock">
        <MediaPlayer player={player} media={media} onTime={() => undefined} onPlayFrom={playFrom} />
      </div>
    </div>
  )
}

/** The Ata in the "Ata" tab of a meeting note: while the tab is on screen its headings are the Índice, and they leave with it. */
function AtaTab({ markdown, onHeadings }: { markdown: string; onHeadings(headings: Heading[]): void }) {
  useEffect(() => () => onHeadings([]), [onHeadings])
  return <GithubMarkdownView markdown={markdown} onHeadings={onHeadings} />
}

function shortLength(seconds: number): string {
  const minutes = Math.round(seconds / 60)
  if (seconds < 60) return `${Math.round(seconds)} s`
  return minutes >= 60 ? `${Math.floor(minutes / 60)} h ${String(minutes % 60).padStart(2, '0')}` : `${minutes} min`
}

function mediaLine(meta: FileMeta, transcribed: boolean, timeZone: string): string {
  const media = mediaOf(meta)
  const seconds = meta.origin?.durationSeconds
  const when = new Date(meta.created.at).toLocaleString('pt-BR', { timeZone, day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }).replace(',', ' às')
  return [MEDIA_LABEL[media], seconds ? shortLength(seconds) : '', `${meta.origin?.input === 'recording' ? 'gravado' : 'enviado'} em ${when}`, transcribed ? 'com transcrição' : 'sem transcrição'].filter(Boolean).join(' · ')
}

export function DocumentHead({ meta, onInfo, transcribed = false }: { meta: FileMeta; onInfo(): void; transcribed?: boolean }) {
  const navigate = useNavigate()
  const pathName = usePathName()
  const setTag = useUiStore(state => state.setTag)
  const shared = useLibraryStore(state => Boolean(state.sharedView))
  const timeZone = useLibraryStore(state => state.index.settings.timezone)
  const source = useLibraryStore(state => (meta.parentFileId ? state.files.find(file => file.id === meta.parentFileId && !file.deletedAt) : undefined))
  return (
    <div className="doc-head">
      <h1>{meta.name}</h1>
      <SharedBadge />
      {mediaOf(meta) !== 'text' && <div className="doc-media muted">{mediaLine(meta, transcribed, timeZone)}</div>}
      {source && SECOND_TAB[meta.type] && (
        <div className="doc-media muted">
          Texto · modelo {SECOND_TAB[meta.type]} · gerado de <button onClick={() => navigate(paths.file(source.id))}>{source.name}</button>
          {meta.readingMinutes > 0 ? ` · ${meta.readingMinutes} min de leitura` : ''}
        </div>
      )}
      <div className="doc-meta">
        <MotherBadge file={meta} />
        <TypeDot type={meta.type} />
        {!(shared && meta.folderId === null) && (
          <button onClick={() => navigate(paths.folder(meta.folderId))}>
            <Icon name="folder" /> {pathName(meta.folderId)}
          </button>
        )}
        {meta.readingMinutes > 0 && (
          <span>
            <Icon name="clock" /> {meta.readingMinutes} min de leitura
          </span>
        )}
        <MasteryMeter value={meta.mastery} />
        {meta.origin && <button onClick={onInfo}>Origem: {ORIGIN_LABEL[meta.origin.input] ?? meta.origin.input}</button>}
        {meta.tags.map(tag => (
          <button
            key={tag}
            className="tag"
            style={{ textDecoration: 'none' }}
            onClick={() => {
              setTag(tag)
              navigate(paths.library)
            }}
          >
            {tag}
          </button>
        ))}
      </div>
      <SaveToDrive fileId={meta.id} />
    </div>
  )
}

interface SelectionPopoverProps {
  fileId: string
  selection: ReaderSelection
  onDone(): void
}

function SelectionPopover({ fileId, selection, onDone }: SelectionPopoverProps) {
  const saveHighlight = useLibraryStore(state => state.saveHighlight)
  const ui = useUiStore()
  const highlight = async (color: HighlightColor, kind: 'highlight' | 'note') => {
    const at = nowIso()
    await saveHighlight(fileId, { id: newId(), kind, quote: selection.text, text: '', color, startOffset: null, endOffset: null, createdAt: at, updatedAt: at })
    onDone()
    if (kind === 'note') ui.set({ inspectorTab: 'notes', rightOpen: true, columnsSheet: true, focusPop: 'notes' })
    else ui.toast('Destacado')
  }
  // On touch the browser's own menu sits above the selection, so the bar goes below it, past the handles.
  const touch = window.matchMedia?.('(pointer: coarse)').matches
  const top = touch ? Math.min(selection.rect.bottom + 28, window.innerHeight - 48) : Math.max(8, selection.rect.top - 44)
  const left = Math.max(8, Math.min(selection.rect.left, window.innerWidth - 360))
  return (
    <div className="sel-pop" role="toolbar" aria-label="Trecho selecionado" style={{ top, left }} onMouseDown={event => event.preventDefault()}>
      {(['yellow', 'green', 'pink'] as HighlightColor[]).map(color => (
        <button key={color} onClick={() => void highlight(color, 'highlight')} aria-label={`Destacar em ${color === 'yellow' ? 'amarelo' : color === 'green' ? 'verde' : 'rosa'}`}>
          <span style={{ width: 10, height: 10, borderRadius: 5, background: color === 'yellow' ? '#f5d34f' : color === 'green' ? '#3fb950' : '#f78ab0' }} />
          {color === 'yellow' ? 'Destacar' : ''}
        </button>
      ))}
      <button onClick={() => void highlight('yellow', 'note')}>
        <Icon name="note" />
        Nota
      </button>
      <button
        onClick={() => {
          ui.open({ kind: 'explain', fileId, excerpt: selection.text })
          onDone()
        }}
      >
        <Icon name="bulb" />
        Explicar isto
      </button>
    </div>
  )
}

function HeadingExplain({ fileId, heading, onDone }: { fileId: string; heading: ReaderSelection; onDone(): void }) {
  const open = useUiStore(state => state.open)
  useEffect(() => {
    window.addEventListener('scroll', onDone, { capture: true, once: true })
    return () => window.removeEventListener('scroll', onDone, { capture: true })
  }, [heading, onDone])
  return (
    <button
      className="heading-explain"
      title="Explicar esta seção"
      aria-label="Explicar esta seção"
      style={{ top: heading.rect.top + heading.rect.height / 2 - 15, left: heading.rect.left >= 40 ? heading.rect.left - 36 : Math.min(window.innerWidth - 34, heading.rect.right - 30) }}
      onMouseDown={event => event.preventDefault()}
      onClick={() => {
        open({ kind: 'explain', fileId, excerpt: heading.text })
        onDone()
      }}
    >
      <Icon name="bulb" />
    </button>
  )
}

export function DocumentBody({ fileId, compact = false }: { fileId: string; compact?: boolean }) {
  const { meta, opened, error } = useDocument(fileId)
  const live = useJobsStore(state => state.live[fileId])
  const job = useJobsStore(state => state.jobs.find(item => item.fileId === fileId && item.status === 'running'))
  const cancel = useJobsStore(state => state.cancel)
  const generatePending = useJobsStore(state => state.generatePending)
  const search = new URLSearchParams(useLocation().search)
  const asked = Number(search.get('t'))
  // the words of the search that opened the note (FR-074)
  const found = search.get('busca')
  const startAt = Number.isFinite(asked) && asked > 0 ? asked : undefined
  const redoTranscript = useJobsStore(state => state.redoTranscript)
  const updateSidecar = useLibraryStore(state => state.updateSidecar)
  const saveContent = useLibraryStore(state => state.saveContent)
  const media = useMeetingMedia(meta)
  const source = useLibraryStore(state => (meta?.parentFileId ? state.files.find(file => file.id === meta.parentFileId && !file.deletedAt) : undefined))
  const sourceMedia = useMeetingMedia(source && mediaOf(source) !== 'text' ? source : null)
  const files = useLibraryStore(state => state.files)
  const setHeadings = useDocumentStore(state => state.setHeadings)
  const folders = useLibraryStore(state => state.folders)
  const ui = useUiStore()
  const navigate = useNavigate()
  const [selection, setSelection] = useState<ReaderSelection | null>(null)
  const [heading, setHeading] = useState<ReaderSelection | null>(null)

  const quotes = useMemo<PaintedQuote[]>(() => {
    const painted: PaintedQuote[] = (opened?.sidecar.highlights ?? []).map(item => ({ quote: item.quote, color: item.color ?? 'yellow' }))
    for (const child of files.filter(file => file.parentFileId === fileId && file.sourceExcerpt && !file.deletedAt)) painted.push({ quote: child.sourceExcerpt!, color: 'explained', targetId: child.id })
    return painted
  }, [opened?.sidecar.highlights, files, fileId])

  const handoff = ui.handoffFileId === fileId
  const showing = Boolean(job || opened)
  useEffect(() => {
    if (!handoff || !showing) return
    ui.set({ handoffFileId: null })
    ui.close()
  }, [handoff, showing])

  const onHeadings = useCallback((headings: { id: string; level: number; text: string }[]) => setHeadings(fileId, headings), [fileId, setHeadings])
  const onQuoteClick = useCallback((targetId: string) => navigate(paths.file(targetId)), [navigate])

  if (!meta) return <div className="empty">Arquivo não encontrado.</div>
  const showInfo = () => ui.set({ inspectorTab: 'info', rightOpen: true, panelAsked: true, columnsSheet: true, focusPop: 'info' })
  const readOnly = Boolean(useLibraryStore.getState().sharedView)

  const recording = opened?.sidecar.recording && withRecorder(opened.sidecar.recording, readOnly ? '' : recorderName(useAccountStore.getState().active()))
  const transcribed = Boolean(recording?.blocks.length)
  const mediaNote = mediaOf(meta) !== 'text'
  const secondLabel = meta.type === 'reading' || !(live || meta.status === 'ready') ? undefined : SECOND_TAB[meta.type]
  const ataDocument = opened?.sidecar.documents?.filter(item => item.kind === 'ata').at(-1)
  const viewer = live ? (
    <GithubMarkdownView markdown={live} live />
  ) : opened && opened.content && !(recording && meta.type === 'reading') ? (
    <GithubMarkdownView markdown={ataDocument && !recording ? withImages(forReading(opened.content), ataDocument.images) : opened.content} quotes={quotes} onSelection={setSelection} onQuoteClick={onQuoteClick} onHeadings={onHeadings} onHeading={setHeading} found={found} />
  ) : null
  const ataView = ataDocument ? <AtaTab markdown={withImages(forReading(ataDocument.markdown), ataDocument.images)} onHeadings={onHeadings} /> : undefined
  const rename = async (speakerId: string, name: string) => {
    if (!recording || !opened) return
    const renamed = renameSpeaker(recording, speakerId, name)
    const before = recording.speakers.find(speaker => speaker.id === speakerId)?.name
    await updateSidecar(fileId, sidecar => ({ ...sidecar, recording: renamed }))
    const content = meta.type === 'reading' ? transcriptText(renamed).trim() : before ? renameInText(opened.content, before, name) : opened.content
    if (content !== opened.content) await saveContent(fileId, content)
  }

  const saveMarks = (marks: RecordingMark[]) => {
    const withMarks = (sidecar: FileSidecar): FileSidecar => (sidecar.recording ? { ...sidecar, recording: { ...sidecar.recording, marks } } : sidecar)
    useLibraryStore.setState(state => (state.opened[fileId] ? { opened: { ...state.opened, [fileId]: { ...state.opened[fileId], sidecar: withMarks(state.opened[fileId].sidecar) } } } : {}))
    void updateSidecar(fileId, withMarks)
  }

  return (
    <article className="article" style={compact ? { padding: 0 } : undefined}>
      {!readOnly && <TagSuggestion meta={meta} />}
      <DocumentHead meta={meta} onInfo={showInfo} transcribed={transcribed} />
      {error && <div className="banner">{error}</div>}
      {meta.status !== 'ready' && !job && (
        <div className="empty" style={{ margin: '24px auto' }}>
          <Icon name="file" />
          <div>{courseOf(folders, meta.folderId) ? 'Esta aula ainda não foi escrita. O recorte do material já está guardado.' : 'A geração não terminou. O material ficou guardado para tentar de novo.'}</div>
          <button className="btn primary" hidden={readOnly} onClick={() => void generatePending(meta.id)}>
            {courseOf(folders, meta.folderId) ? 'Gerar agora' : 'Tentar de novo'}
          </button>
        </div>
      )}
      {job && (
        <div className="reader-live" role="status">
          <Icon name="sync" className="spinning" />
          <span style={{ flex: 1 }}>{job.message}…</span>
          <button className="btn danger" onClick={() => cancel(job.id)}>
            Cancelar
          </button>
        </div>
      )}
      {mediaNote && !transcribed && !live && !opened?.content ? (
        <MediaOnly media={media} onTranscribe={readOnly || job ? undefined : () => ui.open({ kind: 'transcribe', fileId: meta.id })} />
      ) : recording && transcribed ? (
        <MeetingTabs
          key={fileId}
          recording={recording}
          media={media}
          name={meta.name}
          second={secondLabel && viewer ? { label: secondLabel, node: viewer } : undefined}
          ata={ataView}
          onChooseParts={readOnly || job ? undefined : () => ui.open({ kind: 'ata-parts', fileId: meta.id })}
          onRename={readOnly ? undefined : (speakerId, name) => void rename(speakerId, name)}
          onMarks={readOnly ? undefined : saveMarks}
          startAt={startAt}
          onGenerate={readOnly || job || meta.status !== 'ready' || meta.type !== 'reading' ? undefined : agent => ui.open({ kind: 'generate', fileId: meta.id, agent })}
          onRedoTranscript={readOnly || job ? undefined : instruction => void redoTranscript(meta.id, instruction)}
          onRedo={readOnly || job || meta.status !== 'ready' || (meta.type !== 'meeting' && meta.type !== 'class') ? undefined : () => ui.open({ kind: 'generate', fileId: meta.id, agent: meta.type === 'meeting' ? 'meeting' : 'lesson', redo: true })}
        />
      ) : meta.parentFileId && SECOND_TAB[meta.type] && viewer && sourceMedia.available ? (
        <SourceMinutes media={sourceMedia}>{viewer}</SourceMinutes>
      ) : meta.parentFileId && SECOND_TAB[meta.type] && viewer ? (
        <MinutesTab onMoment={seconds => navigate(`${paths.file(meta.parentFileId!)}?t=${seconds}`)}>{viewer}</MinutesTab>
      ) : (
        (viewer ?? (!job && meta.status === 'ready' && !opened && <div className="muted">Abrindo…</div>))
      )}
      {selection && !readOnly && <SelectionPopover fileId={fileId} selection={selection} onDone={() => setSelection(null)} />}
      {heading && !selection && !readOnly && <HeadingExplain fileId={fileId} heading={heading} onDone={() => setHeading(null)} />}
      {!compact && <DocumentNav meta={meta} />}
    </article>
  )
}
