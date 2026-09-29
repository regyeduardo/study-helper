import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'

import type { FileMeta, Highlight } from '@/types/domain'
import { Icon } from '@/components/ui/Icon'
import { scrollToHeading } from '@/components/reader/GithubMarkdownView'
import { providerOf } from '@/lib/ai/providers'
import { lineageOf } from '@/lib/generation/course-lesson'
import { courseOf } from '@/lib/generation/course-lesson'
import { newId, nowIso } from '@/lib/ids'
import { paths } from '@/lib/paths'
import { transcriptFileName, transcriptOf } from '@/lib/generation/transcript'
import { fileBytes } from '@/lib/storage/file-sizes'
import { downloadStoredSource, removeStoredSource, sourceExpired } from '@/lib/storage/source-storage'
import { ENGINES } from '@/lib/transcription'
import { isNarrowScreen } from '@/hooks/use-is-narrow'
import { useDocumentStore } from '@/stores/document'
import { useLibraryStore } from '@/stores/library'
import { type InspectorTab, useUiStore } from '@/stores/ui'
import { downloadBlob } from '@/utils/download'
import { dateTime, duration, formatBytes } from '@/utils/format'

const INPUT_LABEL: Record<string, string> = { file: 'Arquivo', url: 'Link', youtube: 'YouTube', topic: 'Tema', text: 'Texto', recording: 'Gravação', import: 'Importado' }
const STORAGE_LABEL: Record<string, string> = { drive: 'Google Drive', gofile: 'Gofile', litterbox: 'Litterbox', filebin: 'filebin', tmpfiles: 'tmpfiles', onlyfiles: 'OnlyFiles', none: 'Não guardada' }

export function TocPanel({ onPick }: { onPick?: () => void }) {
  const headings = useDocumentStore(state => state.headings)
  const scroller = useDocumentStore(state => state.scroller)
  const sections = headings.filter(heading => heading.level >= 2)
  if (!sections.length) return <span className="muted">Sem seções.</span>
  return (
    <div className="toc">
      {sections.map(heading => (
        <button
          key={heading.id}
          className={`h${heading.level}`}
          onClick={() => {
            scrollToHeading(scroller ?? document.body, heading.id)
            onPick?.()
          }}
        >
          {heading.text}
        </button>
      ))}
    </div>
  )
}

export function NotesPanel({ fileId }: { fileId: string }) {
  const opened = useLibraryStore(state => state.opened[fileId])
  const { saveHighlight, removeHighlight } = useLibraryStore()
  const [draft, setDraft] = useState<string | null>(null)
  const [editing, setEditing] = useState<Record<string, string>>({})
  const highlights = opened?.sidecar.highlights ?? []
  const marks = highlights.filter(item => item.kind === 'highlight')
  const notes = highlights.filter(item => item.kind === 'note')

  const saveNote = async (note: Highlight, text: string) => {
    await saveHighlight(fileId, { ...note, text, updatedAt: nowIso() })
    setEditing(state => {
      const next = { ...state }
      delete next[note.id]
      return next
    })
  }

  return (
    <>
      {draft !== null && (
        <div className="note">
          <textarea className="input" aria-label="Texto da nota" placeholder="Escreva a nota" value={draft} onChange={event => setDraft(event.target.value)} autoFocus />
          <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
            <button className="btn quiet" onClick={() => setDraft(null)}>
              Cancelar
            </button>
            <button
              className="btn primary"
              disabled={!draft.trim()}
              onClick={async () => {
                const at = nowIso()
                await saveHighlight(fileId, { id: newId(), kind: 'note', quote: '', text: draft.trim(), color: 'yellow', startOffset: null, endOffset: null, createdAt: at, updatedAt: at })
                setDraft(null)
              }}
            >
              Salvar nota
            </button>
          </div>
        </div>
      )}
      <div className="sec">
        <h4>Destaques ({marks.length})</h4>
        <div style={{ display: 'grid', gap: 6 }}>
          {marks.length ? (
            marks.map(item => (
              <div key={item.id} className="note">
                <q>{item.quote}</q>
                <div className="row-a">
                  <span>destaque · {item.color === 'green' ? 'verde' : item.color === 'pink' ? 'rosa' : 'amarelo'}</span>
                  <button className="ibtn" style={{ width: 22, height: 22 }} onClick={() => void removeHighlight(fileId, item.id)} aria-label="Tirar destaque">
                    <Icon name="x" />
                  </button>
                </div>
              </div>
            ))
          ) : (
            <span className="muted" style={{ fontSize: 13 }}>
              Selecione um trecho do texto para destacar.
            </span>
          )}
        </div>
      </div>
      <div className="sec">
        <h4>Notas ({notes.length})</h4>
        <div style={{ display: 'grid', gap: 6 }}>
          {notes.map(note => (
            <div key={note.id} className="note">
              {note.quote && <q>{note.quote}</q>}
              {editing[note.id] !== undefined || !note.text ? (
                <>
                  <textarea
                    className="input"
                    aria-label="Texto da nota"
                    value={editing[note.id] ?? note.text}
                    onChange={event => setEditing(state => ({ ...state, [note.id]: event.target.value }))}
                  />
                  <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
                    <button className="btn primary" onClick={() => void saveNote(note, editing[note.id] ?? note.text)}>
                      Salvar
                    </button>
                  </div>
                </>
              ) : (
                <div onDoubleClick={() => setEditing(state => ({ ...state, [note.id]: note.text }))}>{note.text}</div>
              )}
              <div className="row-a">
                <span>nota · {new Date(note.updatedAt).toLocaleDateString('pt-BR')}</span>
                <span style={{ display: 'flex', gap: 2 }}>
                  <button className="ibtn" style={{ width: 22, height: 22 }} onClick={() => setEditing(state => ({ ...state, [note.id]: note.text }))} aria-label="Editar nota">
                    <Icon name="pen" />
                  </button>
                  <button className="ibtn" style={{ width: 22, height: 22 }} onClick={() => void removeHighlight(fileId, note.id)} aria-label="Apagar nota">
                    <Icon name="trash" />
                  </button>
                </span>
              </div>
            </div>
          ))}
          <button className="btn" onClick={() => setDraft('')}>
            <Icon name="plus" />
            Nova nota
          </button>
        </div>
      </div>
    </>
  )
}

