// Página da entrada: a fonte, a transcrição e tudo o que nasceu dela, cada parte num card que rola por dentro.
import { type CSSProperties, Fragment, type ReactNode, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useLocation, useNavigate } from 'react-router-dom'

import type { ArtifactKind, FileMeta, SourceMeta, SourceStorage } from '@/types/domain'
import { entryKind } from '@/components/library/EntryList'
import { SaveToDrive } from '@/components/library/SaveToDrive'
import { SharedBadge } from '@/components/library/SharedBadge'
import { MediaPlayer, type MeetingMedia, playAt, useMeetingMedia } from '@/components/reader/MediaPlayer'
import { TranscriptTab } from '@/components/reader/TranscriptTab'
import { Icon, type IconName } from '@/components/ui/Icon'
import { Popover } from '@/components/ui/Popover'
import { useDocument } from '@/hooks/use-document'
import { usePathName } from '@/hooks/use-library-view'
import { descendantsOf, familyCount } from '@/lib/family'
import { mediaLength, mediaOf } from '@/lib/file-types'
import { courseOf } from '@/lib/generation/course-lesson'
import { paths } from '@/lib/paths'
import { downloadStoredSource, sourceExpired } from '@/lib/storage/source-storage'
import { transcriptText } from '@/lib/transcription/export'
import { renameSpeaker, withRecorder } from '@/lib/transcription/turns'
import { recorderName, useAccountStore } from '@/stores/account'
import { type Job, useJobsStore } from '@/stores/jobs'
import { type OpenedFile, useLibraryStore } from '@/stores/library'
import { useUiStore } from '@/stores/ui'
import '@/styles/entry-page.css'
import { downloadBlob } from '@/utils/download'
import { formatBytes } from '@/utils/format'

const STORAGE_LABEL: Partial<Record<SourceStorage, string>> = { drive: 'Google Drive', gofile: 'Gofile', litterbox: 'Litterbox', filebin: 'filebin', tmpfiles: 'tmpfiles', onlyfiles: 'OnlyFiles' }
const ARRIVED_BY: Partial<Record<SourceMeta['input'], string>> = { file: 'Novo conteúdo, arquivo', url: 'Novo conteúdo, link', youtube: 'Novo conteúdo, YouTube', recording: 'Gravação' }
const ARTIFACT_ICON: Record<ArtifactKind, IconName> = { mapa: 'layers', cartoes: 'text', tutor: 'bulb' }

type Dated = (iso: string) => string

