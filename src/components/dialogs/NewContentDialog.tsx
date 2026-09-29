import { useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'

import type { SourceStorage, TranscriptionEngine } from '@/types/domain'
import { Dialog } from '@/components/ui/Dialog'
import { Icon } from '@/components/ui/Icon'
import { FreeMinutes } from '@/components/dialogs/FreeMinutes'
import { LimitedAiNotice } from '@/components/dialogs/LimitedAiNotice'
import { FolderPicker } from '@/components/dialogs/SimpleDialogs'
import { SourceStoragePicker } from '@/components/dialogs/SourceStoragePicker'
import type { LitterboxTime } from '@/controllers/hosting.controller'
import { youtubeId } from '@/controllers/sources.controller'
import { useFreeMinutes } from '@/hooks/use-free-minutes'
import { isFreeChoice, modelOf, providerOf } from '@/lib/ai/providers'
import type { ContentInput } from '@/lib/generation/inputs'
import { detectKind } from '@/lib/generation/uploads'
import { paths } from '@/lib/paths'
import { defaultStorage, storageOptions } from '@/lib/storage/source-storage'
import { ENGINES } from '@/lib/transcription'
import { useAccountStore } from '@/stores/account'
import { type Agent, useJobsStore } from '@/stores/jobs'
import { useLibraryStore } from '@/stores/library'
import { useSyncStore } from '@/stores/sync'
import { useUiStore } from '@/stores/ui'
import { formatBytes } from '@/utils/format'

type Tab = 'link' | 'file' | 'text' | 'topic'

const AGENTS: { id: Agent; label: string; hint: string }[] = [
  { id: 'lesson', label: 'Aula', hint: 'Vira uma aula estruturada; se render mais de uma, o app propõe um curso.' },
  { id: 'explanation', label: 'Explicação', hint: 'Explica o assunto a fundo.' },
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
  const updateSettings = useLibraryStore(state => state.updateSettings)
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
  const [storage, setStorage] = useState<SourceStorage | null>(null)
  const [litterboxTime, setLitterboxTime] = useState<LitterboxTime>('24h')
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [prompt, setPrompt] = useState('')
  const [folderId, setFolderId] = useState<string | null>(initialFolder ?? null)
  const [jobId, setJobId] = useState<string | null>(null)
  const input = useRef<HTMLInputElement>(null)
  const freeMinutes = useFreeMinutes(file && isMedia ? file : null)

  const driveAvailable = account.kind === 'google'
  const room = usage && settings.storageLimitBytes ? settings.storageLimitBytes - usage.appBytes : null
  const options = useMemo(() => (file ? storageOptions(file.size, driveAvailable, room) : []), [file, driveAvailable, room])
  const chosen = file ? (storage && options.find(option => option.id === storage && option.fits && option.enabled) ? storage : defaultStorage(file.size, driveAvailable, options)) : 'none'
  const provider = providerOf(settings.ai.provider)
  const isYoutube = Boolean(youtubeId(url))

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
      { agent: tab === 'topic' && agent === 'lesson' ? 'explanation' : agent, input: content, name, description, folderId, prompt, storage: chosen, litterboxTime },
      setJobId,
    )
    if (fileId) {
      ui.set({ handoffFileId: fileId })
      navigate(paths.file(fileId))
    }
  }

  if (jobId) return <GenerationProgress jobId={jobId} onHide={ui.close} />

  const canGo = Boolean(contentInput()) && !(tab === 'file' && freeMinutes.kind === 'ready' && freeMinutes.short)
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
          <span className="grow">
            IA: {provider.name} · {modelOf(settings.ai) || 'sem modelo'}
            {isFreeChoice(settings.ai) && (
              <>
                {' · '}
                <span className="freewarn" style={{ display: 'inline-flex' }}>
                  <Icon name="warn" />
                  modelo grátis pode piorar o resultado
                </span>
              </>
            )}
          </span>
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
        <LimitedAiNotice />
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
                    <button style={{ color: 'var(--acc1)' }} onClick={() => ui.open({ kind: 'settings', tab: 'transcription' })}>
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
            {file && (
              <SourceStoragePicker
                label="Onde guardar o arquivo original"
                sizeBytes={file.size}
                options={options}
                chosen={chosen}
                onChoose={setStorage}
                litterboxTime={litterboxTime}
                onLitterboxTime={setLitterboxTime}
              />
            )}
            {file && isMedia && (
              <div className="field">
                <span className="lab">Transcrição</span>
                <div className="opts" role="radiogroup">
                  {ENGINES.filter(engine => engine.id !== 'free' || freeMinutes.kind !== 'invite').map(engine => (
                    <button key={engine.id} className="opt" role="radio" aria-checked={settings.transcription.engine === engine.id} onClick={() => void updateSettings({ transcription: { ...settings.transcription, engine: engine.id as TranscriptionEngine } })}>
                      <span className="radio" />
                      <span>
                        <b>{engine.name}</b>
                        <span>
                          <span className="lim">{engine.limits}</span>
                        </span>
                      </span>
                    </button>
                  ))}
                </div>
                <FreeMinutes check={freeMinutes} />
              </div>
            )}
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
        <div className="two-col">
          <div className="field">
            <label htmlFor="nc-name">Nome (opcional)</label>
            <input className="input" id="nc-name" value={name} onChange={event => setName(event.target.value)} placeholder="Vem da fonte se ficar vazio" />
          </div>
          <div className="field">
            <span className="lab">Pasta</span>
            <FolderPicker value={folderId} onChange={setFolderId} />
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