function TranscriptDownload({ meta }: { meta: FileMeta }) {
  const repo = useLibraryStore(state => state.repo)
  const [transcript, setTranscript] = useState<string | null>(null)
  useEffect(() => {
    let alive = true
    setTranscript(null)
    if (repo) void transcriptOf(meta, repo).then(found => alive && setTranscript(found))
    return () => {
      alive = false
    }
  }, [meta, repo])
  if (!transcript) return null
  return (
    <button className="btn" style={{ marginTop: 10 }} onClick={() => downloadBlob(new Blob([transcript], { type: 'text/plain;charset=utf-8' }), transcriptFileName(meta.name))}>
      <Icon name="download" />
      Baixar a transcrição
    </button>
  )
}

function SourceActions({ meta }: { meta: FileMeta }) {
  const library = useLibraryStore()
  const ui = useUiStore()
  const [confirming, setConfirming] = useState(false)
  const origin = meta.origin!
  const stored = (origin.storedFileId || origin.storedUrl) && !origin.removedAt
  if (!stored) return null
  const expired = sourceExpired(origin)
  return (
    <>
      <div style={{ display: 'flex', gap: 6, marginTop: 10, flexWrap: 'wrap' }}>
        {!expired && (
          <button
            className="btn"
            onClick={async () => {
              try {
                const source = await downloadStoredSource(origin, library.repo!)
                if (typeof source === 'string') window.open(source, '_blank', 'noopener')
                else downloadBlob(source, origin.name)
              } catch (error) {
                ui.toast(error instanceof Error ? error.message : 'Não deu para baixar.')
              }
            }}
          >
            <Icon name="download" />
            Baixar a fonte
          </button>
        )}
        <button className="btn danger" onClick={() => setConfirming(true)}>
          <Icon name="trash" />
          Remover a fonte
        </button>
      </div>
      {confirming && (
        <div className="inline-confirm" style={{ marginTop: 8 }}>
          {origin.storage === 'drive' || origin.storage === 'filebin'
            ? `Apagar o arquivo guardado em ${STORAGE_LABEL[origin.storage]}? A nota continua, só com o nome.`
            : `O ${STORAGE_LABEL[origin.storage]} não deixa apagar pelo app; a nota passa a guardar só o nome.`}
          <button
            className="btn danger"
            onClick={async () => {
              const next = await removeStoredSource(origin, library.repo!)
              await library.updateFile(meta.id, { origin: next })
              setConfirming(false)
              ui.toast('Fonte removida; ficou só o nome')
            }}
          >
            Remover
          </button>
          <button className="btn quiet" onClick={() => setConfirming(false)}>
            Manter
          </button>
        </div>
      )}
    </>
  )
}

