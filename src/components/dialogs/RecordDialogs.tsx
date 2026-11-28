import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { matchPath } from 'react-router-dom'

import { Dialog } from '@/components/ui/Dialog'
import { Icon } from '@/components/ui/Icon'
import { IntegrationStatus } from '@/components/dialogs/IntegrationStatus'
import { goToNew } from '@/components/dialogs/go-to-new'
import { AtaModelField } from '@/components/dialogs/AtaPartsDialog'
import { lastAta } from '@/components/dialogs/GenerateEntryDialog'
import { MediaAnalysisField, useMediaAnalysis } from '@/components/dialogs/MediaAnalysisField'
import { ModelPick, useModelChoice } from '@/components/dialogs/ModelPick'
import { FolderField } from '@/components/dialogs/FolderChooser'
import {
  IntegrationCapture,
  type IntegrationDevice,
  IntegrationLink,
  integrationSourceKey,
  integrationSourceOf,
  type IntegrationWindow,
  useIntegrationStore,
} from '@/lib/recording/integration'
import { MEDIA_LABEL, recordingName } from '@/lib/file-types'
import { PART_ORDER } from '@/lib/generation/ata'
import { paths } from '@/lib/paths'
import { removeLocalMedia } from '@/lib/recording/media-library'
import { type Lanes, mountMiniplayer } from '@/lib/recording/miniplayer'
import { type AudioInput, CaptureCheck, type RecordingDestination, type CaptureMode, type CheckStatus, COMPUTER_AUDIO_AUTO, COMPUTER_AUDIO_NONE, hears, listAudioInputs, type LiveCapture, playTestSound, SOUND_LEVEL, type StartOptions, systemAudioNotice, type VideoFps, VOICE_LEVEL } from '@/lib/recording/recorder'
import { AUDIO_BITS_PER_SECOND, CHOSEN, OPTIMIZED, VARIANTS } from '@/lib/recording/variants'
import { defaultStorage, storageOptions } from '@/lib/storage/source-storage'
import { useAppAiStore } from '@/lib/ai/app-ai'
import { blocking } from '@/lib/blocking'
import { working } from '@/lib/working'
import { useAccountStore } from '@/stores/account'
import { useLibraryStore } from '@/stores/library'
import { type NoteAgent, type RecordingWrite, useJobsStore } from '@/stores/jobs'
import { useRecorderStore } from '@/stores/recorder'
import { useSyncStore } from '@/stores/sync'
import { useUiStore } from '@/stores/ui'
import { duration, formatBytes } from '@/utils/format'

import '@/styles/record-dialog.css'

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
      <label className="lab" htmlFor="rec-microphone">
        Microfone
      </label>
      <div className="rd-mic">
        <button className="opt" role="checkbox" aria-checked={on} onClick={onToggle}>
          <span className="radio" style={{ borderRadius: 5 }} />
          <b>Gravar o meu microfone</b>
        </button>
        <select className="input" id="rec-microphone" value={id} onChange={event => onId(event.target.value)}>
          <option value="">Padrão do sistema</option>
          {devices.map(device => (
            <option key={device.id} value={device.id}>
              {device.label}
            </option>
          ))}
        </select>
      </div>
      {!on && <span className="faint" style={{ fontSize: 12 }}>Fica desligado; dá para ligar no meio da gravação.</span>}
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

/** The library folder open in the page when the recording starts (the dialog lives over it). */
function openFolderId(): string | null {
  const id = matchPath('/biblioteca/:folderId', window.location.pathname)?.params.folderId ?? null
  return id && useLibraryStore.getState().folders.some(folder => folder.id === id && !folder.deletedAt) ? id : null
}

/** Unchosen: the App with the structure on (owner's choice A, 23/11); a folder has no place, so the open folder never decides (spec 005, FR-018). */
function useDestination(place: RecordingDestination | null): RecordingDestination {
  const driveAvailable = useAccountStore(state => state.active().kind === 'google')
  const appOn = useLibraryStore(state => state.appOn)
  return place ?? (appOn ? 'app' : driveAvailable ? 'drive' : 'none')
}

/** What "Gravar a tela" hands the recorder: nothing, 5 or 30 fps, or the optimized recording (FR-023). */
type VideoChoice = NonNullable<StartOptions['video']> | null