const isStored = (origin: SourceMeta) => Boolean((origin.storedFileId || origin.storedUrl) && !origin.removedAt && !sourceExpired(origin))
const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`

function countText({ notes, artifacts }: { notes: number; artifacts: number }): string {
  const parts = [notes ? plural(notes, 'nota', 'notas') : '', artifacts ? plural(artifacts, 'artefato', 'artefatos') : ''].filter(Boolean)
  return parts.length ? parts.join(' · ') : 'Nenhuma nota ainda'
}

/** When the file is gone, says only what is really still here. */
function whatStays(transcribed: boolean, notes: number): string {
  if (transcribed && notes) return 'A transcrição e as notas continuam aqui.'
  if (transcribed) return 'A transcrição continua aqui.'
  return notes ? 'As notas continuam aqui.' : ''
}

function mediaFacts(origin: SourceMeta): string {
  return [mediaLength(origin.durationSeconds), origin.sizeBytes ? formatBytes(origin.sizeBytes) : ''].filter(Boolean).join(' · ')
}

/** Plays from a second: asks for the media first when it is still in the Drive, as the reader does. */
function usePlayback(media: MeetingMedia) {
  const player = useRef<HTMLMediaElement | null>(null)
  const [time, setTime] = useState<number | null>(null)
  const [waiting, setWaiting] = useState<number | null>(null)
  const playFrom = (seconds: number) => {
    if (media.url && player.current) {
      setTime(seconds)
      return playAt(player.current, seconds)
    }
    setWaiting(seconds)
    void media.request()
  }
  useEffect(() => {
    if (waiting === null || !media.url || !player.current) return
    setWaiting(null)
    setTime(waiting)
    playAt(player.current, waiting)
  }, [waiting, media.url])
  return { player, time, setTime, playFrom }
}

function Facts({ rows }: { rows: [string, ReactNode][] }) {
  const shown = rows.filter(([, value]) => value)
  if (!shown.length) return null
  return (
    <dl className="ep-facts">
      {shown.map(([term, value]) => (
        <Fragment key={term}>
          <dt>{term}</dt>
          <dd>{value}</dd>
        </Fragment>
      ))}
    </dl>
  )
}

function Notice({ gone, title, children }: { gone?: boolean; title: string; children: ReactNode }) {
  return (
    <div className={gone ? 'ep-gone' : 'ep-record'}>
      {gone && <Icon name="warn" />}
      <div>
        <b>{title}</b>
        {children}
      </div>
    </div>
  )
}

function DownloadSource({ origin }: { origin: SourceMeta }) {
  const repo = useLibraryStore(state => state.repo)
  const toast = useUiStore(state => state.toast)
  const [busy, setBusy] = useState(false)
  const download = async () => {
    setBusy(true)
    try {
      const source = await downloadStoredSource(origin, repo!)
      if (typeof source === 'string') window.open(source, '_blank', 'noopener')
      else downloadBlob(source, origin.name)
    } catch (error) {
      toast(error instanceof Error ? error.message : 'Não deu para baixar.')
    } finally {
      setBusy(false)
    }
  }
  return (
    <button className="btn ep-mt" disabled={busy} onClick={() => void download()}>
      <Icon name="download" />
      {busy ? 'Baixando…' : 'Baixar o arquivo'}
    </button>
  )
}

function MediaOriginal({ entry, origin, media, playback, date, stays }: { entry: FileMeta; origin: SourceMeta; media: MeetingMedia; playback: ReturnType<typeof usePlayback>; date: Dated; stays: string }) {
  const inBrowser = useLibraryStore(state => state.localMedia.some(item => item.fileIds.includes(entry.id)))
  const noun = mediaOf(entry) === 'video' ? 'vídeo' : 'áudio'
  const was = mediaFacts(origin)
  if (origin.removedAt) {
    return (
      <>
        <Notice gone title={`Mídia apagada em ${date(origin.removedAt)}`}>
          <div className="muted">O {noun} foi apagado para liberar espaço. {stays}</div>
        </Notice>
        <Facts rows={[['Era', was]]} />
      </>
    )
  }
  if (media.available && entry.kept !== 'registro') {
    const stored = isStored(origin)
    return (
      <>
        <MediaPlayer player={playback.player} media={media} onTime={playback.setTime} onPlayFrom={playback.playFrom} />
        <Facts
          rows={[
            ['Mídia', was],
            ['Guardado em', stored ? STORAGE_LABEL[origin.storage] : inBrowser ? <SaveToDrive fileId={entry.id} /> : ''],
            ['Fica até', stored ? (origin.expiresAt ? date(origin.expiresAt) : 'Você apagar') : ''],
          ]}
        />
      </>
    )
  }
  if (sourceExpired(origin)) {
    return (
      <>
        <Notice gone title={`O arquivo temporário expirou em ${date(origin.expiresAt!)}`}>
          <div className="muted">O {noun} saiu do serviço temporário. {stays}</div>
        </Notice>
        <Facts rows={[['Era', was], ['Guardado em', STORAGE_LABEL[origin.storage]]]} />
      </>
    )
  }
  return (
    <>
      <Notice title={origin.name}>
        <div className="muted">{entry.kept === 'registro' ? `Guardado só como registro: o arquivo não foi copiado. ${stays}` : media.notice ?? `O arquivo não está disponível neste aparelho. ${stays}`}</div>
      </Notice>
      <Facts rows={[['Mídia', was], ['Veio de', ARRIVED_BY[origin.input]]]} />
    </>
  )
}

function Original({ entry, opened, media, playback, date, notes }: { entry: FileMeta; opened: OpenedFile | null; media: MeetingMedia; playback: ReturnType<typeof usePlayback>; date: Dated; notes: number }) {
  const origin = entry.origin
  const created = date(entry.created.at)
  // Still opening: the sentence of the common case, so that it does not change under the reader's eyes.
  const transcribed = !opened || Boolean(opened.sidecar.recording?.blocks.length || opened.sidecar.transcript?.trim())
  if (origin && mediaOf(entry) !== 'text') return <MediaOriginal entry={entry} origin={origin} media={media} playback={playback} date={date} stays={whatStays(transcribed, notes)} />
  if (origin?.input === 'url' || origin?.input === 'youtube') {
    return (
      <>
        <Notice title={origin.name}>
          {origin.url && (/^https?:\/\//i.test(origin.url) ? <a href={origin.url} target="_blank" rel="noreferrer">{origin.url.replace(/^https?:\/\/(www\.)?/i, '')}</a> : <div>{origin.url}</div>)}
          <div className="muted">Guardado só como registro: o conteúdo da página não foi copiado. Se o site sair do ar, as notas continuam.</div>
        </Notice>
        <Facts rows={[['Veio de', ARRIVED_BY[origin.input]], ['Lido em', created]]} />
      </>
    )
  }
  if (origin?.input === 'topic') {
    return (
      <>
        <Notice title={origin.name}>
          <div className="muted">Tema escrito por você em Novo conteúdo. Não há arquivo: a nota foi escrita pela IA a partir do tema.</div>
        </Notice>
        <Facts rows={[['Pedido em', created]]} />
      </>
    )
  }
  if (origin?.input === 'file') {
    const size = origin.sizeBytes ? formatBytes(origin.sizeBytes) : ''
    if (origin.removedAt) {
      return (
        <>
          <Notice gone title={`Arquivo apagado em ${date(origin.removedAt)}`}>
            <div className="muted">O arquivo foi apagado para liberar espaço. {whatStays(false, notes)}</div>
          </Notice>
          <Facts rows={[['Era', origin.name], ['Arquivo', size]]} />
        </>
      )
    }
    if (sourceExpired(origin)) {
      return (
        <>
          <Notice gone title={`O arquivo temporário expirou em ${date(origin.expiresAt!)}`}>
            <div className="muted">O arquivo saiu do serviço temporário. {whatStays(false, notes)}</div>
          </Notice>
          <Facts rows={[['Era', origin.name], ['Guardado em', STORAGE_LABEL[origin.storage]]]} />
        </>
      )
    }
    const stored = isStored(origin)
    return (
      <>
        <Notice title={origin.name}>
          <div className="muted">{stored ? 'O arquivo está guardado com a entrada.' : `Guardado só como registro: o arquivo não foi copiado. ${whatStays(false, notes)}`}</div>
          {stored && <DownloadSource origin={origin} />}
        </Notice>
        <Facts rows={[['Arquivo', size], ['Guardado em', stored ? STORAGE_LABEL[origin.storage] : ''], ['Veio de', stored ? '' : ARRIVED_BY[origin.input]]]} />
      </>
    )
  }
  return (
    <>
      {opened ? opened.content ? <blockquote className="ep-paste">{opened.content}</blockquote> : <div className="muted">O texto colado não foi guardado.</div> : <div className="muted">Abrindo…</div>}
      <Facts rows={[['Tamanho', entry.words ? plural(entry.words, 'palavra', 'palavras') : ''], ['Colado em', created]]} />
    </>
  )
}

/** What a job is doing, and how far it is when it knows. */
function JobProgress({ job }: { job: Job }) {
  const percent = job.fraction === null ? null : Math.round(job.fraction * 100)
  return (
    <div className="ep-progress" role="status">
      <span>{job.message}</span>
      {percent !== null && (
        <div className="bar" role="progressbar" aria-label={job.message} aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}>
          <i style={{ '--v': `${percent}%` } as CSSProperties} />
        </div>
      )}
    </div>
  )
}

function Failure({ text, onRetry }: { text: string; onRetry?(): void }) {
  return (
    <div className="ep-error" role="alert">
      <span>{text}</span>
      {onRetry && (
        <button className="btn" onClick={onRetry}>
          Tentar de novo
        </button>
      )}
    </div>
  )
}

function Transcript({ entry, opened, canTranscribe, canPlay, playback }: { entry: FileMeta; opened: OpenedFile | null; canTranscribe: boolean; canPlay: boolean; playback: ReturnType<typeof usePlayback> }) {
  // "?t=95": the speech a search found (FR-074), or a moment of the Ata
  const asked = new URLSearchParams(useLocation().search).get('t')
  const found = asked !== null && Number.isFinite(Number(asked)) ? Number(asked) : null
  const openOverlay = useUiStore(state => state.open)
  const readOnly = useLibraryStore(state => Boolean(state.sharedView))
  const job = useJobsStore(state => state.jobs.find(item => item.fileId === entry.id && item.kind === 'transcription' && (item.status === 'running' || item.status === 'error')))
  if (!opened) return <div className="muted">Abrindo…</div>
  const { recording, transcript } = opened.sidecar
  const running = job?.status === 'running'
  const status = job && (running ? <JobProgress job={job} /> : job.error && <Failure text={job.error} />)
  // from scratch, with the same window as the first time
  const redo = canTranscribe && !running ? () => openOverlay({ kind: 'transcribe', fileId: entry.id }) : undefined
  if (recording?.blocks.length) {
    // The same rename as in the note: every speech of that voice, the transcript and the entry's text
    const rename = async (speakerId: string, name: string) => {
      const renamed = renameSpeaker(recording, speakerId, name)
      const library = useLibraryStore.getState()
      await library.updateSidecar(entry.id, sidecar => ({ ...sidecar, recording: renamed, transcript: transcriptText(renamed).trim() }))
      if (entry.type === 'reading' && opened.content.trim()) await library.saveContent(entry.id, transcriptText(renamed).trim())
    }
    return (
      <>
        {status}
        <TranscriptTab recording={withRecorder(recording, readOnly ? '' : recorderName(useAccountStore.getState().active()))} name={entry.name} time={playback.time} onPlay={canPlay ? playback.playFrom : undefined} onRename={readOnly ? undefined : (speakerId, name) => void rename(speakerId, name)} onRetranscribe={redo} found={found} />
      </>
    )
  }
  if (transcript?.trim()) {
    return (
      <>
        {status}
        {redo && (
          <div className="tr-tools">
            <button className="btn" onClick={redo}>
              <Icon name="sync" />
              Refazer a transcrição
            </button>
          </div>
        )}
        <p className="ep-plain">{transcript.trim()}</p>
      </>
    )
  }
  return (
    <>
      {status}
      {!running && (
        <div className="empty ep-empty">
          <div>
            <b>Sem transcrição ainda</b>
            <div className="muted">{canPlay ? 'Ela fica junto da mídia quando for feita.' : 'Sem o arquivo, não dá para transcrever.'}</div>
          </div>
          {canTranscribe && (
            <button className="btn" onClick={() => openOverlay({ kind: 'transcribe', fileId: entry.id })}>
              Transcrever
            </button>
          )}
        </div>
      )}
    </>
  )
}

interface TreeProps {
  parentId: string
  childrenOf: Map<string, FileMeta[]>
  folderName(id: string | null): string
  pathName(id: string | null): string
  /** After the notes: what is being made and has no note yet. */
  extra?: ReactNode
}

const nodeName = (name: string) => (
  <>
    <Icon name="file" />
    <span>{name}</span>
  </>
)

function Node({ file, ...tree }: { file: FileMeta } & Omit<TreeProps, 'parentId' | 'extra'>) {
  const job = useJobsStore(state => state.jobs.find(item => item.fileId === file.id && item.kind === 'generation' && (item.status === 'running' || item.status === 'error')))
  const generatePending = useJobsStore(state => state.generatePending)
  const folders = useLibraryStore(state => state.folders)
  // a shared link brings no folder of who shared
  const readOnly = useLibraryStore(state => Boolean(state.sharedView))
  const running = job?.status === 'running'
  const unfinished = !running && file.status !== 'ready'
  // a lesson of a course waits for its turn: nothing went wrong
  const waiting = unfinished && !job && Boolean(courseOf(folders, file.folderId))
  const failed = unfinished && !waiting
  return (
    <li>
      <div className="ep-node">
        {running || failed ? (
          <span className="ep-node-name">{nodeName(file.name)}</span>
        ) : (
          <Link className="ep-node-name" to={paths.file(file.id)}>
            {nodeName(file.name)}
          </Link>
        )}
        {running && <span className="pending">gerando…</span>}
        {waiting && <span className="pending">ainda não escrita</span>}
        {failed && <span className="ep-fail">falhou</span>}
        {!readOnly && (
          <span className="ep-where" title={tree.pathName(file.folderId)}>
            <Icon name="folder" />
            {tree.folderName(file.folderId)}
          </span>
        )}
      </div>
      {running && <JobProgress job={job} />}
      {failed && <Failure text={job?.error ?? 'A geração não terminou. O material ficou guardado para tentar de novo.'} onRetry={() => void generatePending(file.id)} />}
      {Boolean(file.artifacts?.length) && (
        <div className="ep-arts">
          {file.artifacts!.map(artifact => (
            <Link key={artifact.id} className="ep-art" to={paths.file(file.id)}>
              <Icon name={ARTIFACT_ICON[artifact.kind]} />
              {artifact.name}
            </Link>
          ))}
        </div>
      )}
      {tree.childrenOf.has(file.id) && <Tree parentId={file.id} {...tree} />}
    </li>
  )
}

function Tree({ parentId, extra, ...tree }: TreeProps) {
  return (
    <ul className="ep-tree">
      {(tree.childrenOf.get(parentId) ?? []).map(file => (
        <Node key={file.id} file={file} {...tree} />
      ))}
      {extra}
    </ul>
  )
}

/** Made from the entrada, but with no note yet: an Ata is only created when it is ready, and a refused generation never is. */
function JobNode({ job, onRetry }: { job: Job; onRetry(): void }) {
  const running = job.status === 'running'
  return (
    <li>
      <div className="ep-node">
        <span className="ep-node-name">{nodeName(job.title)}</span>
        {running ? <span className="pending">gerando…</span> : <span className="ep-fail">falhou</span>}
      </div>
      {running ? <JobProgress job={job} /> : <Failure text={job.error ?? job.message} onRetry={onRetry} />}
    </li>
  )
}

function EntryView({ fileId }: { fileId: string }) {
  const { meta: entry, opened, error } = useDocument(fileId)
  const media = useMeetingMedia(entry)
  const playback = usePlayback(media)
  const files = useLibraryStore(state => state.files)
  const folders = useLibraryStore(state => state.folders)
  const timeZone = useLibraryStore(state => state.index.settings.timezone)
  const readOnly = useLibraryStore(state => Boolean(state.sharedView))
  const hasMedia = useLibraryStore(state => state.hasMedia(fileId))
  const jobs = useJobsStore(state => state.jobs)
  const dismiss = useJobsStore(state => state.dismiss)
  const ui = useUiStore()
  const navigate = useNavigate()
  const pathName = usePathName()
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)
  const family = useMemo(() => descendantsOf(files, fileId), [files, fileId])
  const childrenOf = useMemo(() => {
    const found = new Map<string, FileMeta[]>()
    for (const file of [...family].sort((a, b) => a.created.at.localeCompare(b.created.at))) found.set(file.parentFileId!, [...(found.get(file.parentFileId!) ?? []), file])
    return found
  }, [family])
  const ownJobs = useMemo(() => jobs.filter(job => job.fileId === fileId && job.kind === 'generation' && (job.status === 'running' || job.status === 'error')), [jobs, fileId])
  // trashed: nothing left to see here
  useEffect(() => {
    if (entry?.deletedAt) navigate(paths.folder(entry.folderId), { replace: true })
  }, [entry?.deletedAt])

  if (!entry) {
    return (
      <div className="empty">
        <span>Entrada não encontrada.</span>
        <Link className="btn" to={paths.entries}>
          Ver as entradas
        </Link>
      </div>
    )
  }

  const date: Dated = iso => new Date(iso).toLocaleDateString('pt-BR', { timeZone, day: '2-digit', month: '2-digit', year: 'numeric' })
  const folderName = (id: string | null) => folders.find(folder => folder.id === id)?.name ?? 'Biblioteca'
  const kind = entryKind(entry)
  const isMedia = mediaOf(entry) !== 'text'
  const canPlay = media.available && entry.kept !== 'registro' && !entry.origin?.removedAt
  const count = familyCount(files, fileId)
  const transcribed = Boolean(opened?.sidecar.recording?.blocks.length || opened?.sidecar.transcript?.trim())
  const generate = () => ui.open({ kind: 'generate-entry', fileId: entry.id })
  const removeMedia = () =>
    ui.open({
      kind: 'confirm',
      title: 'Apagar só a mídia?',
      text: 'O arquivo sai e o espaço é liberado. A entrada fica marcada como mídia apagada, com a transcrição e as notas.',
      ok: 'Apagar só a mídia',
      danger: true,
      onConfirm: () => useLibraryStore.getState().removeMedia(entry.id),
    })
  const action = (icon: IconName, label: string, run: () => void, danger = false) => (
    <button
      className={`mi ${danger ? 'danger' : ''}`}
      role="menuitem"
      onClick={() => {
        setMenu(null)
        run()
      }}
    >
      <Icon name={icon} />
      {label}
    </button>
  )

  return (
    <div className="entry-page">
      <article className="ep-entry" aria-label={entry.name}>
        <header className="ep-head">
          <div className="ep-title">
            <span className="ep-icon">
              <Icon name={kind.icon} />
            </span>
            <div className="ep-title-text">
              <h1>{entry.name}</h1>
              <div className="doc-meta">
                <span className="ep-kind">Entrada · {kind.label}</span>
                {readOnly ? (
                  <SharedBadge label />
                ) : (
                  <span title={pathName(entry.folderId)}>
                    <Icon name="folder" />
                    {folderName(entry.folderId)}
                  </span>
                )}
                <span>{date(entry.created.at)}</span>
                <span className="ep-kept">{entry.kept === 'arquivo' && !entry.origin?.removedAt ? 'Registro e arquivo' : 'Só o registro'}</span>
              </div>
            </div>
          </div>
          {readOnly ? (
            <div className="ep-actions">
              <SharedBadge button />
            </div>
          ) : (
            <div className="ep-actions">
              <button className="btn" onClick={() => ui.open({ kind: 'chat', fileId: entry.id })}>
                <Icon name="chat" />
                Chat
              </button>
              <button className="btn primary ep-gen" onClick={generate}>
                <Icon name="plus" />
                Gerar desta entrada
              </button>
              <button
                className="ibtn"
                aria-label="Mais ações"
                aria-haspopup="menu"
                aria-expanded={Boolean(menu)}
                onClick={event => {
                  const box = event.currentTarget.getBoundingClientRect()
                  setMenu({ x: box.right - 240, y: box.bottom + 4 })
                }}
              >
                <Icon name="dots" />
              </button>
              {menu && (
                <Popover x={menu.x} y={menu.y} onClose={() => setMenu(null)} label="Ações da entrada">
                  {action('pen', 'Renomear', () => ui.open({ kind: 'rename', target: 'file', id: entry.id }))}
                  {action('move', 'Mover para…', () => ui.open({ kind: 'move', fileIds: [entry.id], folderIds: [] }))}
                  {action('link', 'Compartilhar…', () => ui.open({ kind: 'share', target: 'entrada', id: entry.id }))}
                  {hasMedia && action('trash', 'Apagar só a mídia…', removeMedia)}
                  {action('trash', 'Apagar…', () => ui.open({ kind: 'delete-family', fileId: entry.id }), true)}
                </Popover>
              )}
            </div>
          )}
        </header>
        {error && <div className="banner">{error}</div>}
        <div className={`ep-cards ${isMedia ? 'ep-three' : ''}`}>
          <section className="ep-card ep-original" aria-label="Original">
            <h2>Original</h2>
            <div className="ep-card-body">
              <Original entry={entry} opened={opened} media={media} playback={playback} date={date} notes={count.notes} />
            </div>
          </section>
          {isMedia && (
            <section className="ep-card ep-trans" aria-label="Transcrição">
              <h2>
                Transcrição
                {transcribed && <span className="ep-hint">Faz parte da mídia</span>}
              </h2>
              <div className="ep-card-body">
                <Transcript entry={entry} opened={opened} canPlay={canPlay} canTranscribe={canPlay && !readOnly} playback={playback} />
              </div>
            </section>
          )}
          <section className="ep-card ep-family" aria-label="O que nasceu daqui">
            <h2>
              O que nasceu daqui
              <span className="ep-count">{countText(count)}</span>
            </h2>
            <div className="ep-card-body">
              {family.length || ownJobs.length ? (
                <Tree
                  parentId={entry.id}
                  childrenOf={childrenOf}
                  folderName={folderName}
                  pathName={pathName}
                  extra={ownJobs.map(job => (
                    <JobNode
                      key={job.id}
                      job={job}
                      onRetry={() => {
                        dismiss(job.id)
                        generate()
                      }}
                    />
                  ))}
                />
              ) : (
                <div className="empty ep-empty">
                  <div>
                    <b>{readOnly ? 'Nenhuma nota veio no link' : 'Nada nasceu daqui ainda'}</b>
                    <div className="muted">{readOnly ? 'Quem compartilhou mandou só a entrada.' : !isMedia ? 'Gere uma nota a partir desta entrada.' : canPlay && !transcribed ? 'Gere uma transcrição, uma ata ou uma aula a partir desta gravação.' : 'Gere uma ata, uma aula ou uma explicação a partir desta entrada.'}</div>
                  </div>
                  {!readOnly && (
                    <button className="btn primary" onClick={generate}>
                      <Icon name="plus" />
                      Gerar desta entrada
                    </button>
                  )}
                </div>
              )}
            </div>
          </section>
        </div>
      </article>
    </div>
  )
}

/** Keyed by the entrada, so the player and its time never pass from one to the next. */
export function EntryPage({ fileId }: { fileId: string }) {
  return <EntryView key={fileId} fileId={fileId} />
}