export function InfoPanel({ fileId }: { fileId: string }) {
  const library = useLibraryStore()
  const navigate = useNavigate()
  const meta = library.files.find(file => file.id === fileId)
  if (!meta) return null
  const timeZone = library.index.settings.timezone
  const folder = library.folders.find(item => item.id === meta.folderId)
  const course = courseOf(library.folders, meta.folderId)
  const lineage = lineageOf(meta, library.files)
  const children = library.files.filter(file => file.parentFileId === meta.id && !file.deletedAt)
  const origin = meta.origin
  const generation = meta.generation
  const storeLine = !origin
    ? '—'
    : origin.removedAt
      ? 'Arquivo removido; ficou só o nome.'
      : origin.storage === 'none'
        ? 'Não guardada'
        : `${STORAGE_LABEL[origin.storage]}${origin.expiresAt ? ` · até ${dateTime(origin.expiresAt, timeZone)}${sourceExpired(origin) ? ' (expirou)' : ''}` : ''}`

  return (
    <>
      <div className="sec">
        <h4>De onde veio</h4>
        <div className="chain">
          {course && (
            <div>
              <Icon name="layers" /> Curso {course.name}
              {course.courseOrigin ? ` · ${course.courseOrigin}` : ''}
            </div>
          )}
          {[...lineage].reverse().map(step => (
            <div key={step.id}>
              <Icon name="file" />
              <button className="link" onClick={() => navigate(paths.file(step.id))} style={{ color: 'var(--acc1)' }}>
                {step.name}
              </button>
            </div>
          ))}
          {origin && (
            <div>
              <Icon name={origin.input === 'youtube' || origin.input === 'url' ? 'link' : origin.input === 'recording' ? 'rec' : 'file'} /> {INPUT_LABEL[origin.input]}:{' '}
              {origin.url ? (
                <a href={origin.url} target="_blank" rel="noopener noreferrer" style={{ color: 'var(--acc1)', overflowWrap: 'anywhere' }}>
                  {origin.name}
                </a>
              ) : (
                origin.name
              )}
            </div>
          )}
          {meta.sourceExcerpt && (
            <div>
              <Icon name="text" /> “{meta.sourceExcerpt.slice(0, 120)}”
            </div>
          )}
          <div>
            <Icon name="file" /> {meta.name}
          </div>
        </div>
      </div>
      {children.length > 0 && (
        <div className="sec">
          <h4>Explicações feitas daqui ({children.length})</h4>
          <div className="chain">
            {children.map(child => (
              <div key={child.id}>
                <Icon name="bulb" />
                <button onClick={() => navigate(paths.file(child.id))} style={{ color: 'var(--acc1)', textAlign: 'left' }}>
                  {child.name}
                </button>
              </div>
            ))}
          </div>
        </div>
      )}
      {origin && (
        <div className="sec">
          <h4>Origem</h4>
          <dl className="kv">
            <dt>Entrada</dt>
            <dd>{INPUT_LABEL[origin.input]}</dd>
            <dt>{origin.url ? 'Endereço' : 'Nome'}</dt>
            <dd>
              {origin.url ? (
                <a href={origin.url} target="_blank" rel="noopener noreferrer" style={{ color: 'var(--acc1)' }}>
                  {origin.url}
                </a>
              ) : (
                origin.name
              )}
            </dd>
            {origin.sizeBytes !== undefined && (
              <>
                <dt>Tamanho</dt>
                <dd>{formatBytes(origin.sizeBytes)}</dd>
              </>
            )}
            <dt>Tipo</dt>
            <dd>{origin.mime ?? '—'}</dd>
            {origin.durationSeconds !== undefined && (
              <>
                <dt>Duração</dt>
                <dd>{duration(origin.durationSeconds)}</dd>
              </>
            )}
            <dt>Fonte guardada</dt>
            <dd>
              {origin.storedUrl && !origin.removedAt && !sourceExpired(origin) ? (
                <a href={origin.storedUrl} target="_blank" rel="noopener noreferrer" style={{ color: 'var(--acc1)' }}>
                  {storeLine}
                </a>
              ) : (
                storeLine
              )}
            </dd>
          </dl>
          <SourceActions meta={meta} />
          <TranscriptDownload meta={meta} />
        </div>
      )}
      {generation && (
        <div className="sec">
          <h4>Geração</h4>
          <dl className="kv">
            <dt>IA</dt>
            <dd>
              {providerOf(generation.provider as never).name} · {generation.model}
            </dd>
            <dt>Data</dt>
            <dd>{dateTime(generation.startedAt, timeZone)}</dd>
            <dt>Levou</dt>
            <dd>{duration(generation.durationMs / 1000)}</dd>
            <dt>Tokens</dt>
            <dd>
              {(generation.inputTokens + generation.outputTokens).toLocaleString('pt-BR')} ({generation.inputTokens.toLocaleString('pt-BR')} de entrada, {generation.outputTokens.toLocaleString('pt-BR')} de saída)
              {generation.estimatedTokens ? ' · estimado' : ''}
            </dd>
            <dt>Transcrição</dt>
            <dd>{generation.transcriptionEngine ? (ENGINES.find(engine => engine.id === generation.transcriptionEngine)?.name ?? generation.transcriptionEngine) : '—'}</dd>
            <dt>Idioma</dt>
            <dd>{generation.language || 'o do material'}</dd>
          </dl>
        </div>
      )}
      <div className="sec">
        <h4>Nota</h4>
        <dl className="kv">
          <dt>Criada</dt>
          <dd>
            {dateTime(meta.created.at, timeZone)} · {meta.created.deviceName}
          </dd>
          <dt>Alterada</dt>
          <dd>
            {dateTime(meta.updated.at, timeZone)} · {meta.updated.deviceName}
          </dd>
          <dt>Palavras</dt>
          <dd>{meta.words.toLocaleString('pt-BR')}</dd>
          <dt>Leitura</dt>
          <dd>{meta.readingMinutes || '—'} min</dd>
          <dt>Questões</dt>
          <dd>{meta.questionCount}</dd>
          <dt>Tamanho</dt>
          <dd>{formatBytes(fileBytes(meta, library.sizes[meta.id], library.localMedia))}</dd>
          <dt>Tags</dt>
          <dd>
            <TagEditor meta={meta} />
          </dd>
          <dt>Pasta</dt>
          <dd>{folder?.name ?? 'Biblioteca'}</dd>
        </dl>
      </div>
    </>
  )
}

