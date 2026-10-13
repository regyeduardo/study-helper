import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'

import type { SourceStorage } from '@/types/domain'
import { Dialog } from '@/components/ui/Dialog'
import { Icon } from '@/components/ui/Icon'
import { IntegrationStatus } from '@/components/dialogs/IntegrationStatus'
import { FolderPicker } from '@/components/dialogs/SimpleDialogs'
import { SourceStoragePicker } from '@/components/dialogs/SourceStoragePicker'
import type { LitterboxTime } from '@/controllers/hosting.controller'
import {
  IntegrationCapture,
  type IntegrationDevice,
  IntegrationLink,
  integrationSourceKey,
  integrationSourceOf,
  type IntegrationWindow,
  useIntegrationStore,
} from '@/lib/recording/integration'
import { linkLocalMedia } from '@/lib/recording/media-library'
import { mountMiniplayer } from '@/lib/recording/miniplayer'
import { type AudioInput, CaptureCheck, type CaptureMode, type CheckStatus, COMPUTER_AUDIO_AUTO, COMPUTER_AUDIO_NONE, hears, listAudioInputs, type LiveCapture, playTestSound, SOUND_LEVEL, systemAudioNotice, type VideoFps, VOICE_LEVEL } from '@/lib/recording/recorder'
import { defaultStorage, storageOptions } from '@/lib/storage/source-storage'
import { useAccountStore } from '@/stores/account'
import { useLibraryStore } from '@/stores/library'
import { type Agent, useJobsStore } from '@/stores/jobs'
import { useRecorderStore } from '@/stores/recorder'
import { useSyncStore } from '@/stores/sync'
import { useUiStore } from '@/stores/ui'
import { duration, formatBytes } from '@/utils/format'

function microphoneRefusal(failure: unknown): string {
  const name = failure instanceof Error ? failure.name : ''
  if (name === 'NotFoundError') return 'Nenhum microfone encontrado. Conecte um e clique em Gravar de novo.'
  if (name === 'NotAllowedError' || name === 'SecurityError') return 'Para gravar, libere o microfone deste site no navegador (no cadeado ao lado do endereço) e clique em Gravar de novo.'
  return 'O navegador não liberou o microfone. Confira se outro programa está usando e clique em Gravar de novo.'
}

function clock(seconds: number): string {
  const pad = (value: number) => String(value).padStart(2, '0')
  const hours = Math.floor(seconds / 3600)
  return `${hours ? `${hours}:` : ''}${pad(Math.floor((seconds % 3600) / 60))}:${pad(seconds % 60)}`
}

function windowsByProgram(windows: IntegrationWindow[]): IntegrationWindow[] {
  const seen = new Set<number>()
  return windows.filter(entry => !seen.has(entry.pid) && seen.add(entry.pid))
}

function sourceLabel(key: string, windows: IntegrationWindow[]): string {
  if (key === 'system') return 'todo o som do computador'
  return windows.find(entry => `pid:${entry.pid}` === key)?.title ?? ''
}

function microphonesOf(inputs: AudioInput[]): IntegrationDevice[] {
  return inputs.filter(input => !input.computer && input.label).map(input => ({ id: input.deviceId, label: input.label }))
}

function MicrophoneField({ on, onToggle, id, onId, devices }: { on: boolean; onToggle(): void; id: string; onId(id: string): void; devices: IntegrationDevice[] }) {
  return (
    <div className="field">
      <button className="opt" role="checkbox" aria-checked={on} onClick={onToggle}>
        <span className="radio" style={{ borderRadius: 5 }} />
        <span>
          <b>Gravar o meu microfone</b>
          <span>{on ? 'A sua voz entra na gravação.' : 'Fica desligado; dá para ligar no meio da gravação.'}</span>
        </span>
      </button>
      <label className="lab" htmlFor="rec-microphone">
        Microfone
      </label>
      <select className="input" id="rec-microphone" value={id} onChange={event => onId(event.target.value)}>
        <option value="">Padrão do sistema</option>
        {devices.map(device => (
          <option key={device.id} value={device.id}>
            {device.label}
          </option>
        ))}
      </select>
    </div>
  )
}

function IntegrationSourceOptions({ windows, listing }: { windows: IntegrationWindow[]; listing: 'windows' | 'programs' }) {
  return (
    <>
      <option value="system">Sistema inteiro (todo o som do computador)</option>
      <optgroup label={listing === 'windows' ? 'Uma janela aberta' : 'Um programa aberto'}>
        {windowsByProgram(windows).map(entry => (
          <option key={entry.id} value={`pid:${entry.pid}`}>
            {entry.title}
            {entry.app && entry.app !== entry.title ? ` · ${entry.app}` : ''}
          </option>
        ))}
      </optgroup>
      <option value="none">Nenhum som do computador</option>
    </>
  )
}

