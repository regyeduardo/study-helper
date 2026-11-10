import { Fragment, useEffect, useId, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'

import type { Artifact, ArtifactKind, ArtifactSummary, FileMeta, Highlight, Settings, StudyCard } from '@/types/domain'
import { madeModelName } from '@/components/dialogs/ArtifactGenerateDialog'
import { Icon, type IconName } from '@/components/ui/Icon'
import { Popover } from '@/components/ui/Popover'
import { NoteParts } from '@/components/reader/Details'
import { artifactsOf } from '@/lib/artifacts'
import { dueCount } from '@/lib/generation/cards'
import { scrollToHeading } from '@/components/reader/GithubMarkdownView'
import { providerOf } from '@/lib/ai/providers'
import { lineageOf } from '@/lib/generation/course-lesson'
import { newId, nowIso } from '@/lib/ids'
import { paths } from '@/lib/paths'
import { transcriptFileName, transcriptOf } from '@/lib/generation/transcript'
import { fileBytes } from '@/lib/storage/file-sizes'
import { downloadStoredSource, removeStoredSource, sourceExpired } from '@/lib/storage/source-storage'
import { ENGINES } from '@/lib/transcription'
import { isNarrowScreen } from '@/hooks/use-is-narrow'
import { useDocumentStore } from '@/stores/document'
import { useLibraryStore } from '@/stores/library'
import { type InspectorTab, type Overlay, useUiStore } from '@/stores/ui'
import { downloadBlob } from '@/utils/download'
import { dateTime, duration, formatBytes, shortDate } from '@/utils/format'

const INPUT_LABEL: Record<string, string> = { file: 'Arquivo', url: 'Link', youtube: 'YouTube', topic: 'Tema', text: 'Texto', recording: 'Gravação', import: 'Importado', shared: 'Compartilhamento' }
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

/** Whoever opens a shared link gets the media from the link itself, never from the owner's storage. */
function SharedMediaDownload({ url, name }: { url: string; name: string }) {
  const toast = useUiStore(state => state.toast)
  const [busy, setBusy] = useState(false)
  return (
    <button
      className="btn"
      style={{ marginTop: 10 }}
      disabled={busy}
      onClick={async () => {
        setBusy(true)
        try {
          const response = await fetch(url)
          if (!response.ok) throw new Error('Não deu para baixar a mídia do link.')
          downloadBlob(await response.blob(), name)
        } catch (error) {
          toast(error instanceof Error ? error.message : 'Não deu para baixar a mídia do link.')
        } finally {
          setBusy(false)
        }
      }}
    >
      <Icon name="download" />
      {busy ? 'Baixando a mídia…' : 'Baixar a mídia'}
    </button>
  )
}

function SourceActions({ meta }: { meta: FileMeta }) {
  const library = useLibraryStore()
  const ui = useUiStore()
  const [confirming, setConfirming] = useState(false)
  const origin = meta.origin!
  const sharedMedia = library.sharedView?.item.files.find(file => file.id === meta.id)?.media ?? null
  if (library.sharedView) return sharedMedia ? <SharedMediaDownload url={sharedMedia.url} name={origin.name} /> : null
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
  const lineage = lineageOf(meta, library.files)
  const children = library.files.filter(file => file.parentFileId === meta.id && !file.deletedAt)
  const origin = meta.origin
  const generation = meta.generation
  const ataModel = library.opened[fileId]?.sidecar.documents?.filter(item => item.kind === 'ata').at(-1)?.ataModel
  const storeLine = !origin
    ? '—'
    : origin.removedAt
      ? 'Arquivo removido; ficou só o nome.'
      : origin.storage === 'none'
        ? 'Não guardada'
        : `${STORAGE_LABEL[origin.storage]}${origin.expiresAt ? ` · até ${dateTime(origin.expiresAt, timeZone)}${sourceExpired(origin) ? ' (expirou)' : ''}` : ''}`

  return (
    <>
      <NoteParts meta={meta} />
      <div className="sec">
        <h4>De onde veio</h4>
        <div className="chain">
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
          <h4>Notas ligadas ({children.length})</h4>
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
      {(generation || ataModel) && (
        <div className="sec">
          <h4>Geração</h4>
          <dl className="kv">
            {generation && (
              <>
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
              </>
            )}
            {ataModel && (
              <>
                <dt>Modelo da ata</dt>
                <dd>{ataModel.name}</dd>
              </>
            )}
          </dl>
        </div>
      )}
      {generation?.stages?.length ? (
        <div className="sec">
          <h4>Tempos</h4>
          <dl className="kv" aria-label="Tempo de cada etapa">
            {generation.stages.map((item, index) => (
              <Fragment key={index}>
                <dt>{item.stage}</dt>
                <dd>{(item.ms / 1000).toLocaleString('pt-BR', { maximumFractionDigits: 1 })} s</dd>
              </Fragment>
            ))}
          </dl>
        </div>
      ) : null}
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

/* ---------- "Desta nota": the artifacts by type (the Prova is the note's own, so it stays out) ---------- */

/** The artifact itself once the note is open; until then, its summary in the meta. */
type Listed = Artifact | ArtifactSummary

const KINDS: { kind: ArtifactKind; title: string; add: string; addWord: string; all: (count: number) => string }[] = [
  { kind: 'mapa', title: 'Mapas mentais', add: 'Novo mapa mental', addWord: 'Novo', all: count => `Ver todos os ${count}` },
  { kind: 'cartoes', title: 'Cartões', add: 'Novo baralho de cartões', addWord: 'Novo', all: count => `Ver todos os ${count}` },
  { kind: 'tutor', title: 'Conversas do Tutor', add: 'Nova conversa do Tutor', addWord: 'Nova', all: count => `Ver todas as ${count}` },
]
const KIND_ICON: Record<ArtifactKind, IconName> = { mapa: 'layers', cartoes: 'note', tutor: 'bulb' }
// Each section shows the newest few; the rest wait behind "Ver todos".
const SHOWN = 3

const counted = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`

/** Newest first; on a tie, the later in the list goes on top. */
function newestFirst(list: Listed[]): Listed[] {
  return list
    .map((item, index) => ({ item, index }))
    .sort((a, b) => b.item.updatedAt.localeCompare(a.item.updatedAt) || b.index - a.index)
    .map(({ item }) => item)
}

function deckLine(cards: StudyCard[]): string {
  const due = dueCount(cards.map(card => card.due))
  return due ? `${due} para hoje de ${cards.length}` : `nada para hoje · ${counted(cards.length, 'cartão', 'cartões')}`
}

/** "4 para hoje de 18 · 30/10 · DeepSeek V3": what it holds, when it changed, the model that made it. */
function lineOf(item: Listed, settings: Settings): string {
  const full = 'createdAt' in item ? item : null
  const holds = full?.kind === 'cartoes' ? deckLine(full.cards) : full?.kind === 'tutor' ? counted(full.turns.length, 'mensagem', 'mensagens') : ''
  return [holds, shortDate(item.updatedAt, settings.timezone), full?.made?.model ? madeModelName(full.made.model, settings) : ''].filter(Boolean).join(' · ')
}

function opening(fileId: string, item: Listed): Overlay {
  if (item.kind === 'mapa') return { kind: 'mindmap', fileId, artifactId: item.id }
  if (item.kind === 'cartoes') return { kind: 'cards', fileId, deckId: item.id }
  return { kind: 'tutor', fileId, conversationId: item.id }
}

function goneText(kind: ArtifactKind, talk: number): string {
  if (kind === 'mapa') return talk ? `O mapa e a conversa dele (${counted(talk, 'mensagem', 'mensagens')}) saem desta nota e não voltam.` : 'O mapa sai desta nota e não volta.'
  if (kind === 'cartoes') return 'O baralho e o progresso de revisão dele saem desta nota e não voltam.'
  return 'A conversa sai desta nota e não volta.'
}

function ArtifactRow({ fileId, item, readOnly }: { fileId: string; item: Listed; readOnly: boolean }) {
  const open = useUiStore(state => state.open)
  const toast = useUiStore(state => state.toast)
  const settings = useLibraryStore(state => state.index.settings)
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)
  const [naming, setNaming] = useState<string | null>(null)
  const dropping = useRef(false)
  const lineId = useId()
  const talk = 'createdAt' in item && item.kind === 'mapa' ? item.chat.length : 0
  const remade = item.kind === 'tutor' ? null : item.kind
  const openIt = () => open(opening(fileId, item))
  const act = (run: () => unknown) => () => {
    setMenu(null)
    void run()
  }
  const failed = (failure: unknown) => toast(failure instanceof Error ? failure.message : String(failure))

  const finishNaming = () => {
    const said = naming?.trim() ?? ''
    const dropped = dropping.current
    dropping.current = false
    setNaming(null)
    if (!dropped && said && said !== item.name) void useLibraryStore.getState().renameArtifact(fileId, item.id, said).catch(failed)
  }

  const askToDelete = () =>
    open({
      kind: 'confirm',
      title: `Apagar “${item.name}”?`,
      text: goneText(item.kind, talk),
      ok: 'Apagar',
      danger: true,
      onConfirm: async () => {
        try {
          await useLibraryStore.getState().deleteArtifact(fileId, item.id)
          toast(`“${item.name}” saiu da nota`)
        } catch (failure) {
          failed(failure)
        }
      },
    })

  return (
    <li className="art">
      {naming === null ? (
        <button className="art-open" title={item.name} aria-label={item.name} aria-describedby={lineId} onClick={openIt}>
          <b>{item.name}</b>
          <span className="faint" id={lineId}>
            {lineOf(item, settings)}
          </span>
        </button>
      ) : (
        <input
          className="input"
          aria-label="Novo nome"
          autoFocus
          value={naming}
          onChange={event => setNaming(event.target.value)}
          onBlur={finishNaming}
          onKeyDown={event => {
            if (event.key === 'Escape') {
              event.stopPropagation()
              dropping.current = true
            }
            if (event.key === 'Enter' || event.key === 'Escape') event.currentTarget.blur()
          }}
        />
      )}
      {!readOnly && (
        <button
          className="ibtn"
          aria-label={`Opções de ${item.name}`}
          aria-haspopup="menu"
          aria-expanded={Boolean(menu)}
          onClick={event => {
            const box = event.currentTarget.getBoundingClientRect()
            setMenu({ x: box.right - 240, y: box.bottom + 4 })
          }}
        >
          <Icon name="dots" />
        </button>
      )}
      {talk > 0 && (
        <button className="art-sub" onClick={openIt}>
          <span aria-hidden="true">↳</span> Conversa do mapa · {counted(talk, 'mensagem', 'mensagens')}
        </button>
      )}
      {menu && (
        <Popover x={menu.x} y={menu.y} onClose={() => setMenu(null)} label={`Opções de ${item.name}`}>
          <div className="mh">{item.name}</div>
          <button className="mi" role="menuitem" onClick={act(openIt)}>
            <Icon name={KIND_ICON[item.kind]} />
            Abrir
          </button>
          <button className="mi" role="menuitem" onClick={act(() => setNaming(item.name))}>
            <Icon name="pen" />
            Renomear
          </button>
          {remade && (
            <button className="mi" role="menuitem" onClick={act(() => open({ kind: 'generate-artifact', fileId, artifact: remade, again: item.id }))}>
              <Icon name="sync" />
              Gerar de novo…
            </button>
          )}
          <div className="sep" />
          <button className="mi danger" role="menuitem" onClick={act(askToDelete)}>
            <Icon name="trash" />
            Apagar
          </button>
        </Popover>
      )}
    </li>
  )
}

function ArtifactSection({ fileId, section, items, readOnly }: { fileId: string; section: (typeof KINDS)[number]; items: Listed[]; readOnly: boolean }) {
  const open = useUiStore(state => state.open)
  const [all, setAll] = useState(false)
  const shown = all ? items : items.slice(0, SHOWN)
  const { kind } = section
  return (
    <section className="sec" aria-label={section.title}>
      <div className="arts-h">
        <h4>{items.length ? `${section.title} · ${items.length}` : section.title}</h4>
        {!readOnly && (
          <button className="btn quiet arts-new" aria-label={section.add} onClick={() => open(kind === 'tutor' ? { kind: 'tutor', fileId, conversationId: null } : { kind: 'generate-artifact', fileId, artifact: kind })}>
            <Icon name="plus" />
            {section.addWord}
          </button>
        )}
      </div>
      {shown.length > 0 && (
        <ul className="arts">
          {shown.map(item => (
            <ArtifactRow key={item.id} fileId={fileId} item={item} readOnly={readOnly} />
          ))}
        </ul>
      )}
      {items.length > SHOWN && (
        <button className="btn quiet arts-more" aria-expanded={all} onClick={() => setAll(!all)}>
          {all ? 'Ver menos' : section.all(items.length)}
        </button>
      )}
    </section>
  )
}

/** Highlights and notes, one more row: it leads to the Notas tab. */
function Marks({ highlights }: { highlights: Highlight[] }) {
  const lineId = useId()
  if (!highlights.length) return null
  const marks = highlights.filter(item => item.kind === 'highlight').length
  const toNotes = () => {
    const { focusPop, set } = useUiStore.getState()
    set({ inspectorTab: 'notes', ...(focusPop ? { focusPop: 'notes' as const } : {}) })
  }
  return (
    <ul className="arts" aria-label="Marcações">
      <li className="art">
        <button className="art-open" aria-label="Marcações" aria-describedby={lineId} onClick={toNotes}>
          <b>Marcações</b>
          <span className="faint" id={lineId}>
            {counted(marks, 'destaque', 'destaques')} · {counted(highlights.length - marks, 'nota', 'notas')} · na aba Notas
          </span>
        </button>
        <span className="ibtn" aria-hidden="true">
          <Icon name="chevr" />
        </span>
      </li>
    </ul>
  )
}

function ThisNote({ fileId }: { fileId: string }) {
  const meta = useLibraryStore(state => state.files.find(file => file.id === fileId))
  const sidecar = useLibraryStore(state => state.opened[fileId]?.sidecar)
  const readOnly = useLibraryStore(state => Boolean(state.sharedView))
  const open = useUiStore(state => state.open)
  useEffect(() => {
    if (!sidecar) void useLibraryStore.getState().openFile(fileId).catch(() => undefined)
  }, [fileId, sidecar])
  if (!meta) return null
  const list: Listed[] = sidecar ? artifactsOf(sidecar) : (meta.artifacts ?? [])
  return (
    <>
      {KINDS.map(section => (
        <ArtifactSection key={section.kind} fileId={fileId} section={section} items={newestFirst(list.filter(item => item.kind === section.kind))} readOnly={readOnly} />
      ))}
      <Marks highlights={sidecar?.highlights ?? []} />
      {meta.questionCount > 0 && (
        <div className="sec">
          <h4>Prova</h4>
          <div className="parts">
            <button className="btn" onClick={() => open({ kind: 'exam', fileId })}>
              <Icon name="exam" />
              Fazer de novo · {meta.questionCount} questões
            </button>
            {meta.mastery !== null && (
              <span className="muted">
                Domínio: {meta.mastery}%{meta.lastReviewedAt ? ` · última em ${new Date(meta.lastReviewedAt).toLocaleDateString('pt-BR')}` : ''}
              </span>
            )}
          </div>
        </div>
      )}
    </>
  )
}

/** The note has something for "Desta nota": a map, a deck, a Tutor conversation or a Prova (the Prova is the note's own, outside the artifact list). */
export function hasGenerated(meta: FileMeta | undefined): boolean {
  return Boolean(meta && (meta.questionCount > 0 || (meta.artifacts?.length ?? 0) > 0 || (meta.cardDue?.length ?? 0) > 0 || meta.hasMindmap))
}

export function InspectorTabs({ tab, onTab, onClose, fileId }: { tab: InspectorTab; onTab(tab: InspectorTab): void; onClose?: () => void; fileId?: string }) {
  const generated = useLibraryStore(state => hasGenerated(state.files.find(file => file.id === fileId)))
  return (
    <div className="insp-tabs" role="tablist">
      {(
        [
          ...(generated ? ([['mine', 'Desta nota']] as const) : []),
          ['toc', 'Índice'],
          ['notes', 'Notas'],
          ['info', 'Detalhes'],
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
  if (tab === 'mine') return <ThisNote fileId={fileId} />
  return <InfoPanel fileId={fileId} />
}

export function Inspector({ fileId }: { fileId: string }) {
  const tab = useUiStore(state => state.inspectorTab)
  const set = useUiStore(state => state.set)
  return (
    <>
      <InspectorTabs fileId={fileId} tab={tab} onTab={next => set({ inspectorTab: next })} onClose={() => set({ rightOpen: false, panelAsked: false })} />
      <div className="insp-body">
        <InspectorBody fileId={fileId} tab={tab} onPick={() => isNarrowScreen() && set({ rightOpen: false })} />
      </div>
    </>
  )
}
