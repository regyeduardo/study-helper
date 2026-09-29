import { useEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'

import type { SourceStorage } from '@/types/domain'
import { Dialog } from '@/components/ui/Dialog'
import { Icon } from '@/components/ui/Icon'
import { FreeMinutes } from '@/components/dialogs/FreeMinutes'
import { IntegrationStatus } from '@/components/dialogs/IntegrationStatus'
import { FreeAi } from '@/components/dialogs/FreeAi'
import { LimitedAiNotice } from '@/components/dialogs/LimitedAiNotice'
import { FolderPicker } from '@/components/dialogs/SimpleDialogs'
import { SourceStoragePicker } from '@/components/dialogs/SourceStoragePicker'
import type { LitterboxTime } from '@/controllers/hosting.controller'
import { useFreeMinutes } from '@/hooks/use-free-minutes'
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
import { type AudioInput, type CaptureMode, COMPUTER_AUDIO_AUTO, COMPUTER_AUDIO_NONE, listAudioInputs, type LiveCapture, systemAudioNotice } from '@/lib/recording/recorder'
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
  const [error, setError] = useState<string | null>(null)
  const handed = useRef(false)
  const player = useRef<HTMLDivElement>(null)
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
  useEffect(
    () =>
      capture && player.current
        ? mountMiniplayer(player.current, { preview: null, meters: { microphone: microphoneOn ? capture.meters.microphone : null, computer: choice === 'none' ? null : capture.meters.computer }, computerAudio: capture.label })
        : undefined,
    [capture, microphoneOn, choice],
  )
  const nothing = !microphoneOn && choice === 'none'
  const start = async () => {
    if (!capture || nothing) return
    handed.current = true
    try {
      await startIntegration(capture, { microphoneOn, microphoneId: microphoneId || null })
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
        <div className="field">
          <span className="lab">Confira antes de gravar</span>
          <div className="player" ref={player} aria-label="Ondas antes de gravar" style={{ height: 140, borderRadius: 8, overflow: 'hidden' }} />
          <span className="faint" style={{ fontSize: 12 }}>
            {nothing ? 'Ligue o microfone ou escolha um som do computador.' : capture ? 'Fale e deixe o som tocar: as ondas mostram o que vai ser gravado.' : error ? '' : 'Ligando o som…'}
          </span>
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
  const [inputs, setInputs] = useState<AudioInput[]>([])
  const [error, setError] = useState<string | null>(null)
  const [allowed, setAllowed] = useState(false)
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
    try {
      await recorder.start(mode, computerAudio, { microphoneOn, microphoneId: microphoneId || null })
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
  return <div className="player" ref={container} />
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

function RecordingControls() {
  const { seconds, mode, live, floating, finish, cancel, pause, resume, setEnabled, switchMicrophone, switchComputerInput, reshare, switchIntegrationSource, openFloating } = useRecorderStore()
  const toast = useUiStore(state => state.toast)
  const [confirming, setConfirming] = useState(false)
  const [blocked, setBlocked] = useState(false)
  const options = useSwitchOptions(mode)
  const attempt = (action: () => Promise<void>) => void action().catch(failure => toast(failure instanceof Error ? failure.message : 'Não deu para trocar.'))
  const what = mode === 'tab' ? 'a aba' : mode === 'screen' ? 'a tela' : mode === 'integration' && live?.computerAudio ? live.computerAudio : 'o microfone'
  return (
    <>
      <div className="bar-top">
        <Icon name="monitor" />
        <span style={{ flex: 1 }}>Gravando {what}</span>
        {!floating && (
          <button className="ibtn" aria-label="Abrir em janela própria" title="Abrir em janela própria" onClick={() => void openFloating().then(opened => setBlocked(!opened))}>
            <Icon name="monitor" />
          </button>
        )}
      </div>
      {blocked && !floating && <div className="source">O navegador bloqueou a janela: libere as janelas deste site e tente de novo.</div>}
      <Miniplayer live={live} />
      {live?.computerAudio && <div className="source">Som do computador: {live.computerAudio}</div>}
      <div className="body">
        <div className="timer">
          {clock(seconds)}
          {live?.paused ? <span className="faint" style={{ fontSize: 13 }}>pausado</span> : null}
        </div>
        <div className="toggles" style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          <button className="btn" aria-pressed={live?.microphoneOn ?? true} onClick={() => setEnabled('microphone', !(live?.microphoneOn ?? true))}>
            <Icon name="mic" />
            {live?.microphoneOn === false ? 'Ligar o microfone' : 'Desligar o microfone'}
          </button>
          {live?.hasSource && (
            <button className="btn" aria-pressed={live.sourceOn} onClick={() => setEnabled('source', !live.sourceOn)}>
              <Icon name="monitor" />
              {live.sourceOn ? 'Desligar o som do computador' : 'Ligar o som do computador'}
            </button>
          )}
          <button className="btn" onClick={() => (live?.paused ? resume() : pause())}>
            <Icon name={live?.paused ? 'rec' : 'clock'} />
            {live?.paused ? 'Continuar' : 'Pausar'}
          </button>
        </div>
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
          <>
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
            {(mode === 'tab' || mode === 'screen') && (
              <button className="btn quiet" style={{ justifySelf: 'start' }} onClick={() => attempt(reshare)}>
                {mode === 'tab' ? 'Trocar a aba' : 'Trocar a tela'}
              </button>
            )}
          </>
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
  const freeMinutes = useFreeMinutes(result?.file ?? null)
  if (!result) return null
  const driveAvailable = account.kind === 'google'
  const room = usage && limit ? limit - usage.appBytes : null
  const options = storageOptions(result.file.size, driveAvailable, room)
  const chosen: SourceStorage = storage && options.some(option => option.id === storage && option.fits && option.enabled) ? storage : defaultStorage(result.file.size, driveAvailable, options)
  const later = () => {
    clearResult()
    toast('A gravação ficou salva em Mídias')
  }
  const go = () => {
    const { file, storedName } = result
    clearResult()
    setStorage(null)
    void startNewContent({ agent, input: { kind: 'recording', file }, name: '', description: '', folderId, prompt: '', storage: chosen, litterboxTime }).then(fileId => {
      if (fileId) void linkLocalMedia(storedName, fileId)
    })
  }
  const actions = (
    <>
      <button className="btn quiet" onClick={later}>
        Só salvar
      </button>
      <button className="btn primary" disabled={freeMinutes.kind === 'ready' && freeMinutes.short} onClick={go}>
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
      <FreeMinutes check={freeMinutes} />
      <LimitedAiNotice />
      <FreeAi />
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