function useDestination(place: SourceStorage | null): SourceStorage {
  const driveAvailable = useAccountStore(state => state.active().kind === 'google')
  return place ?? (driveAvailable ? 'drive' : 'none')
}

function ScreenAndPlace({ fps, onFps, place, onPlace }: { fps: VideoFps | null; onFps(fps: VideoFps | null): void; place: SourceStorage | null; onPlace(place: SourceStorage): void }) {
  const driveAvailable = useAccountStore(state => state.active().kind === 'google')
  const destination = useDestination(place)
  return (
    <div className="row2">
      <div className="field">
        <span className="lab">Gravar a tela</span>
        <div className="opts" role="radiogroup">
          {(
            [
              [null, 'Não', 'Só o som'],
              [5, '5 fps', 'Modo leitura: slides e documentos, arquivo leve'],
              [30, '30 fps', 'Movimento fluido, arquivo bem maior'],
            ] as [VideoFps | null, string, string][]
          ).map(([value, label, hint]) => (
            <button key={label} className="opt" role="radio" aria-checked={fps === value} onClick={() => onFps(value)}>
              <span className="radio" />
              <span>
                <b>{label}</b>
                <span>{hint}</span>
              </span>
            </button>
          ))}
        </div>
        {fps && <span className="faint" style={{ fontSize: 12 }}>Escolha a janela ou a aba da reunião: a janelinha de controle não aparece no vídeo. Na tela inteira, ela aparece.</span>}
      </div>
      <div className="field">
        <span className="lab">Onde salvar</span>
        <div className="opts" role="radiogroup">
          <button className="opt" role="radio" aria-checked={destination === 'none'} onClick={() => onPlace('none')}>
            <span className="radio" />
            <span>
              <b>Neste computador</b>
              <span>Fica em Mídias, neste navegador.</span>
            </span>
          </button>
          <button className="opt" role="radio" aria-checked={destination === 'drive'} aria-disabled={!driveAvailable} onClick={() => driveAvailable && onPlace('drive')}>
            <span className="radio" />
            <span>
              <b>Google Drive</b>
              <span>{driveAvailable ? 'Também vai para o seu Drive. Dá para trocar no fim.' : 'Entre com o Google para guardar no Drive.'}</span>
            </span>
          </button>
        </div>
      </div>
    </div>
  )
}

const NOTHING_CHECKED: CheckStatus = { preview: null, meters: { microphone: null, computer: null }, microphone: 'off', computerAudio: '', refused: [], fromDisplay: false }

function useHeard(analyser: AnalyserNode | null, level: number): boolean {
  const [heard, setHeard] = useState(false)
  useEffect(() => {
    setHeard(false)
    if (!analyser) return
    const timer = window.setInterval(() => setHeard(before => before || hears(analyser, level)), 200)
    return () => window.clearInterval(timer)
  }, [analyser, level])
  return heard
}

function CheckLine({ ok, children }: { ok: boolean; children: ReactNode }) {
  return (
    <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start', fontSize: 12.5 }}>
      <Icon name={ok ? 'check' : 'info'} />
      <div style={{ display: 'flex', gap: '6px 8px', alignItems: 'center', flexWrap: 'wrap', flex: 1, minWidth: 0 }}>{children}</div>
    </div>
  )
}

interface CaptureCheckFieldProps {
  status: CheckStatus
  mode: CaptureMode
  fps: VideoFps | null
  computerOff: boolean
  soundHint: string | null
  onPick(): void
  onTestSound(): Promise<boolean>
}