const sameVideo = (a: VideoChoice, b: VideoChoice) => (a?.fps ?? null) === (b?.fps ?? null) && Boolean(a?.optimized) === Boolean(b?.optimized)

/** The heaviest hour a choice can make: its video ceiling plus the audio, in MB (round to tens above 100). */
function megabytesPerHour(videoBitsPerSecond: number): number {
  const megabytes = ((videoBitsPerSecond + AUDIO_BITS_PER_SECOND) * 3600) / 8 / 1e6
  return megabytes >= 100 ? Math.round(megabytes / 10) * 10 : Math.round(megabytes)
}

const SCREEN_CHOICES: { video: VideoChoice; label: string; hint: string; size: string; tag?: string }[] = [
  { video: null, label: 'Não', hint: 'Só o som', size: `cerca de ${megabytesPerHour(0)} MB por hora` },
  { video: { fps: 5 }, label: '5 fps', hint: 'Slides e documentos', size: `até ~${megabytesPerHour(VARIANTS[CHOSEN].videoBitsPerSecond[5])} MB por hora` },
  { video: { fps: 30 }, label: '30 fps', hint: 'Movimento fluido', size: `até ~${megabytesPerHour(VARIANTS[CHOSEN].videoBitsPerSecond[30])} MB por hora` },
  { video: { fps: 30, optimized: true }, label: 'Gravação otimizada', hint: '30 fps ocupando pouco', size: `até ~${megabytesPerHour(OPTIMIZED.videoBitsPerSecond[30])} MB por hora`, tag: 'novo' },
]

interface SideBySideOption<T> {
  value: T
  label: string
  about: string
  /** Cannot be picked: it fades, and why stays readable under the choices. */
  why?: string
}

/** Choices side by side, with what the chosen one does under them (mocks/gravar-reuniao: "O que gravar", "Onde salvar"). */
function SideBySide<T extends string>({ label, options, value, onChange }: { label: string; options: SideBySideOption<T>[]; value: T; onChange(value: T): void }) {
  const chosen = options.find(option => option.value === value)
  return (
    <div className="field">
      <span className="lab">{label}</span>
      <div className="rd-seg" role="radiogroup" aria-label={label}>
        {options.map(option => (
          <button key={option.value} className="rd-segb" role="radio" aria-checked={option.value === value} aria-disabled={option.why ? true : undefined} onClick={() => !option.why && onChange(option.value)}>
            <b>{option.label}</b>
          </button>
        ))}
      </div>
      {chosen && <span className="rd-about">{chosen.about}</span>}
      {options
        .filter(option => option.why)
        .map(option => (
          <span key={option.value} className="rd-about">
            {option.why}
          </span>
        ))}
    </div>
  )
}

function ScreenField({ video, onVideo }: { video: VideoChoice; onVideo(video: VideoChoice): void }) {
  return (
    <div className="field">
      <span className="lab">Gravar a tela</span>
      <div className="opts rd-screen" role="radiogroup" aria-label="Gravar a tela">
        {SCREEN_CHOICES.map(choice => (
          <button key={choice.label} className="opt" role="radio" aria-checked={sameVideo(video, choice.video)} onClick={() => onVideo(choice.video)}>
            <span className="radio" />
            <span>
              <b>{choice.label}</b>
              <span>{choice.hint}</span>
              <span>{choice.size}</span>
            </span>
            {choice.tag && <span className="rd-new">{choice.tag}</span>}
          </button>
        ))}
      </div>
      {video?.optimized && (
        <span className="rd-note">
          <Icon name="info" />
          <span>Para rever trechos: guarda só o que muda na tela e uma imagem nítida de cada tela parada. Rosto e movimento ficam menos nítidos.</span>
        </span>
      )}
      {video && <span className="faint" style={{ fontSize: 12 }}>Escolha a janela ou a aba da reunião: a janelinha de controle não aparece no vídeo. Na tela inteira, ela aparece.</span>}
    </div>
  )
}

