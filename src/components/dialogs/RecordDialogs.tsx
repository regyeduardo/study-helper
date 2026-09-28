import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'

import type { SourceStorage } from '@/types/domain'
import { Dialog } from '@/components/ui/Dialog'
import { Icon } from '@/components/ui/Icon'
import { FolderPicker } from '@/components/dialogs/SimpleDialogs'
import { mountMiniplayer } from '@/lib/recording/miniplayer'
import { type AudioInput, type CaptureMode, COMPUTER_AUDIO_AUTO, COMPUTER_AUDIO_NONE, listAudioInputs, systemAudioNotice } from '@/lib/recording/recorder'
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
  const [computerAudio, setComputerAudio] = useState(COMPUTER_AUDIO_AUTO)
  const [inputs, setInputs] = useState<AudioInput[]>([])
  const [error, setError] = useState<string | null>(null)
  const supported = Boolean(navigator.mediaDevices?.getDisplayMedia) && typeof MediaRecorder !== 'undefined'
  useEffect(() => {
    if (navigator.mediaDevices) void listAudioInputs().then(setInputs).catch(() => undefined)
  }, [])
  const named = inputs.some(input => input.label)
  const detected = inputs.find(input => input.computer)
  const findInputs = async () => {
    try {
      setInputs(await listAudioInputs(true))
    } catch {
      setError('Sem a permissão do microfone o navegador não mostra o nome das entradas de som.')
    }
  }
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
      await recorder.start(mode, computerAudio)
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
                <span>Para reunião em app instalado. Grava a tela, o som do computador e o seu microfone.</span>
              </span>
            </button>
            <button className="opt" role="radio" aria-checked={mode === 'microphone'} onClick={() => setMode('microphone')}>
              <span className="radio" />
              <span>
                <b>Só o microfone</b>
                <span>Reunião presencial ou aula: grava só o áudio (mais o som do computador, se você escolher uma entrada abaixo).</span>
              </span>
            </button>
          </div>
        </div>
        <div className="field">
          <label className="lab" htmlFor="rec-computer">Som do computador</label>
          <select className="input" id="rec-computer" value={computerAudio} onChange={event => setComputerAudio(event.target.value)}>
            <option value={COMPUTER_AUDIO_AUTO}>{detected ? `Automático · ${detected.label}` : 'Automático'}</option>
            {inputs
              .filter(input => input.label)
              .map(input => (
                <option key={input.deviceId} value={input.deviceId}>
                  {input.label}
                  {input.computer ? ' · som do computador' : ''}
                </option>
              ))}
            <option value={COMPUTER_AUDIO_NONE}>Não gravar o som do computador</option>
          </select>
          <span className="faint" style={{ fontSize: 12 }}>
            {systemAudioNotice()}
            {named && !detected && ' Nenhuma entrada de som do computador apareceu aqui: no Linux, com Chrome ou Edge, ligue chrome://flags/#pulseaudio-loopback-for-screen-share, ou grave uma aba.'}
            {!named && (
              <>
                {' '}
                <button className="btn quiet" style={{ height: 24, padding: '0 8px' }} onClick={() => void findInputs()}>
                  Mostrar as entradas de som
                </button>
              </>
            )}
          </span>
        </div>
        <div className="banner info">
          <Icon name="info" />
          <span>Um miniplayer mostra o que está sendo gravado, com as ondas do microfone e do som do computador, o tempo, Terminar e Cancelar. O arquivo é gravado em pedaços no navegador, então reunião longa não pesa. Parar pela barra do navegador também termina.</span>
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

function Miniplayer() {
  const live = useRecorderStore(state => state.live)
  const container = useRef<HTMLDivElement>(null)
  useEffect(() => (live && container.current ? mountMiniplayer(container.current, live) : undefined), [live])
  return <div className="player" ref={container} />
}

export function RecordingWindow() {
  const { active, seconds, mode, live, finish, cancel } = useRecorderStore()
  const [confirming, setConfirming] = useState(false)
  if (!active) return null
  return (
    <div className="mini-rec" role="dialog" aria-label="Gravação em andamento">
      <div className="bar-top">
        <Icon name="monitor" />
        <span style={{ flex: 1 }}>Gravando {mode === 'tab' ? 'a aba' : mode === 'screen' ? 'a tela' : 'o microfone'}</span>
      </div>
      <Miniplayer />
      {live?.computerAudio && <div className="source">Som do computador: {live.computerAudio}</div>}
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