function CaptureCheckField({ status, mode, fps, computerOff, soundHint, onPick, onTestSound }: CaptureCheckFieldProps) {
  const player = useRef<HTMLDivElement>(null)
  const [sound, setSound] = useState<'idle' | 'playing' | 'heard' | 'silent'>('idle')
  const microphoneHeard = useHeard(status.meters.microphone, VOICE_LEVEL)
  const computerHeard = useHeard(status.meters.computer, SOUND_LEVEL)
  useEffect(() => (player.current ? mountMiniplayer(player.current, status) : undefined), [status])
  useEffect(() => setSound('idle'), [status.meters.computer, status.computerAudio])
  const shares = mode === 'tab' || mode === 'screen'
  const surface = mode === 'tab' ? 'aba' : mode === 'screen' ? 'tela' : 'janela'
  const chosen = mode === 'tab' ? 'Aba escolhida' : mode === 'screen' ? 'Tela escolhida' : 'Janela escolhida'
  const play = async () => {
    setSound('playing')
    setSound((await onTestSound()) ? 'heard' : 'silent')
  }
  return (
    <div className="field" role="group" aria-label="Confira antes de gravar">
      <span className="lab">Confira antes de gravar</span>
      <div className="player" ref={player} aria-label="Ondas antes de gravar" style={{ height: 140, borderRadius: 8, overflow: 'hidden' }} />
      <CheckLine ok={microphoneHeard}>
        <span>
          {status.microphone === 'off' ? 'Microfone desligado.' : status.microphone === 'refused' ? 'O navegador não liberou o microfone.' : microphoneHeard ? 'Microfone captando.' : 'Fale algo: ainda não ouvi o microfone.'}
        </span>
      </CheckLine>
      <CheckLine ok={computerHeard || sound === 'heard'}>
        <span>
          {status.meters.computer
            ? `Som do computador: ${status.computerAudio}${computerHeard ? ' · chegando som.' : ''}`
            : computerOff
              ? 'Som do computador desligado.'
              : shares
                ? `Aqui o som do computador vem junto com a ${surface}: escolha a ${surface} abaixo para conferir agora.`
                : 'Nenhuma entrada de som do computador abriu.'}
        </span>
        {status.meters.computer && !soundHint && (
          <button className="btn" style={{ height: 26, padding: '0 10px' }} disabled={sound === 'playing'} onClick={() => void play()}>
            <Glyph name="play" />
            Tocar som de teste
          </button>
        )}
      </CheckLine>
      {status.meters.computer && soundHint && <span className="faint" style={{ fontSize: 12 }}>{soundHint}</span>}
      {sound === 'heard' && <span style={{ fontSize: 12.5 }}>O som de teste foi capturado.</span>}
      {sound === 'silent' && (
        <div className="banner" role="alert">
          <Icon name="warn" />
          <span>O som de teste não chegou no som do computador. Escolha outra entrada em "Som do computador" acima e toque de novo.</span>
        </div>
      )}
      {status.refused.length > 0 && (
        <div className="banner" role="alert">
          <Icon name="warn" />
          <span>O navegador não abriu: {status.refused.join(', ')}.</span>
        </div>
      )}
      {(shares || fps !== null) && (
        <CheckLine ok={status.preview !== null}>
          {status.preview && <span>{chosen}: é ela que vai ser gravada.</span>}
          <button className="btn" style={{ height: 26, padding: '0 10px' }} onClick={onPick}>
            <Icon name="monitor" />
            {status.preview ? `Trocar a ${surface}` : `Escolher a ${surface} agora`}
          </button>
        </CheckLine>
      )}
    </div>
  )
}