function PlaceField({ place, onPlace }: { place: RecordingDestination | null; onPlace(place: RecordingDestination): void }) {
  const driveAvailable = useAccountStore(state => state.active().kind === 'google')
  const appOn = useLibraryStore(state => state.appOn)
  const destination = useDestination(place)
  const options: SideBySideOption<RecordingDestination>[] = [
    { value: 'none', label: 'Neste computador', about: 'Fica em Mídias, neste navegador.' },
    { value: 'drive', label: 'Google Drive', about: 'Também vai para o seu Drive. Dá para trocar no fim.', ...(driveAvailable ? {} : { why: 'Entre com o Google para guardar no Drive.' }) },
    ...(appOn ? [{ value: 'app' as const, label: 'App', about: 'A nota e a mídia ficam no App. Dá para trocar no fim.' }] : []),
  ]
  return <SideBySide label="Onde salvar" options={options} value={destination} onChange={onPlace} />
}

const CAPTURE_OPTIONS: SideBySideOption<'tab' | 'screen' | 'microphone'>[] = [
  { value: 'tab', label: 'Aba da reunião', about: 'Meet, Teams ou Zoom no navegador. Grava o som da aba.' },
  { value: 'screen', label: 'Tela inteira', about: 'Para reunião em app instalado. Grava o som do computador que a tela entregar.' },
  { value: 'microphone', label: 'Sem compartilhar', about: 'Reunião presencial, aula ou app de reunião: grava o som do computador escolhido em "Som do computador".' },
]

