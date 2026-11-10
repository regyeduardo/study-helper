import { useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'

import type { AtaModelId, AtaPart, SourceStorage } from '@/types/domain'
import { AtaPartsFields, toggledPart } from '@/components/dialogs/AtaPartsDialog'
import { FolderField } from '@/components/dialogs/FolderChooser'
import { MediaAnalysisField, useMediaAnalysis } from '@/components/dialogs/GenerateEntryDialog'
import { ModelPick, useModelChoice } from '@/components/dialogs/ModelPick'
import { Dialog } from '@/components/ui/Dialog'
import { Icon } from '@/components/ui/Icon'
import { KeepLevelPicker, SourceStoragePicker } from '@/components/dialogs/SourceStoragePicker'
import type { LitterboxTime } from '@/controllers/hosting.controller'
import { youtubeId } from '@/controllers/sources.controller'
import { PART_ORDER } from '@/lib/generation/ata'
import type { ContentInput } from '@/lib/generation/inputs'
import { detectKind } from '@/lib/generation/uploads'
import { paths } from '@/lib/paths'
import { defaultStorage, storageOptions } from '@/lib/storage/source-storage'
import { useAccountStore } from '@/stores/account'
import { type Agent, defaultKeep, type KeepLevel, useJobsStore } from '@/stores/jobs'
import { useLibraryStore } from '@/stores/library'
import { useSyncStore } from '@/stores/sync'
import { useUiStore } from '@/stores/ui'
import { formatBytes } from '@/utils/format'

type Tab = 'link' | 'file' | 'text' | 'topic'

const AGENTS: { id: Agent; label: string; hint: string }[] = [
  { id: 'lesson', label: 'Aula', hint: 'Vira uma aula estruturada; se render mais de uma, o app propõe uma pasta com as aulas.' },
  { id: 'meeting', label: 'Ata de reunião', hint: 'Transcrição de reunião vira ata com decisões e encaminhamentos.' },
  { id: 'reading', label: 'Só guardar para ler', hint: 'Guarda o texto como veio, sem IA.' },
]

const ACCEPT = '.mp4,.webm,.avi,.mkv,.mov,.mp3,.wav,.ogg,.m4a,.aac,.flac,.opus,.pdf,.docx,.txt,.md,.csv,.json,.xml,.html,.srt,.vtt,.sbv,.ass'

function GenerationProgress({ jobId, onHide }: { jobId: string; onHide(): void }) {
  const job = useJobsStore(state => state.jobs.find(item => item.id === jobId))
  const cancel = useJobsStore(state => state.cancel)
  if (!job) return null
  return (
    <Dialog
      title={`Lendo “${job.title}”`}
      size="narrow"
      footer={
        job.status === 'running' ? (
          <>
            <button className="btn danger" onClick={() => cancel(job.id)}>
              Cancelar
            </button>
            <button className="btn" onClick={onHide}>
              Continuar em segundo plano
            </button>
          </>
        ) : (
          <button className="btn primary" onClick={onHide}>
            Fechar
          </button>
        )
      }
    >
      <div className="db">
        <div className="bar">
          <i style={{ '--v': `${Math.round((job.fraction ?? (job.status === 'running' ? 0.15 : 1)) * 100)}%` } as React.CSSProperties} />
        </div>
        <div className="progress">
          <div className={`step ${job.status === 'running' ? 'now' : 'done'}`}>
            {job.status === 'running' ? <Icon name="sync" className="spinning" /> : <Icon name="check" />}
            {job.message}
          </div>
        </div>
        {job.error && (
          <div className="banner" role="alert">
            <Icon name="warn" />
            <span>{job.error}</span>
          </div>
        )}
        <span className="faint" style={{ fontSize: 12 }}>
          Dá para fechar: o trabalho continua e aparece no canto quando acabar.
        </span>
      </div>
    </Dialog>
  )
}

export function NewContentDialog({ folderId: initialFolder }: { folderId?: string | null }) {
  const ui = useUiStore()
  const navigate = useNavigate()
  const settings = useLibraryStore(state => state.index.settings)
  const account = useAccountStore(state => state.active())
  const usage = useSyncStore(state => state.usage)
  const startNewContent = useJobsStore(state => state.startNewContent)
  const [tab, setTab] = useState<Tab>('link')
  const [agent, setAgent] = useState<Agent>('lesson')
  const [url, setUrl] = useState('')
  const [text, setText] = useState('')
  const [topic, setTopic] = useState('')
  const [file, setFile] = useState<File | null>(null)
  const [isMedia, setIsMedia] = useState(false)
  const [keep, setKeep] = useState<KeepLevel | null>(null)
  const [storage, setStorage] = useState<SourceStorage | null>(null)
  const [litterboxTime, setLitterboxTime] = useState<LitterboxTime>('24h')
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [prompt, setPrompt] = useState('')
  const [folderId, setFolderId] = useState<string | null>(initialFolder ?? null)
  const [jobId, setJobId] = useState<string | null>(null)
  const [ataParts, setAtaParts] = useState<AtaPart[]>(['resumo'])
  const [ataModel, setAtaModel] = useState<AtaModelId | null>(null)
  const input = useRef<HTMLInputElement>(null)

  const driveAvailable = account.kind === 'google'
  const room = usage && settings.storageLimitBytes ? settings.storageLimitBytes - usage.appBytes : null
  const options = useMemo(() => (file ? storageOptions(file.size, driveAvailable, room) : []), [file, driveAvailable, room])
  const writes: Agent = tab === 'topic' && agent === 'lesson' ? 'explanation' : agent
  // under "Registro e arquivo", not keeping the file would be "Só o registro"; for media, 'none' is Mídias, on this computer
  const places = options.filter(option => isMedia || option.id !== 'none')
  const chosen = file ? (storage && places.find(option => option.id === storage && option.fits && option.enabled) ? storage : defaultStorage(driveAvailable, places)) : 'none'
  const fileReason = tab !== 'file' ? 'Só para arquivo e mídia.' : places.some(option => option.fits && option.enabled) ? null : (places.find(option => option.reason)?.reason ?? 'Não há onde guardar este arquivo.')
  const wanted = keep ?? defaultKeep(tab, writes)
  // an Ata always has an entrada (FR-055)
  const level: KeepLevel = writes === 'meeting' && wanted === 'sem-rastro' ? 'registro' : wanted === 'arquivo' && fileReason ? 'registro' : wanted
  const isYoutube = Boolean(youtubeId(url))
  const choosesParts = agent === 'meeting' && tab === 'file' && Boolean(file) && isMedia
  const media = tab === 'file' && Boolean(file) && isMedia
  const choices = { aula: useModelChoice('aula', media), explicacao: useModelChoice('explicacao', media), ata: useModelChoice('ata', media) }
  const heardBy = useModelChoice('transcricao')
  const writer = agent === 'reading' ? null : (tab === 'topic' && agent === 'lesson') || agent === 'explanation' ? choices.explicacao : agent === 'meeting' ? choices.ata : choices.aula
  // only a video has the choice; the type is what the store goes by too
  const analyzes = media && Boolean(writer) && Boolean(file?.type.startsWith('video/'))
  const analysis = useMediaAnalysis(writer, analyzes)

  const pickFile = async (picked: File | null) => {
    setFile(picked)
    setStorage(null)
    if (!picked) return
    const kind = detectKind(picked.name, new Uint8Array(await picked.slice(0, 16384).arrayBuffer()))
    setIsMedia(kind === 'media')
    if (kind === 'media' && agent === 'lesson' && /reuni|meet|call|grava/i.test(picked.name)) setAgent('meeting')
  }

  const contentInput = (): ContentInput | null => {
    if (tab === 'link') return /^https?:\/\//.test(url.trim()) ? { kind: 'link', url: url.trim() } : null
    if (tab === 'file') return file ? { kind: 'file', file } : null
    if (tab === 'text') return text.trim().length > 10 ? { kind: 'text', text } : null
    return topic.trim().length > 2 ? { kind: 'topic', topic } : null
  }

  const go = async () => {
    const content = contentInput()
    if (!content) return
    const fileId = await startNewContent(
      { agent: writes, input: content, name, description, folderId, prompt, keep: level, storage: level === 'arquivo' ? chosen : 'none', litterboxTime, ...(choosesParts ? (ataModel ? { ataParts: [], ataModel } : { ataParts: PART_ORDER.filter(part => ataParts.includes(part)) }) : {}), models: { write: writer?.model || null, transcription: media ? heardBy.model || null : null, everyStep: Boolean(writer?.videoWrites) }, ...(analyzes && analysis.sent ? { analyze: analysis.sent } : {}) },
      setJobId,
    )
    if (fileId) {
      ui.set({ handoffFileId: fileId })
      navigate(paths.file(fileId))
    }
  }

  if (jobId) return <GenerationProgress jobId={jobId} onHide={ui.close} />

  const canGo = Boolean(contentInput()) && !(choosesParts && !ataModel && !ataParts.length) && (!writer || writer.ready) && (!media || heardBy.ready)
  const tabButton = (id: Tab, icon: Parameters<typeof Icon>[0]['name'], label: string) => (
    <button aria-pressed={tab === id} onClick={() => setTab(id)}>
      <Icon name={icon} />
      {label}
    </button>
  )

  return (
    <Dialog
      title="Novo conteúdo"
      onClose={ui.close}
      footer={
        <>
          <button className="btn quiet" onClick={ui.close}>
            Cancelar
          </button>
          <button className="btn primary" disabled={!canGo} onClick={() => void go()}>
            {agent === 'reading' ? 'Guardar' : agent === 'meeting' ? 'Gerar ata' : agent === 'explanation' || tab === 'topic' ? 'Gerar explicação' : 'Gerar aula'}
          </button>
        </>
      }
    >
      <div className="tabs">
        {tabButton('link', 'link', 'Link')}
        {tabButton('file', 'upload', 'Arquivo')}
        {tabButton('text', 'text', 'Texto')}
        {tabButton('topic', 'bulb', 'Tema')}
        <button onClick={() => ui.open({ kind: 'record' })}>
          <Icon name="rec" />
          Gravar reunião
        </button>
      </div>
      <div className="db" style={{ paddingTop: 14 }}>
        {tab === 'link' && (
          <>
            <div className="field">
              <label htmlFor="nc-url">Link</label>
              <input className="input" id="nc-url" autoFocus value={url} onChange={event => setUrl(event.target.value)} placeholder="https://" />
            </div>
            {url.trim() &&
              (isYoutube ? (
                <div className="banner info">
                  <Icon name="info" />
                  <span>
                    Vídeo do YouTube: lido por {settings.youtube.reader === 'gemini' ? 'Gemini (até 8 h de vídeo por dia, só vídeo público)' : 'youtube-transcript.ai (uso justo, sem garantia)'}.{' '}
                    <button style={{ color: 'var(--acc1)' }} onClick={() => ui.open({ kind: 'settings', tab: 'links' })}>
                      Trocar
                    </button>
                  </span>
                </div>
              ) : (
                <div className="banner info">
                  <Icon name="info" />
                  <span>A página é lida pelo Jina Reader (grátis, 20 pedidos por minuto).</span>
                </div>
              ))}
          </>
        )}
        {tab === 'file' && (
          <>
            <label className="drop" htmlFor="nc-file" onDragOver={event => event.preventDefault()} onDrop={event => (event.preventDefault(), void pickFile(event.dataTransfer.files[0] ?? null))}>
              <Icon name="upload" />
              <b>{file ? file.name : 'Escolher arquivo'}</b>
              <span style={{ fontSize: 12.5 }}>{file ? `${formatBytes(file.size)} · ${file.type || 'arquivo'}` : 'PDF, docx, áudio, vídeo, legenda, .md ou .txt'}</span>
            </label>
            <input ref={input} type="file" id="nc-file" hidden accept={ACCEPT} onChange={event => void pickFile(event.target.files?.[0] ?? null)} />
            {media && <ModelPick choice={heardBy} label="Transcrição" />}
          </>
        )}
        {tab === 'text' && (
          <div className="field">
            <label htmlFor="nc-text">Texto</label>
            <textarea className="input" id="nc-text" rows={7} autoFocus value={text} onChange={event => setText(event.target.value)} placeholder="Cole aqui o texto, a ata ou as anotações" />
          </div>
        )}
        {tab === 'topic' && (
          <>
            <div className="field">
              <label htmlFor="nc-topic">Tema</label>
              <input className="input" id="nc-topic" autoFocus value={topic} onChange={event => setTopic(event.target.value)} placeholder="Ex.: juros compostos para iniciantes" />
            </div>
            <span className="faint" style={{ fontSize: 12.5 }}>
              Um tema vira uma explicação a fundo.
            </span>
          </>
        )}
        {tab !== 'topic' && (
          <div className="field">
            <span className="lab">O que gerar</span>
            <div className="opts" role="radiogroup">
              {AGENTS.filter(item => !(item.id === 'reading' && tab === 'link' && isYoutube)).map(item => (
                <button key={item.id} className="opt" role="radio" aria-checked={agent === item.id} onClick={() => setAgent(item.id)}>
                  <span className="radio" />
                  <span>
                    <b>{item.label}</b>
                    <span>{item.hint}</span>
                  </span>
                </button>
              ))}
            </div>
          </div>
        )}
        {writer && <ModelPick choice={writer} />}
        {analyzes && <MediaAnalysisField analysis={analysis} />}
        {choosesParts && <AtaPartsFields parts={ataParts} onToggle={part => setAtaParts(current => toggledPart(current, part))} model={ataModel} onModel={setAtaModel} />}
        {(tab !== 'file' || file) && (
          <KeepLevelPicker level={level} onLevel={setKeep} traceless={writes !== 'meeting'} fileReason={fileReason}>
            {file && (
              <SourceStoragePicker
                label="Onde guardar o arquivo"
                sizeBytes={file.size}
                options={places}
                chosen={chosen}
                onChoose={setStorage}
                litterboxTime={litterboxTime}
                onLitterboxTime={setLitterboxTime}
                names={isMedia ? { none: { name: 'Só neste computador', description: 'Fica em Mídias, neste navegador. A nota toca o vídeo ou o áudio daqui.' } } : undefined}
              />
            )}
          </KeepLevelPicker>
        )}
        <div className="two-col">
          <div className="field">
            <label htmlFor="nc-name">Nome (opcional)</label>
            <input className="input" id="nc-name" value={name} onChange={event => setName(event.target.value)} placeholder="Vem da fonte se ficar vazio" />
          </div>
          <div className="field">
            <span className="lab">Pasta</span>
            <FolderField value={folderId} onChange={setFolderId} />
          </div>
        </div>
        <details>
          <summary className="muted" style={{ fontSize: 13, cursor: 'pointer' }}>
            Mais opções
          </summary>
          <div style={{ display: 'grid', gap: 10, marginTop: 10 }}>
            <div className="field">
              <label htmlFor="nc-desc">Descrição (opcional)</label>
              <input className="input" id="nc-desc" value={description} onChange={event => setDescription(event.target.value)} />
            </div>
            {agent !== 'reading' && (
              <div className="field">
                <label htmlFor="nc-prompt">Instrução extra para a IA (opcional)</label>
                <textarea className="input" id="nc-prompt" value={prompt} onChange={event => setPrompt(event.target.value)} placeholder="Ex.: foque na parte prática" />
              </div>
            )}
          </div>
        </details>
      </div>
    </Dialog>
  )
}