function IntegrationRecord() {
  const ui = useUiStore()
  const startIntegration = useRecorderStore(state => state.startIntegration)
  const [windows, setWindows] = useState<IntegrationWindow[]>([])
  const [microphones, setMicrophones] = useState<IntegrationDevice[]>([])
  const [listing, setListing] = useState<'windows' | 'programs'>('windows')
  const [choice, setChoice] = useState('system')
  const [microphoneOn, setMicrophoneOn] = useState(true)
  const [microphoneId, setMicrophoneId] = useState('')
  const [capture, setCapture] = useState<IntegrationCapture | null>(null)
  const [fps, setFps] = useState<VideoFps | null>(null)
  const [place, setPlace] = useState<SourceStorage | null>(null)
  const destination = useDestination(place)
  const [error, setError] = useState<string | null>(null)
  const handed = useRef(false)
  const refresh = async () => {
    const link = await IntegrationLink.open()
    if (!link) {
      setError('A integração não respondeu. Confira se ela está aberta.')
      return
    }
    try {
      const found = await link.sources()
      setWindows(found.windows)
      setListing(found.listing)
      setMicrophones((await link.microphones().catch(() => ({ microphones: [] }))).microphones)
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'A integração não listou as janelas.')
    } finally {
      link.close()
    }
  }
  useEffect(() => {
    void refresh()
  }, [])
  const label = sourceLabel(choice, windows)
  useEffect(() => {
    let alive = true
    let current: IntegrationCapture | null = null
    setCapture(null)
    setError(null)
    IntegrationCapture.start(integrationSourceOf(choice), label, microphoneId || null)
      .then(started => {
        if (!alive) {
          void started.stop()
          return
        }
        current = started
        setCapture(started)
      })
      .catch((failure: unknown) => alive && setError(failure instanceof Error ? failure.message : 'A integração não começou a ouvir.'))
    return () => {
      alive = false
      if (current && !handed.current) void current.stop()
    }
  }, [choice, microphoneId])
  const status = useMemo<CheckStatus | null>(
    () =>
      capture && {
        preview: null,
        meters: { microphone: microphoneOn ? capture.meters.microphone : null, computer: choice === 'none' ? null : capture.meters.computer },
        microphone: microphoneOn ? 'open' : 'off',
        computerAudio: capture.label,
        refused: [],
        fromDisplay: false,
      },
    [capture, microphoneOn, choice],
  )
  const nothing = !microphoneOn && choice === 'none'
  const start = async () => {
    if (!capture || nothing) return
    handed.current = true
    try {
      await startIntegration(capture, { microphoneOn, microphoneId: microphoneId || null, video: fps ? { fps } : null, destination })
      ui.close()
    } catch (failure) {
      handed.current = false
      setError(failure instanceof Error ? failure.message : 'Não deu para começar a gravar.')
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
          <button className="btn primary" onClick={() => void start()} disabled={!capture || nothing}>
            <Icon name="rec" />
            Começar a gravar
          </button>
        </>
      }
    >
      <div className="db">
        <IntegrationStatus />
        <div className="field">
          <label className="lab" htmlFor="rec-integration">
            Som do computador
          </label>
          <select className="input" id="rec-integration" value={choice} onChange={event => setChoice(event.target.value)}>
            <IntegrationSourceOptions windows={windows} listing={listing} />
          </select>
          <span className="faint" style={{ fontSize: 12 }}>
            {listing === 'programs' ? 'Este sistema não deixa listar as janelas, então aparecem os programas. ' : ''}
            Uma janela que ainda está sem som pode ser escolhida: o som dela entra quando ela tocar.{' '}
            <button className="btn quiet" style={{ height: 24, padding: '0 8px' }} onClick={() => void refresh()}>
              Atualizar a lista
            </button>
          </span>
        </div>
        <MicrophoneField on={microphoneOn} onToggle={() => setMicrophoneOn(!microphoneOn)} id={microphoneId} onId={setMicrophoneId} devices={microphones} />
        <ScreenAndPlace fps={fps} onFps={setFps} place={place} onPlace={setPlace} />
        {status && capture ? (
          <CaptureCheckField
            status={status}
            mode="integration"
            fps={null}
            computerOff={choice === 'none'}
            soundHint={choice.startsWith('pid:') ? 'Faça som na janela escolhida: a onda verde e o aviso "chegando som" mostram o que chega.' : null}
            onPick={() => undefined}
            onTestSound={() => playTestSound(capture.context, capture.meters.computer!)}
          />
        ) : (
          <div className="field">
            <span className="lab">Confira antes de gravar</span>
            <span className="faint" style={{ fontSize: 12 }}>{error ? '' : 'Ligando o som…'}</span>
          </div>
        )}
        {nothing && <span className="faint" style={{ fontSize: 12 }}>Ligue o microfone ou escolha um som do computador.</span>}
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

export function RecordDialog() {
  const ui = useUiStore()
  const recorder = useRecorderStore()
  const integration = useIntegrationStore(state => state.status)
  const [mode, setMode] = useState<CaptureMode>('tab')
  const [computerAudio, setComputerAudio] = useState(COMPUTER_AUDIO_AUTO)
  const [microphoneOn, setMicrophoneOn] = useState(true)
  const [microphoneId, setMicrophoneId] = useState('')
  const [fps, setFps] = useState<VideoFps | null>(null)
  const [place, setPlace] = useState<SourceStorage | null>(null)
  const [inputs, setInputs] = useState<AudioInput[]>([])
  const [error, setError] = useState<string | null>(null)
  const [allowed, setAllowed] = useState(false)
  const destination = useDestination(place)
  const supported = Boolean(navigator.mediaDevices?.getDisplayMedia) && typeof MediaRecorder !== 'undefined'
  useEffect(() => {
    if (recorder.active) {
      setAllowed(true)
      return
    }
    let alive = true
    void (async () => {
      try {
        const found = await listAudioInputs(true)
        void navigator.storage?.persist?.().catch(() => false)
        if (!alive) return
        setInputs(found)
        setAllowed(true)
      } catch (failure) {
        if (!alive) return
        ui.close()
        ui.toast(microphoneRefusal(failure))
      }
    })()
    return () => {
      alive = false
    }
  }, [])
  const check = useRef<CaptureCheck | null>(null)
  const [status, setStatus] = useState<CheckStatus>(NOTHING_CHECKED)
  const checking = allowed && !recorder.active && integration !== 'connected'
  const listening = { microphoneOn, microphoneId: microphoneId || null, computerAudio }
  useEffect(() => {
    if (!checking) return
    check.current ??= new CaptureCheck(setStatus)
    void check.current.listen(listening)
  }, [checking, microphoneOn, microphoneId, computerAudio])
  useEffect(() => {
    if (!check.current || !checking) return
    check.current.dropDisplay()
    void check.current.listen(listening)
  }, [mode, fps])
  useEffect(() => () => void check.current?.stop(), [])
  const named = inputs.some(input => input.label)
  const detected = inputs.filter(input => input.computer)
  const findInputs = async () => {
    try {
      setInputs(await listAudioInputs(true))
    } catch {
      setError('Sem a permissão do microfone o navegador não mostra o nome das entradas de som.')
    }
  }
  if (!allowed) return null
  if (recorder.active) {
    return (
      <Dialog title="Gravar reunião" size="narrow" onClose={ui.close}>
        <div className="db">Já tem uma gravação em andamento.</div>
      </Dialog>
    )
  }
  if (integration === 'connected') return <IntegrationRecord />
  const nothing = !microphoneOn && mode === 'microphone' && computerAudio === COMPUTER_AUDIO_NONE
  const start = async () => {
    setError(null)
    const display = check.current?.handDisplay() ?? null
    await check.current?.stop()
    try {
      await recorder.start(mode, computerAudio, { microphoneOn, microphoneId: microphoneId || null, video: fps ? { fps } : null, destination, ...(display ? { display } : {}) })
      ui.close()
    } catch (failure) {
      setError(failure instanceof Error && failure.name === 'NotAllowedError' ? 'Você não deu permissão para gravar.' : failure instanceof Error ? failure.message : 'Não deu para começar a gravar.')
      void check.current?.listen(listening)
    }
  }
  const pick = () => void check.current?.pickDisplay(mode, fps).catch(() => undefined)
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
          <button className="btn primary" onClick={() => void start()} disabled={(!supported && mode !== 'microphone') || nothing}>
            <Icon name="rec" />
            Começar a gravar
          </button>
        </>
      }
    >
      <div className="db">
        <IntegrationStatus />
        <div className="field">
          <span className="lab">O que gravar</span>
          <div className="opts" role="radiogroup">
            <button className="opt" role="radio" aria-checked={mode === 'tab'} onClick={() => setMode('tab')}>
              <span className="radio" />
              <span>
                <b>A aba da reunião</b>
                <span>Meet, Teams ou Zoom no navegador. Grava o som da aba.</span>
              </span>
            </button>
            <button className="opt" role="radio" aria-checked={mode === 'screen'} onClick={() => setMode('screen')}>
              <span className="radio" />
              <span>
                <b>A tela inteira</b>
                <span>Para reunião em app instalado. Grava o som do computador que a tela entregar.</span>
              </span>
            </button>
            <button className="opt" role="radio" aria-checked={mode === 'microphone'} onClick={() => setMode('microphone')}>
              <span className="radio" />
              <span>
                <b>Sem compartilhar a tela</b>
                <span>Reunião presencial, aula ou app de reunião: grava o som do computador escolhido abaixo.</span>
              </span>
            </button>
          </div>
        </div>
        {/Firefox\//.test(navigator.userAgent) && (
          <div className="banner" role="note" aria-label="Aviso do Firefox">
            <Icon name="warn" />
            <span>No Firefox o som do computador não vem junto com a tela ou a aba: ele vem da entrada do sistema ("Monitor of…" no Linux, "Mixagem estéreo" no Windows), e o Automático abaixo já pega todas. Escolha "Sem compartilhar a tela" para gravar o seu microfone e todo o som do computador.</span>
          </div>
        )}
        <div className="field">
          <label className="lab" htmlFor="rec-computer">
            Som do computador
          </label>
          <select className="input" id="rec-computer" value={computerAudio} onChange={event => setComputerAudio(event.target.value)}>
            <option value={COMPUTER_AUDIO_AUTO}>{detected.length > 1 ? 'Automático · todas as saídas de som do computador' : detected.length ? `Automático · ${detected[0].label}` : 'Automático'}</option>
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
            {named && !detected.length && ' Nenhuma entrada de som do computador apareceu aqui: neste navegador o som do computador só vem da aba ou da tela compartilhada, e o microfone chega mudo se outra chamada estiver usando ele. Para gravar o seu microfone e todo o som do computador, use o Firefox.'}
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
        <MicrophoneField on={microphoneOn} onToggle={() => setMicrophoneOn(!microphoneOn)} id={microphoneId} onId={setMicrophoneId} devices={microphonesOf(inputs)} />
        {nothing && <span className="faint">Ligue o microfone ou escolha um som do computador.</span>}
        <ScreenAndPlace fps={fps} onFps={setFps} place={place} onPlace={setPlace} />
        <CaptureCheckField status={status} mode={mode} fps={fps} computerOff={computerAudio === COMPUTER_AUDIO_NONE} soundHint={status.fromDisplay && mode === 'tab' ? 'Faça som na aba escolhida: a onda verde e o aviso "chegando som" mostram o que chega.' : null} onPick={pick} onTestSound={() => check.current?.testSound() ?? Promise.resolve(false)} />
        <div className="banner info">
          <Icon name="info" />
          <span>Um miniplayer mostra o que está sendo gravado, com as ondas do microfone e do som do computador, o tempo, e deixa pausar, ligar e desligar cada som e trocar as fontes. O arquivo é gravado em pedaços no navegador, então reunião longa não pesa. Parar pela barra do navegador também termina.</span>
        </div>
        <button className="btn quiet" style={{ justifySelf: 'start' }} onClick={() => ui.open({ kind: 'media' })}>
          <Icon name="mic" />
          Ver as gravações guardadas neste computador
        </button>
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

