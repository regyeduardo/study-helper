import { useState } from 'react'
import { useNavigate } from 'react-router-dom'

import type { SourceStorage } from '@/types/domain'
import { Dialog } from '@/components/ui/Dialog'
import { Icon } from '@/components/ui/Icon'
import { FolderPicker } from '@/components/dialogs/SimpleDialogs'
import { type CaptureMode, systemAudioNotice } from '@/lib/recording/recorder'
import { paths } from '@/lib/paths'
import { defaultStorage, storageOptions } from '@/lib/storage/source-storage'
import { useAccountStore } from '@/stores/account'
import { type Agent, useJobsStore } from '@/stores/jobs'
import { useRecorderStore } from '@/stores/recorder'
import { useUiStore } from '@/stores/ui'
import { duration, formatBytes } from '@/utils/format'

export function RecordDialog() {
  const ui = useUiStore()
  const recorder = useRecorderStore()
  const [mode, setMode] = useState<CaptureMode>('tab')
  const [error, setError] = useState<string | null>(null)
  const supported = Boolean(navigator.mediaDevices?.getDisplayMedia) && typeof MediaRecorder !== 'undefined'
  if (recorder.active) {
    return (
      <Dialog title="Gravar reunião" size="narrow" onClose={ui.close}>
        <div className="db">Já tem uma gravação em andamento.</div>
      </Dialog>
    )
  }
  const start = async () => {
    setError(null)
    try {
      await recorder.start(mode)
      ui.close()
    } catch (failure) {
      setError(failure instanceof Error && failure.name === 'NotAllowedError' ? 'Você não deu permissão para gravar.' : failure instanceof Error ? failure.message : 'Não deu para começar a gravar.')
    }
  }
  return (
    <Dialog
      title="Gravar reunião"
      size="narrow"
      onClose={ui.close}
      footer={
        <>
          <button className="btn quiet" onClick={ui.close}>
            Cancelar
          </button>
          <button className="btn primary" onClick={() => void start()} disabled={!supported && mode !== 'microphone'}>
            <Icon name="rec" />
            Começar a gravar
          </button>
        </>
      }
    >
      <div className="db">
        <div className="field">
          <span className="lab">O que gravar</span>
          <div className="opts" role="radiogroup">
            <button className="opt" role="radio" aria-checked={mode === 'tab'} onClick={() => setMode('tab')}>
              <span className="radio" />
              <span>
                <b>A aba da reunião</b>
                <span>Meet, Teams ou Zoom no navegador. Grava vídeo e o som da aba, mais o seu microfone.</span>
              </span>
            </button>
            <button className="opt" role="radio" aria-checked={mode === 'screen'} onClick={() => setMode('screen')}>
              <span className="radio" />
              <span>
                <b>A tela inteira</b>
                <span>
                  Para reunião em app instalado. <span className="lim">O som do sistema só vem no Chrome/Edge do Windows, do ChromeOS e do macOS 14.2+.</span>
                </span>
              </span>
            </button>
            <button className="opt" role="radio" aria-checked={mode === 'microphone'} onClick={() => setMode('microphone')}>
              <span className="radio" />
              <span>
                <b>Só o microfone</b>
                <span>Reunião presencial ou aula: grava só o áudio.</span>
              </span>
            </button>
          </div>
        </div>
        <div className="banner">
          <Icon name="warn" />
          <span>{systemAudioNotice()}</span>
        </div>
        <div className="banner info">
          <Icon name="info" />
          <span>Uma janelinha fica por cima de tudo com o tempo, Terminar e Cancelar. O arquivo é gravado em pedaços no navegador, então reunião longa não pesa. Parar pela barra do navegador também termina.</span>
        </div>
        {error && (
          <div className="banner" role="alert">
            <Icon name="warn" />
            <span>{error}</span>
          </div>
        )}
      </div>
    </Dialog>
  )
}

function clock(seconds: number): string {
  const pad = (value: number) => String(value).padStart(2, '0')
  const hours = Math.floor(seconds / 3600)
  return `${hours ? `${hours}:` : ''}${pad(Math.floor((seconds % 3600) / 60))}:${pad(seconds % 60)}`
}

export function RecordingWindow() {
  const { active, seconds, mode, finish, cancel } = useRecorderStore()
  const [confirming, setConfirming] = useState(false)
  if (!active) return null
  return (
    <div className="mini-rec" role="dialog" aria-label="Gravação em andamento">
      <div className="bar-top">
        <Icon name="monitor" />
        <span style={{ flex: 1 }}>Gravando {mode === 'tab' ? 'a aba' : mode === 'screen' ? 'a tela' : 'o microfone'}</span>
      </div>
      <div className="body">
        <div className="timer">{clock(seconds)}</div>
        <div className="acts">
          <button className="btn danger" onClick={() => setConfirming(true)}>
            Cancelar
          </button>
          <button className="btn primary" onClick={finish}>
            Terminar
          </button>
        </div>
        {confirming && (
          <div className="inline-confirm">
            Descartar a gravação?
            <button className="btn danger" onClick={() => (setConfirming(false), cancel())}>
              Descartar
            </button>
            <button className="btn quiet" onClick={() => setConfirming(false)}>
              Voltar
            </button>
          </div>
        )}
      </div>
    </div>
  )
}

export function RecordingDoneDialog() {
  const { result, clearResult } = useRecorderStore()
  const account = useAccountStore(state => state.active())
  const startNewContent = useJobsStore(state => state.startNewContent)
  const navigate = useNavigate()
  const [agent, setAgent] = useState<Agent>('meeting')
  const [folderId, setFolderId] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  if (!result) return null
  const options = storageOptions(result.file.size, account.kind === 'google', null)
  const storage: SourceStorage = defaultStorage(result.file.size, account.kind === 'google', options)
  const go = async () => {
    setBusy(true)
    const fileId = await startNewContent({ agent, input: { kind: 'recording', file: result.file }, name: '', description: '', folderId, prompt: '', storage, litterboxTime: '72h' })
    clearResult()
    if (fileId) navigate(paths.file(fileId))
  }
  return (
    <Dialog
      title="Gravação pronta"
      size="narrow"
      onClose={clearResult}
      footer={
        <>
          <button className="btn quiet" onClick={clearResult}>
            Descartar
          </button>
          <button className="btn primary" onClick={() => void go()} disabled={busy}>
            Transcrever e gerar
          </button>
        </>
      }
    >
      <div className="db">
        <span className="muted">
          {duration(result.durationSeconds)} · {formatBytes(result.file.size)} · {result.mime || result.file.type}
        </span>
        <div className="field">
          <span className="lab">O que gerar</span>
          <div className="opts" role="radiogroup">
            {(
              [
                ['meeting', 'Ata de reunião'],
                ['lesson', 'Aula'],
                ['reading', 'Só a transcrição'],
              ] as [Agent, string][]
            ).map(([id, label]) => (
              <button key={id} className="opt" role="radio" aria-checked={agent === id} onClick={() => setAgent(id)}>
                <span className="radio" />
                <span>
                  <b>{label}</b>
                </span>
              </button>
            ))}
          </div>
        </div>
        <div className="field">
          <span className="lab">Pasta</span>
          <FolderPicker value={folderId} onChange={setFolderId} />
        </div>
        <span className="faint" style={{ fontSize: 12 }}>
          A gravação fica guardada em {options.find(option => option.id === storage)?.name ?? 'lugar nenhum'}.
        </span>
      </div>
    </Dialog>
  )
}