/** While recording, the miniplayer: said in one line under the check. */
const MINIPLAYER_NOTE = 'Um miniplayer mostra a gravação e deixa pausar e trocar as fontes. Parar pela barra do navegador também termina.'

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
      <div className="player" ref={player} aria-label="Ondas antes de gravar" style={{ height: 84, borderRadius: 8, overflow: 'hidden' }} />
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
  const [video, setVideo] = useState<VideoChoice>(null)
  const [place, setPlace] = useState<RecordingDestination | null>(null)
  const [folderId] = useState(openFolderId)
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
    // from the click until the recording runs the app is held in the window
    await blocking('Começando a gravar…', async () => {
      handed.current = true
      try {
        await startIntegration(capture, { microphoneOn, microphoneId: microphoneId || null, video, destination, folderId })
        ui.close()
      } catch (failure) {
        handed.current = false
        setError(failure instanceof Error ? failure.message : 'Não deu para começar a gravar.')
      }
    })
  }
  return (
    <Dialog
      title="Gravar reunião"
      size="wide"
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
      <div className="db rd-body">
        <IntegrationStatus />
        <div className="rd-cols">
          <div className="rd-col">
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
            <span className="rd-about">{MINIPLAYER_NOTE}</span>
          </div>
          <div className="rd-col">
            <ScreenField video={video} onVideo={setVideo} />
            <PlaceField place={place} onPlace={setPlace} />
          </div>
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

export function RecordDialog() {
  const ui = useUiStore()
  const recorder = useRecorderStore()
  const integration = useIntegrationStore(state => state.status)
  const [mode, setMode] = useState<CaptureMode>('tab')
  const [computerAudio, setComputerAudio] = useState(COMPUTER_AUDIO_AUTO)
  const [microphoneOn, setMicrophoneOn] = useState(true)
  const [microphoneId, setMicrophoneId] = useState('')
  const [video, setVideo] = useState<VideoChoice>(null)
  const fps: VideoFps | null = video?.fps ?? null
  const [place, setPlace] = useState<RecordingDestination | null>(null)
  const [folderId] = useState(openFolderId)
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
  // from the click until the recording runs the app is held in the window; the browser's own request (microphone, screen) still goes out from the click
  const start = () =>
    blocking('Começando a gravar…', async () => {
      setError(null)
      const display = check.current?.handDisplay() ?? null
      await check.current?.stop()
      try {
        await recorder.start(mode, computerAudio, { microphoneOn, microphoneId: microphoneId || null, video, destination, folderId, ...(display ? { display } : {}) })
        ui.close()
      } catch (failure) {
        setError(failure instanceof Error && failure.name === 'NotAllowedError' ? 'Você não deu permissão para gravar.' : failure instanceof Error ? failure.message : 'Não deu para começar a gravar.')
        void check.current?.listen(listening)
      }
    })
  const pick = () => void check.current?.pickDisplay(mode, fps).catch(() => undefined)
  return (
    <Dialog
      title="Gravar reunião"
      size="wide"
      onClose={ui.close}
      footer={
        <>
          <button className="btn quiet rd-media" onClick={() => ui.open({ kind: 'media' })}>
            <Icon name="mic" />
            Ver as gravações deste computador
          </button>
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
      <div className="db rd-body">
        <IntegrationStatus />
        {/Firefox\//.test(navigator.userAgent) && (
          <div className="banner" role="note" aria-label="Aviso do Firefox">
            <Icon name="warn" />
            <span>No Firefox o som do computador não vem junto com a tela ou a aba: ele vem da entrada do sistema ("Monitor of…" no Linux, "Mixagem estéreo" no Windows), e o Automático de "Som do computador" já pega todas. Escolha "Sem compartilhar" para gravar o seu microfone e todo o som do computador.</span>
          </div>
        )}
        <div className="rd-cols">
          <div className="rd-col">
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
            <CaptureCheckField status={status} mode={mode} fps={fps} computerOff={computerAudio === COMPUTER_AUDIO_NONE} soundHint={status.fromDisplay && mode === 'tab' ? 'Faça som na aba escolhida: a onda verde e o aviso "chegando som" mostram o que chega.' : null} onPick={pick} onTestSound={() => check.current?.testSound() ?? Promise.resolve(false)} />
            <span className="rd-about">{MINIPLAYER_NOTE}</span>
          </div>
          <div className="rd-col">
            <SideBySide<'tab' | 'screen' | 'microphone'> label="O que gravar" options={CAPTURE_OPTIONS} value={mode === 'integration' ? 'tab' : mode} onChange={value => setMode(value)} />
            <ScreenField video={video} onVideo={setVideo} />
            <PlaceField place={place} onPlace={setPlace} />
          </div>
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

function Miniplayer({ live, lanes }: { live: LiveCapture | null; lanes: Lanes }) {
  const container = useRef<HTMLDivElement>(null)
  useEffect(() => (live && container.current ? mountMiniplayer(container.current, live, lanes) : undefined), [live, lanes])
  // the names are drawn on the canvas: the screen reader hears them here
  const name = live ? `Ondas do som: microfone, ${live.meters.computer ? 'som do PC' : 'sem som do computador'}` : undefined
  return <div className={live?.preview ? 'player screen' : 'player'} ref={container} data-lanes={lanes} role="img" aria-label={name} />
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
  // off: the same picture crossed, so the state does not rest on the color alone
  speakerOff: <path d="M4 9.5v5h3.5L12 18V6L7.5 9.5zM15.5 9.5l5 5M20.5 9.5l-5 5" />,
  micOff: (
    <>
      <rect x="9" y="3" width="6" height="11" rx="3" />
      <path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21M4 4l16 16" />
    </>
  ),
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
  className?: string
  onClick(): void
}

function Tile({ label, name, icon, pressed, expanded, disabled, className, onClick }: TileProps) {
  return (
    <button className={className ? `tile ${className}` : 'tile'} aria-label={name} title={name} aria-pressed={pressed} aria-expanded={expanded} disabled={disabled} onClick={onClick}>
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

/** The screen being recorded, small, beside the waves (spec 007, mocks/gravar-reuniao, d-durante). */
function ScreenThumb({ stream }: { stream: MediaStream }) {
  const ref = useRef<HTMLVideoElement>(null)
  useEffect(() => {
    const video = ref.current
    if (!video) return
    video.srcObject = stream
    void Promise.resolve(video.play()).catch(() => undefined)
    return () => {
      video.srcObject = null
    }
  }, [stream])
  return <video className="mr-thumb" ref={ref} muted playsInline autoPlay aria-label="A tela que está sendo gravada" />
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
  // the waves only: the screen goes above them, in its own picture (mocks/gravar-reuniao, option I)
  const waves = useMemo(() => (live ? { ...live, preview: null } : null), [live])
  const keepNote = () => {
    if (note.trim()) annotate(note.trim())
    setNote('')
    setPanel(null)
  }
  const end = () => {
    // the window grows to fit the choices of the end, in this same click (the browser only lets it grow on a click)
    if (floating) {
      try {
        floating.resizeTo(FLOATING_DONE.width, FLOATING_DONE.height)
      } catch {
        // refused: the choices fit in one column, with the middle scrolling
      }
    }
    // closing the file and making it seekable takes seconds: the app is held until the recording is ready
    void blocking('Finalizando a gravação…', () => finish())
  }
  return (
    <>
      <div className="mr-head">
        <div className="timer">
          {clock(seconds)}
          {live?.paused ? <span className="mr-paused">pausado</span> : null}
        </div>
        {/* paused, nothing is being recorded: the head says only "pausado" */}
        <span className="mr-what">{live?.paused ? '' : `Gravando ${what}`}</span>
        {!floating && (
          <button className="btn mr-detach" aria-label="Abrir em janela própria" title="Destacar: abrir em janela própria" onClick={() => void openFloating().then(opened => setBlocked(!opened))}>
            <Icon name="monitor" />
          </button>
        )}
      </div>
      {blocked && !floating && <div className="source">O navegador bloqueou a janela: libere as janelas deste site e tente de novo.</div>}
      <div className="body">
        {panel === 'sources' ? (
          <div className="mr-panel" role="group" aria-label="Fontes">
            <div className="mr-panel-head">
              <b>Fontes</b>
              <button className="btn quiet" onClick={() => setPanel(null)}>
                <Icon name="back" />
                Voltar
              </button>
            </div>
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
            <div className="mr-screen">
              <button className="btn" aria-pressed={screenOn} aria-label={screenOn ? 'Desligar a gravação de tela' : 'Ligar a gravação de tela'} title={screenOn ? 'Desligar a gravação de tela' : 'Ligar a gravação de tela'} onClick={() => attempt(() => setScreen(!screenOn))}>
                <Icon name={screenOn ? 'check' : 'monitor'} />
                Gravar a tela
              </button>
              <button className="btn" disabled={!screenOn} onClick={() => attempt(switchScreen)}>
                <Icon name="swap" />
                Trocar a tela
              </button>
            </div>
          </div>
        ) : (
          <>
            <div className={`mr-media${live?.preview ? ' screen' : ''}`}>
              {live?.preview && <ScreenThumb stream={live.preview} />}
              <Miniplayer live={waves} lanes={live?.preview ? 'side' : 'stacked'} />
            </div>
            <div className="tiles mr-tiles">
              <Tile label="Microfone" name={microphoneOn ? 'Desligar o microfone' : 'Ligar o microfone'} icon={microphoneOn ? <Icon name="mic" /> : <Glyph name="micOff" />} pressed={microphoneOn} onClick={() => setEnabled('microphone', !microphoneOn)} />
              <Tile label="Som do PC" name={sourceOn ? 'Desligar o som do computador' : 'Ligar o som do computador'} icon={<Glyph name={sourceOn ? 'speaker' : 'speakerOff'} />} pressed={sourceOn} disabled={!live?.hasSource} onClick={() => setEnabled('source', !sourceOn)} />
              <Tile label={live?.paused ? 'Continuar' : 'Pausar'} name={live?.paused ? 'Continuar' : 'Pausar'} icon={live?.paused ? <Glyph name="play" /> : <Icon name="pause" />} className="mr-resume" onClick={() => (live?.paused ? resume() : pause())} />
              <Tile label="Marcar" name="Marcar momento" icon={<Glyph name="flag" />} onClick={mark} />
              <Tile label="Anotar" name="Anotar" icon={<Icon name="pen" />} expanded={panel === 'note'} onClick={() => setPanel(panel === 'note' ? null : 'note')} />
              <Tile label="Fontes" name="Fontes" icon={<Glyph name="window" />} expanded={false} onClick={() => setPanel('sources')} />
            </div>
          </>
        )}
        {panel === 'note' ? (
          // "Enter guarda" stays in the field while typing (mocks/gravar-reuniao, d-durante), not only as the placeholder
          <div className="mr-note">
            <input
              className="input"
              aria-label="Anotação"
              aria-describedby="mr-note-hint"
              placeholder="Anotação deste momento"
              autoFocus
              value={note}
              onChange={event => setNote(event.target.value)}
              onKeyDown={event => {
                if (event.key === 'Enter') keepNote()
                if (event.key === 'Escape') setPanel(null)
              }}
            />
            <span className="mr-note-hint" id="mr-note-hint">
              Enter guarda
            </span>
          </div>
        ) : (
          (live?.computerAudio || marks.length > 0) && (
            <div className="mini-info">
              {live?.computerAudio && <span>Som do computador: {live.computerAudio}</span>}
              {marks.length > 0 && <span>{[flags && counted(flags, 'marcação', 'marcações'), notes && counted(notes, 'anotação', 'anotações')].filter(Boolean).join(' · ')}</span>}
            </div>
          )
        )}
        {confirming ? (
          <div className="inline-confirm">
            Descartar a gravação?
            <button className="btn danger" onClick={() => (setConfirming(false), void blocking('Descartando a gravação…', () => cancel()))}>
              Descartar
            </button>
            <button className="btn quiet" onClick={() => setConfirming(false)}>
              Voltar
            </button>
          </div>
        ) : (
          <div className="acts">
            <button className="btn danger" onClick={() => setConfirming(true)}>
              Cancelar
            </button>
            <button className="btn primary" onClick={end}>
              Terminar
            </button>
          </div>
        )}
      </div>
    </>
  )
}

/** The floating window at the end, to fit the two columns of "Gravação pronta" (mocks/gravar-reuniao, e-depois). */
const FLOATING_DONE = { width: 800, height: 620 }

/** The saved recording opens, unless a note or an entrada is open: then she stays, and a notice offers it. */
function openNote(fileId: string) {
  void import('@/routes').then(({ router }) => goToNew(paths.file(fileId), 'A gravação foi salva', router.state?.location.pathname ?? '/', to => void router.navigate(to)))
}

/** What "Gerar" makes from the recording (spec 007, pedido do dono de 24/11): any of them at once; none, it only keeps the recording. */
type Making = 'transcribe' | NoteAgent

const MAKES: { id: Making; label: string; hint: string }[] = [
  { id: 'transcribe', label: 'Transcrição', hint: 'Quem falou e quando' },
  { id: 'meeting', label: 'Ata', hint: 'Decisões e tarefas' },
  { id: 'lesson', label: 'Aula', hint: 'Para aprender' },
  { id: 'explanation', label: 'Explicação', hint: 'Direto ao ponto' },
]

const WRITERS = ['meeting', 'lesson', 'explanation'] as const
type Writer = (typeof WRITERS)[number]
const LABEL_OF: Record<Making, string> = Object.fromEntries(MAKES.map(item => [item.id, item.label])) as Record<Making, string>

/** "a", "a e b", "a, b e c" */
const listed = (items: string[]) => (items.length < 2 ? (items[0] ?? '') : `${items.slice(0, -1).join(', ')} e ${items[items.length - 1]}`)

function RecordingDoneOptions({ place }: { place: 'dialog' | 'window' }) {
  const { result, clearResult } = useRecorderStore()
  const account = useAccountStore(state => state.active())
  const limit = useLibraryStore(state => state.index.settings.storageLimitBytes)
  const usage = useSyncStore(state => state.usage)
  const files = useLibraryStore(state => state.files)
  const saveRecording = useJobsStore(state => state.saveRecording)
  const toast = useUiStore(state => state.toast)
  const appAi = useAppAiStore(state => state.config)
  const [marked, setMarked] = useState<Making[]>(['transcribe'])
  const heardBy = useModelChoice('transcricao')
  // who writes each note, as in "Gerar desta entrada"
  const writers: Record<Writer, ReturnType<typeof useModelChoice>> = { meeting: useModelChoice('ata'), lesson: useModelChoice('aula', true), explanation: useModelChoice('explicacao', true) }
  // the Ata comes with the "Modelo da ata" of the last Ata, which the person changes (25/11); the parts stay those of the last Ata, else
  // the Resumo (24/11: "partes da ata sai")
  const [ata, setAta] = useState(() => lastAta(files, ''))
  const [instruction, setInstruction] = useState('')
  const defaultName = result ? recordingName(result.file.name) : ''
  const [name, setName] = useState(defaultName)
  const [moreOpen, setMoreOpen] = useState(false)
  const isVideo = Boolean(result?.file.type.startsWith('video/'))
  const has = (id: Making) => marked.includes(id)
  const writing = WRITERS.filter(has)
  const others = writing.filter(id => id !== 'meeting')
  // of a video: the Ata goes step by step or all in one call; the other notes choose what the AI analyzes
  const ataAnalysis = useMediaAnalysis(writers.meeting, has('meeting') && isVideo, null, { ata: true })
  const otherAnalysis = useMediaAnalysis(writers[others[0] ?? 'lesson'], others.length > 0 && isVideo)
  const [discarding, setDiscarding] = useState(false)
  // unchosen: the folder open when the recording started
  const [pickedFolder, setFolderId] = useState<string | null | undefined>(undefined)
  const [storage, setStorage] = useState<RecordingDestination | null>(null)
  const appOn = useLibraryStore(state => state.appOn)
  if (!result) return null
  const driveAvailable = account.kind === 'google'
  const room = usage && limit ? limit - usage.appBytes : null
  const folderId = pickedFolder === undefined ? (result.folderId ?? null) : pickedFolder
  const media = storageOptions(result.file.size, driveAvailable, room)
  const drive = media.find(option => option.id === 'drive')
  const preferred = storage ?? result.destination ?? null
  const placeOk = (id: RecordingDestination) => id === 'none' || (id === 'app' ? appOn : Boolean(drive?.fits && drive.enabled))
  const chosen: RecordingDestination = preferred && placeOk(preferred) ? preferred : appOn ? 'app' : defaultStorage(driveAvailable, media)
  const places: SideBySideOption<RecordingDestination>[] = [
    { value: 'none', label: 'Neste computador', about: 'Fica em Mídias, neste navegador. A nota guarda o nome da gravação.' },
    { value: 'drive', label: 'Google Drive', about: 'Também vai para o seu Drive. Conta no seu limite de armazenamento.', ...(drive?.fits && drive.enabled ? {} : { why: drive?.reason ?? 'O Google Drive não está disponível agora.' }) },
    ...(appOn ? [{ value: 'app' as const, label: 'App', about: 'A nota e a mídia ficam no App.' }] : []),
  ]
  const toggleMaking = (id: Making) => setMarked(current => MAKES.map(item => item.id).filter(item => (item === id ? !current.includes(id) : current.includes(item))))
  const notReady = MAKES.filter(item => has(item.id) && !(item.id === 'transcribe' ? heardBy.ready : writers[item.id as Writer].ready))
  // inside "Mais opções": the models (only with the person's own AI), what the AI analyzes in a video, and the instruction
  const inside = [!appAi && marked.length > 0 && 'modelos', isVideo && writing.length > 0 && 'vídeo', writing.length > 0 && 'instrução'].filter((item): item is string => Boolean(item))
  const showMore = (moreOpen || notReady.length > 0) && inside.length > 0
  const both = has('meeting') && others.length > 0
  const later = () => {
    clearResult()
    toast('A gravação ficou salva em Mídias')
  }
  const discard = () => {
    const { storedName } = result
    clearResult()
    void removeLocalMedia(storedName)
    toast('Gravação descartada')
  }
  const save = () => {
    const { file, storedName, marks, durationSeconds, screens, volume } = result
    clearResult()
    setStorage(null)
    setFolderId(undefined)
    const transcribing = has('transcribe')
    const writes: RecordingWrite[] = writing.map(agent => {
      const analysis = agent === 'meeting' ? ataAnalysis : otherAnalysis
      return {
        agent,
        model: writers[agent].model || null,
        ...(instruction.trim() ? { instruction } : {}),
        ...(isVideo && analysis.sent ? { analyze: analysis.sent } : {}),
        ...(agent === 'meeting' ? (ata.model ? { ataModel: ata.model, parts: [] } : { parts: PART_ORDER.filter(part => ata.parts.includes(part)) }) : {}),
      }
    })
    const typed = name.trim()
    // the window closes at once and saving takes several writes: a line in the tasks says it is saving until the note opens
    void working(
      'Salvando a gravação…',
      async () =>
        openNote(
          await saveRecording({
            file,
            storedName,
            durationSeconds,
            folderId,
            storage: chosen === 'app' ? 'drive' : chosen,
            ...(chosen === 'app' || chosen === 'drive' ? { place: chosen } : {}),
            litterboxTime: '72h',
            marks: marks ?? [],
            ...(screens ? { screens } : {}),
            ...(volume ? { volume } : {}),
            transcribe: transcribing,
            ...(transcribing && heardBy.model ? { transcriptionModel: heardBy.model } : {}),
            ...(writes.length ? { writes } : {}),
            ...(typed && typed !== defaultName ? { name: typed } : {}),
          }),
        ),
      { message: 'Guardando a gravação' },
    )
  }
  const actions = discarding ? (
    <div className="inline-confirm">
      Descartar a gravação?
      <button className="btn danger" onClick={discard}>
        Descartar
      </button>
      <button className="btn quiet" onClick={() => setDiscarding(false)}>
        Voltar
      </button>
    </div>
  ) : (
    <>
      <button className="btn quiet rd-media" onClick={() => setDiscarding(true)}>
        Descartar
      </button>
      <button className="btn primary" disabled={notReady.length > 0} onClick={save}>
        Salvar
      </button>
    </>
  )
  const meta = `${MEDIA_LABEL[isVideo ? 'video' : 'audio']} · ${duration(result.durationSeconds)} · ${formatBytes(result.file.size)}`
  const body = (
    <div className="rd-cols rd-done">
      <div className="rd-col">
        <div className="field">
          <label className="lab" htmlFor="rec-name">
            Nome
          </label>
          <input className="input" id="rec-name" value={name} onChange={event => setName(event.target.value)} />
          {name.trim() && name.trim() !== defaultName && <span className="rd-about">O padrão era "{defaultName}".</span>}
        </div>
        <div className="field">
          <span className="lab">Gerar</span>
          <div className="opts rd-screen" role="group" aria-label="Gerar">
            {MAKES.map(item => (
              <button key={item.id} className="opt" role="checkbox" aria-checked={has(item.id)} onClick={() => toggleMaking(item.id)}>
                <span className="radio" style={{ borderRadius: 5 }} />
                <span>
                  <b>{item.label}</b>
                  <span>{item.hint}</span>
                </span>
              </button>
            ))}
          </div>
          <span className="rd-about">Pode marcar vários. Nada marcado: só guarda.</span>
        </div>
        {has('meeting') && <AtaModelField model={ata.model} onModel={model => setAta(current => ({ ...current, model }))} />}
        {inside.length > 0 && (
          <div className="rd-more">
            <button className="rd-more-toggle" aria-expanded={showMore} onClick={() => setMoreOpen(!showMore)}>
              <Icon name={showMore ? 'chev' : 'fwd'} />
              <b>Mais opções</b>
              {!showMore && <span>{listed(inside)}</span>}
            </button>
            {showMore && (
              <div className="rd-more-body">
                <div className="rd-models">
                  {has('transcribe') && <ModelPick choice={heardBy} label="Transcrição" />}
                  {writing.map(agent => (
                    <ModelPick key={agent} choice={writers[agent]} label={LABEL_OF[agent]} />
                  ))}
                </div>
                {isVideo && has('meeting') && <MediaAnalysisField analysis={ataAnalysis} compact label={both ? 'O que a IA analisa na Ata' : 'O que a IA analisa'} />}
                {isVideo && others.length > 0 && <MediaAnalysisField analysis={otherAnalysis} compact label={both ? `O que a IA analisa na ${others.map(id => LABEL_OF[id]).join(' e na ')}` : 'O que a IA analisa'} />}
                {writing.length > 0 && (
                  <div className="field">
                    <label className="lab" htmlFor="rec-instruction">
                      Instrução extra para a IA (opcional)
                    </label>
                    <textarea className="input" id="rec-instruction" rows={2} value={instruction} onChange={event => setInstruction(event.target.value)} placeholder={has('meeting') ? 'Ex.: foque nas decisões e nas tarefas' : 'Ex.: foque na parte prática'} />
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </div>
      <div className="rd-col">
        <SideBySide<RecordingDestination> label="Onde salvar" options={places} value={chosen} onChange={value => setStorage(value)} />
        <div className="field">
          <span className="lab">Pasta</span>
          <FolderField value={folderId} onChange={setFolderId} />
        </div>
      </div>
    </div>
  )
  if (place === 'dialog') {
    return (
      <Dialog
        title={
          <>
            Gravação pronta <span className="rd-meta">{meta}</span>
          </>
        }
        label="Gravação pronta"
        size="wide"
        style={{ width: 'min(800px, 100%)' }}
        onClose={later}
        footer={actions}
      >
        <div className="db">{body}</div>
      </Dialog>
    )
  }
  // in the corner and in the floating window: the title and the X of the dialog (mocks/gravar-reuniao, e-depois); closing keeps it in Mídias
  return (
    <>
      <div className="dh rd-done-head">
        <h2>Gravação pronta</h2>
        <span className="rd-meta">{meta}</span>
        <button className="ibtn" aria-label="Fechar" title="Fechar: a gravação fica em Mídias" onClick={later}>
          <Icon name="x" />
        </button>
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
