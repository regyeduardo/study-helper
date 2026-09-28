import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'

import type { FileMeta, HighlightColor } from '@/types/domain'
import { Icon } from '@/components/ui/Icon'
import { MasteryMeter, TypeDot } from '@/components/library/Badges'
import { DocumentNav } from '@/components/reader/DocumentNav'
import GithubMarkdownView, { type PaintedQuote, type ReaderSelection } from '@/components/reader/GithubMarkdownView'
import { useDocument } from '@/hooks/use-document'
import { courseOf } from '@/lib/generation/course-lesson'
import { usePathName } from '@/hooks/use-library-view'
import { newId, nowIso } from '@/lib/ids'
import { paths } from '@/lib/paths'
import { useDocumentStore } from '@/stores/document'
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

export function DocumentHead({ meta, onInfo }: { meta: FileMeta; onInfo(): void }) {
  const navigate = useNavigate()
  const pathName = usePathName()
  const setTag = useUiStore(state => state.setTag)
  return (
    <div className="doc-head">
      <h1>{meta.name}</h1>
      <div className="doc-meta">
        <TypeDot type={meta.type} />
        <button onClick={() => navigate(paths.folder(meta.folderId))}>
          <Icon name="folder" /> {pathName(meta.folderId)}
        </button>
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
  const top = Math.max(8, selection.rect.top - 44)
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
  const showInfo = () => ui.set({ inspectorTab: 'info', rightOpen: true, columnsSheet: true, focusPop: 'info' })

  return (
    <article className="article" style={compact ? { padding: 0 } : undefined}>
      <DocumentHead meta={meta} onInfo={showInfo} />
      {error && <div className="banner">{error}</div>}
      {meta.status !== 'ready' && !job && (
        <div className="empty" style={{ margin: '24px auto' }}>
          <Icon name="file" />
          <div>{courseOf(folders, meta.folderId) ? 'Esta aula ainda não foi escrita. O recorte do material já está guardado.' : 'A geração não terminou. O material ficou guardado para tentar de novo.'}</div>
          <button className="btn primary" onClick={() => void generatePending(meta.id)}>
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
      {live ? (
        <GithubMarkdownView markdown={live} live />
      ) : opened && opened.content ? (
        <GithubMarkdownView markdown={opened.content} quotes={quotes} onSelection={setSelection} onQuoteClick={onQuoteClick} onHeadings={onHeadings} onHeading={setHeading} />
      ) : (
        !job && meta.status === 'ready' && !opened && <div className="muted">Abrindo…</div>
      )}
      {selection && <SelectionPopover fileId={fileId} selection={selection} onDone={() => setSelection(null)} />}
      {heading && !selection && <HeadingExplain fileId={fileId} heading={heading} onDone={() => setHeading(null)} />}
      {!compact && <DocumentNav meta={meta} />}
    </article>
  )
}