function TagEditor({ meta }: { meta: FileMeta }) {
  const updateFile = useLibraryStore(state => state.updateFile)
  const [value, setValue] = useState('')
  return (
    <span style={{ display: 'flex', gap: 4, flexWrap: 'wrap', alignItems: 'center' }}>
      {meta.tags.map(tag => (
        <button key={tag} className="chip" style={{ height: 22 }} onClick={() => void updateFile(meta.id, { tags: meta.tags.filter(item => item !== tag) })} aria-label={`Tirar a tag ${tag}`}>
          #{tag} <Icon name="x" />
        </button>
      ))}
      <input
        className="input"
        style={{ width: 110, height: 24, padding: '2px 6px' }}
        placeholder="nova tag"
        aria-label="Nova tag"
        value={value}
        onChange={event => setValue(event.target.value)}
        onKeyDown={event => {
          const tag = value.trim().replace(/^#/, '')
          if (event.key === 'Enter' && tag && !meta.tags.includes(tag)) {
            void updateFile(meta.id, { tags: [...meta.tags, tag] })
            setValue('')
          }
        }}
      />
    </span>
  )
}

export function InspectorTabs({ tab, onTab, onClose }: { tab: InspectorTab; onTab(tab: InspectorTab): void; onClose?: () => void }) {
  return (
    <div className="insp-tabs" role="tablist">
      {(
        [
          ['toc', 'Índice'],
          ['notes', 'Notas'],
          ['info', 'Informações'],
        ] as const
      ).map(([id, label]) => (
        <button key={id} role="tab" aria-selected={tab === id} aria-pressed={tab === id} onClick={() => onTab(id)}>
          {label}
        </button>
      ))}
      {onClose && (
        <button className="ibtn insp-close" onClick={onClose} aria-label="Fechar o painel">
          <Icon name="x" />
        </button>
      )}
    </div>
  )
}

export function InspectorBody({ fileId, tab, onPick }: { fileId: string; tab: InspectorTab; onPick?: () => void }) {
  if (tab === 'toc') return <TocPanel onPick={onPick} />
  if (tab === 'notes') return <NotesPanel fileId={fileId} />
  return <InfoPanel fileId={fileId} />
}

export function Inspector({ fileId }: { fileId: string }) {
  const tab = useUiStore(state => state.inspectorTab)
  const set = useUiStore(state => state.set)
  return (
    <>
      <InspectorTabs tab={tab} onTab={next => set({ inspectorTab: next })} onClose={() => set({ rightOpen: false })} />
      <div className="insp-body">
        <InspectorBody fileId={fileId} tab={tab} onPick={() => isNarrowScreen() && set({ rightOpen: false })} />
      </div>
    </>
  )
}