function Miniplayer({ live }: { live: LiveCapture | null }) {
  const container = useRef<HTMLDivElement>(null)
  useEffect(() => (live && container.current ? mountMiniplayer(container.current, live) : undefined), [live])
  return <div className={live?.preview ? 'player screen' : 'player'} ref={container} />
}

function useSwitchOptions(mode: CaptureMode | null) {
  const [microphones, setMicrophones] = useState<IntegrationDevice[]>([])
  const [windows, setWindows] = useState<IntegrationWindow[]>([])
  const [listing, setListing] = useState<'windows' | 'programs'>('windows')
  const [inputs, setInputs] = useState<AudioInput[]>([])
  useEffect(() => {
    let alive = true
    void (async () => {
      if (mode === 'integration') {
        const link = await IntegrationLink.open()
        if (!link) return
        try {
          const found = await link.sources()
          const devices = await link.microphones().catch(() => ({ microphones: [] }))
          if (!alive) return
          setWindows(found.windows)
          setListing(found.listing)
          setMicrophones(devices.microphones)
        } catch {
          return
        } finally {
          link.close()
        }
      } else {
        const found = await listAudioInputs().catch(() => [])
        if (!alive) return
        setInputs(found)
        setMicrophones(microphonesOf(found))
      }
    })()
    return () => {
      alive = false
    }
  }, [mode])
  return { microphones, windows, listing, inputs }
}

const GLYPHS = {
  speaker: <path d="M4 9.5v5h3.5L12 18V6L7.5 9.5zM15.5 9a4 4 0 0 1 0 6M18 6.5a7.5 7.5 0 0 1 0 11" />,
  window: <path d="M4 6.5a1.5 1.5 0 0 1 1.5-1.5h13A1.5 1.5 0 0 1 20 6.5v11a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 17.5zM4 9.5h16M7 7.3h.01M9.5 7.3h.01" />,
  flag: <path d="M6 21V4.5M6 5h11l-2 3.5 2 3.5H6" />,
  play: <path d="M8 5.5v13l10.5-6.5z" />,
}

interface TileProps {
  label: string
  name: string
  icon: ReactNode
  pressed?: boolean
  expanded?: boolean
  disabled?: boolean
  onClick(): void
}

function Tile({ label, name, icon, pressed, expanded, disabled, onClick }: TileProps) {
  return (
    <button className="tile" aria-label={name} title={name} aria-pressed={pressed} aria-expanded={expanded} disabled={disabled} onClick={onClick}>
      {icon}
      <span>{label}</span>
    </button>
  )
}

function Glyph({ name }: { name: keyof typeof GLYPHS }) {
  return (
    <svg className="ic" viewBox="0 0 24 24" aria-hidden="true">
      {GLYPHS[name]}
    </svg>
  )
}

function counted(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`
}

function RecordingControls() {
  const { seconds, mode, live, floating, marks, finish, cancel, pause, resume, setEnabled, setScreen, switchScreen, mark, annotate, switchMicrophone, switchComputerInput, reshare, switchIntegrationSource, openFloating } = useRecorderStore()
  const toast = useUiStore(state => state.toast)
  const [confirming, setConfirming] = useState(false)
  const [blocked, setBlocked] = useState(false)
  const [panel, setPanel] = useState<'sources' | 'note' | null>(null)
  const [note, setNote] = useState('')
  const options = useSwitchOptions(mode)
  const attempt = (action: () => Promise<void>) => void action().catch(failure => toast(failure instanceof Error ? failure.message : 'Não deu para trocar.'))
  const what = mode === 'tab' ? 'a aba' : mode === 'screen' ? 'a tela' : mode === 'integration' && live?.computerAudio ? live.computerAudio : 'o microfone'
  const microphoneOn = live?.microphoneOn ?? true
  const sourceOn = Boolean(live?.hasSource && live.sourceOn)
  const screenOn = Boolean(live?.screenOn)
  const flags = marks.filter(item => item.kind === 'mark').length
  const notes = marks.length - flags
  const keepNote = () => {
    if (note.trim()) annotate(note.trim())
    setNote('')
    setPanel(null)
  }
  return (
    <>
      <div className="bar-top">
        <Icon name="monitor" />
        <span style={{ flex: 1 }}>Gravando {what}</span>
        {!floating && (
          <button className="btn" style={{ height: 24, padding: '0 8px', fontSize: 11.5 }} aria-label="Abrir em janela própria" title="Abrir em janela própria" onClick={() => void openFloating().then(opened => setBlocked(!opened))}>
            <Icon name="monitor" />
            Destacar
          </button>
        )}
      </div>
      {blocked && !floating && <div className="source">O navegador bloqueou a janela: libere as janelas deste site e tente de novo.</div>}
      <div className="body">
        <div className="mini-head">
          <div className="timer">
            {clock(seconds)}
            {live?.paused ? <span className="faint" style={{ fontSize: 13 }}>pausado</span> : null}
          </div>
          <Miniplayer live={live} />
        </div>
        <div className="tiles">
          <Tile label="Microfone" name={microphoneOn ? 'Desligar o microfone' : 'Ligar o microfone'} icon={<Icon name="mic" />} pressed={microphoneOn} onClick={() => setEnabled('microphone', !microphoneOn)} />
          <Tile label="Som do PC" name={sourceOn ? 'Desligar o som do computador' : 'Ligar o som do computador'} icon={<Glyph name="speaker" />} pressed={sourceOn} disabled={!live?.hasSource} onClick={() => setEnabled('source', !sourceOn)} />
          <Tile label={live?.paused ? 'Continuar' : 'Pausar'} name={live?.paused ? 'Continuar' : 'Pausar'} icon={live?.paused ? <Glyph name="play" /> : <Icon name="pause" />} onClick={() => (live?.paused ? resume() : pause())} />
          <Tile label="Gravar tela" name={screenOn ? 'Desligar a gravação de tela' : 'Ligar a gravação de tela'} icon={<Icon name="monitor" />} pressed={screenOn} onClick={() => attempt(() => setScreen(!screenOn))} />
          <Tile label="Trocar janela" name="Trocar janela" icon={<Glyph name="window" />} expanded={panel === 'sources'} onClick={() => setPanel(panel === 'sources' ? null : 'sources')} />
          <Tile label="Trocar tela" name="Trocar tela" icon={<Icon name="swap" />} disabled={!screenOn} onClick={() => attempt(switchScreen)} />
          <Tile label="Marcar" name="Marcar momento" icon={<Glyph name="flag" />} onClick={mark} />
          <Tile label="Anotar" name="Anotar" icon={<Icon name="pen" />} expanded={panel === 'note'} onClick={() => setPanel(panel === 'note' ? null : 'note')} />
        </div>
        {panel === 'note' && (
          <input
            className="input"
            aria-label="Anotação"
            placeholder="Anotação deste momento · Enter guarda"
            autoFocus
            value={note}
            onChange={event => setNote(event.target.value)}
            onKeyDown={event => {
              if (event.key === 'Enter') keepNote()
              if (event.key === 'Escape') setPanel(null)
            }}
          />
        )}
        {panel === 'sources' && (
          <div className="mini-panel">
            <label className="lab" htmlFor="live-microphone">
              Microfone
            </label>
            <select className="input" id="live-microphone" value={live?.microphoneId ?? ''} onChange={event => attempt(() => switchMicrophone(event.target.value || null))}>
              <option value="">Padrão do sistema</option>
              {options.microphones.map(device => (
                <option key={device.id} value={device.id}>
                  {device.label}
                </option>
              ))}
            </select>
            <label className="lab" htmlFor="live-source">
              Som do computador
            </label>
            {mode === 'integration' ? (
              <select
                className="input"
                id="live-source"
                value={live?.sourceChoice ?? 'system'}
                onChange={event => {
                  const key = event.target.value
                  attempt(() => switchIntegrationSource({ source: integrationSourceOf(key), label: sourceLabel(key, options.windows) }))
                }}
              >
                <IntegrationSourceOptions windows={options.windows} listing={options.listing} />
              </select>
            ) : (
              <select className="input" id="live-source" value={live?.sourceChoice === 'display' ? 'display' : (live?.sourceChoice ?? COMPUTER_AUDIO_NONE)} onChange={event => attempt(() => (event.target.value === 'display' ? reshare() : switchComputerInput(event.target.value)))}>
                {(mode === 'tab' || mode === 'screen') && <option value="display">{mode === 'tab' ? 'Som da aba compartilhada' : 'Som da tela compartilhada'}</option>}
                <option value={COMPUTER_AUDIO_AUTO}>Automático · entradas de som do computador</option>
                {options.inputs
                  .filter(input => input.computer)
                  .map(input => (
                    <option key={input.deviceId} value={input.deviceId}>
                      {input.label}
                    </option>
                  ))}
                <option value={COMPUTER_AUDIO_NONE}>Nenhum som do computador</option>
              </select>
            )}
          </div>
        )}
        {!panel && (live?.computerAudio || marks.length > 0) && (
          <div className="mini-info">
            {live?.computerAudio && <span>Som do computador: {live.computerAudio}</span>}
            {marks.length > 0 && <span>{[flags && counted(flags, 'marcação', 'marcações'), notes && counted(notes, 'anotação', 'anotações')].filter(Boolean).join(' · ')}</span>}
          </div>
        )}
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
    </>
  )
}

function RecordingDoneOptions({ place }: { place: 'dialog' | 'window' }) {
  const { result, clearResult } = useRecorderStore()
  const account = useAccountStore(state => state.active())
  const limit = useLibraryStore(state => state.index.settings.storageLimitBytes)
  const usage = useSyncStore(state => state.usage)
  const startNewContent = useJobsStore(state => state.startNewContent)
  const toast = useUiStore(state => state.toast)
  const [agent, setAgent] = useState<Agent>('meeting')
  const [folderId, setFolderId] = useState<string | null>(null)
  const [storage, setStorage] = useState<SourceStorage | null>(null)
  const [litterboxTime, setLitterboxTime] = useState<LitterboxTime>('72h')
  if (!result) return null
  const driveAvailable = account.kind === 'google'
  const room = usage && limit ? limit - usage.appBytes : null
  const options = storageOptions(result.file.size, driveAvailable, room)
  const preferred = storage ?? result.destination ?? null
  const chosen: SourceStorage = preferred && options.some(option => option.id === preferred && option.fits && option.enabled) ? preferred : defaultStorage(driveAvailable, options)
  const later = () => {
    clearResult()
    toast('A gravação ficou salva em Mídias')
  }
  const go = () => {
    const { file, storedName, marks } = result
    clearResult()
    setStorage(null)
    void startNewContent({ agent, input: { kind: 'recording', file }, name: '', description: '', folderId, prompt: '', storage: chosen, litterboxTime, marks }).then(fileId => {
      if (fileId) void linkLocalMedia(storedName, fileId)
    })
  }
  const actions = (
    <>
      <button className="btn quiet" onClick={later}>
        Só salvar
      </button>
      <button className="btn primary" onClick={go}>
        Transcrever e gerar
      </button>
    </>
  )
  const body = (
    <div className="db">
      <span className="muted">
        {duration(result.durationSeconds)} · {formatBytes(result.file.size)} · {result.mime || result.file.type}
      </span>
      <div className="banner info">
        <Icon name="check" />
        <span>A gravação já está guardada neste computador, em Mídias, e só sai de lá quando você apagar.</span>
      </div>
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
      <SourceStoragePicker
        label="Guardar também na nuvem?"
        sizeBytes={result.file.size}
        options={options}
        chosen={chosen}
        onChoose={setStorage}
        litterboxTime={litterboxTime}
        onLitterboxTime={setLitterboxTime}
        names={{ none: { name: 'Não, só neste computador', description: 'Fica só em Mídias, neste navegador. A nota guarda o nome da gravação.' } }}
      />
      <div className="field">
        <span className="lab">Pasta</span>
        <FolderPicker value={folderId} onChange={setFolderId} />
      </div>
    </div>
  )
  if (place === 'dialog') {
    return (
      <Dialog title="Gravação pronta" size="narrow" onClose={later} footer={actions}>
        {body}
      </Dialog>
    )
  }
  return (
    <>
      <div className="bar-top">
        <Icon name="check" />
        <span style={{ flex: 1 }}>Gravação pronta</span>
      </div>
      <div className="body">
        {body}
        <div className="acts">{actions}</div>
      </div>
    </>
  )
}

function FloatingContent() {
  const active = useRecorderStore(state => state.active)
  const done = useRecorderStore(state => Boolean(state.result) && state.resultPlace === 'window')
  const paused = useRecorderStore(state => state.live?.paused)
  if (!active && !done) return null
  return (
    <div className={`mini-rec${done ? ' done' : ''}${paused ? ' paused' : ''}`} role="dialog" aria-label={done ? 'Gravação pronta' : 'Gravação em andamento'}>
      {done ? <RecordingDoneOptions place="window" /> : <RecordingControls />}
    </div>
  )
}

export function RecordingWindow() {
  const active = useRecorderStore(state => state.active)
  const floating = useRecorderStore(state => state.floating)
  const done = useRecorderStore(state => Boolean(state.result) && state.resultPlace === 'window')
  const paused = useRecorderStore(state => state.live?.paused)
  useEffect(() => {
    if (!floating) return
    const container = floating.document.createElement('div')
    floating.document.body.appendChild(container)
    const root = createRoot(container)
    root.render(<FloatingContent />)
    return () => {
      queueMicrotask(() => {
        root.unmount()
        container.remove()
      })
    }
  }, [floating])
  if (!active && !done) return null
  if (floating) {
    return (
      <div className="mini-rec" role="status" aria-label="Gravação na janela flutuante">
        <div className="bar-top">
          <Icon name="monitor" />
          <span style={{ flex: 1 }}>{done ? 'Gravação pronta na janela flutuante' : 'Gravando na janela flutuante'}</span>
          <button className="ibtn" aria-label="Mostrar a janela flutuante" title="Mostrar a janela flutuante" onClick={() => floating.focus()}>
            <Icon name="monitor" />
          </button>
        </div>
      </div>
    )
  }
  return (
    <div className={`mini-rec${done ? ' done' : ''}${paused ? ' paused' : ''}`} role="dialog" aria-label={done ? 'Gravação pronta' : 'Gravação em andamento'}>
      {done ? <RecordingDoneOptions place="window" /> : <RecordingControls />}
    </div>
  )
}

export function RecordingDoneDialog() {
  const show = useRecorderStore(state => Boolean(state.result) && state.resultPlace === 'dialog')
  return show ? <RecordingDoneOptions place="dialog" /> : null
}
