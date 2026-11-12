import { type ComponentProps, type CSSProperties, type ReactNode, type RefObject, type SyntheticEvent, useCallback, useEffect, useRef, useState } from 'react'

import type { FileMeta } from '@/types/domain'
import { readLocalMedia } from '@/lib/recording/media-library'
import { downloadStoredSource, sourceExpired } from '@/lib/storage/source-storage'
import { clockTime } from '@/lib/transcription/export'
import { useLibraryStore } from '@/stores/library'
import { useUiStore } from '@/stores/ui'

export interface MeetingMedia {
  url: string | null
  available: boolean
  video: boolean
  remote?: boolean
  size?: number
  notice?: string
  request(): Promise<void>
}

export const SHARED_MEDIA_EXPIRED = 'A mídia deste compartilhamento expirou (fica 3 dias).'

const MEDIA_FAILURES: Record<number, string> = {
  2: 'A mídia parou de baixar. Confira a internet.',
  3: 'A mídia veio com defeito e não toca neste navegador.',
  4: 'Este navegador não toca o formato desta mídia.',
}
const MB = 1024 * 1024

/** Plays from a second; a player that failed to load (Chrome, while the app opens) is loaded again first. */
export function playAt(element: HTMLMediaElement, seconds: number): void {
  const go = () => {
    element.currentTime = seconds
    void Promise.resolve(element.play()).catch(() => undefined)
  }
  if (!element.error) return go()
  element.addEventListener('loadedmetadata', go, { once: true })
  element.load()
}

const nothing = async () => undefined

export function useMeetingMedia(meta: FileMeta | null): MeetingMedia {
  const fileId = meta?.id ?? null
  const sharedItem = useLibraryStore(state => state.sharedView?.item ?? null)
  const sharedMedia = sharedItem?.files.find(file => file.id === fileId)?.media ?? null
  const local = useLibraryStore(state => state.localMedia.find(item => fileId !== null && item.fileIds.includes(fileId)) ?? null)
  const repo = useLibraryStore(state => state.repo)
  const toast = useUiStore(state => state.toast)
  const [url, setUrl] = useState<string | null>(null)
  const made = useRef<string | null>(null)
  const origin = meta?.origin ?? null
  const kept = Boolean(origin && (origin.storedFileId || origin.storedUrl) && !origin.removedAt && !sourceExpired(origin))
  const storedName = local?.storedName ?? null

  const show = useCallback((source: Blob | string) => {
    if (made.current) URL.revokeObjectURL(made.current)
    made.current = typeof source === 'string' ? null : URL.createObjectURL(source)
    setUrl(typeof source === 'string' ? source : made.current)
  }, [])

  useEffect(() => {
    let alive = true
    setUrl(null)
    if (local) void readLocalMedia(local).then(file => alive && show(file), () => undefined)
    return () => {
      alive = false
    }
  }, [fileId, storedName])

  useEffect(
    () => () => {
      if (made.current) URL.revokeObjectURL(made.current)
    },
    [],
  )

  const request = useCallback(async () => {
    if (url || local || !kept || !origin || !repo) return
    try {
      show(await downloadStoredSource(origin, repo))
    } catch (error) {
      toast(error instanceof Error ? error.message : 'Não deu para abrir a gravação.')
    }
  }, [url, local, kept, origin, repo, show, toast])

  if (sharedItem) {
    const video = (sharedMedia?.mime || origin?.mime || '').startsWith('video/')
    if (!sharedMedia) return { url: null, available: false, video, request: nothing }
    if (sharedItem.mediaExpiresAt && Date.parse(sharedItem.mediaExpiresAt) <= Date.now()) return { url: null, available: false, video, notice: SHARED_MEDIA_EXPIRED, request: nothing }
    return { url: sharedMedia.url, available: true, video, remote: true, size: sharedMedia.size, request: nothing }
  }
  return { url, available: Boolean(local) || kept, video: (local?.mime || origin?.mime || '').startsWith('video/'), request }
}

interface MediaPlayerProps {
  player: RefObject<HTMLMediaElement | null>
  media: MeetingMedia
  onTime(seconds: number): void
  onPlayFrom(seconds: number): void
}

const wired = new WeakSet<HTMLMediaElement>()

function bothEars(element: HTMLMediaElement): void {
  if (wired.has(element) || !(element.src.startsWith('blob:') || element.crossOrigin === 'anonymous') || typeof AudioContext === 'undefined') return
  wired.add(element)
  const context = new AudioContext()
  const sides = context.createChannelSplitter(2)
  const ears = context.createChannelMerger(2)
  context.createMediaElementSource(element).connect(sides)
  for (const side of [0, 1]) for (const ear of [0, 1]) sides.connect(ears, side, ear)
  ears.connect(context.destination)
  void context.resume()
}

/** Why the media did not play: the share worker answers 404 while the upload did not finish and 410 once it expired. */
async function failureOf(media: MeetingMedia, code: number): Promise<string> {
  const fallback = MEDIA_FAILURES[code] ?? 'Não deu para tocar a mídia.'
  if (!media.remote || !media.url) return fallback
  const response = await fetch(media.url, { headers: { Range: 'bytes=0-0' } }).catch(() => null)
  if (!response) return MEDIA_FAILURES[2]
  if (response.status === 404) return 'A mídia não terminou de subir ou não existe.'
  if (response.status === 410) return SHARED_MEDIA_EXPIRED
  return fallback
}

/** The stretches already downloaded, as fractions of the duration. */
function loadedOf(element: HTMLMediaElement): [number, number][] {
  const total = element.duration
  if (!Number.isFinite(total) || !total) return []
  return Array.from({ length: element.buffered.length }, (_, index) => [element.buffered.start(index) / total, element.buffered.end(index) / total])
}

const percent = (fraction: number) => `${+(fraction * 100).toFixed(1)}%`

function loadedLayer(loaded: [number, number][]): string | undefined {
  if (!loaded.length) return undefined
  return `linear-gradient(to right, ${loaded.map(([start, end], index) => `transparent ${percent(loaded[index - 1]?.[1] ?? 0)} ${percent(start)}, var(--mplayer-loaded) ${percent(start)} ${percent(end)}`).join(', ')}, transparent ${percent(loaded.at(-1)![1])})`
}

function loadedTitle(loaded: [number, number][], size: number | undefined): string {
  const fraction = loaded.reduce((sum, [start, end]) => sum + end - start, 0)
  const megabytes = (bytes: number) => (bytes / MB).toLocaleString('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 1 })
  return `Baixado ${Math.round(fraction * 100)}%${size ? ` · ${megabytes(fraction * size)} de ${megabytes(size)} MB` : ''}`
}

const ICONS = {
  back: (
    <>
      <path d="M5.07 8.5A8 8 0 1 0 12 4.5" />
      <path d="M14.6 2.2l-3 2.3 3 2.3" />
      <text x="12" y="15.4" textAnchor="middle" fontSize="7.4" fontWeight="700" fill="currentColor" stroke="none">
        10
      </text>
    </>
  ),
  forward: (
    <>
      <path d="M18.93 8.5A8 8 0 1 1 12 4.5" />
      <path d="M9.4 2.2l3 2.3-3 2.3" />
      <text x="12" y="15.4" textAnchor="middle" fontSize="7.4" fontWeight="700" fill="currentColor" stroke="none">
        10
      </text>
    </>
  ),
  volume: <path d="M4 9.5v5h3.5l4.5 4v-13l-4.5 4zM15.6 9.2a4 4 0 0 1 0 5.6M18.2 6.6a7.6 7.6 0 0 1 0 10.8" />,
  muted: <path d="M4 9.5v5h3.5l4.5 4v-13l-4.5 4zM16 9.8l5 4.4M21 9.8l-5 4.4" />,
  expand: <path d="M14 4h6v6M10 20H4v-6M20 4l-7 7M4 20l7-7" />,
  shrink: <path d="M20 10h-6V4M4 14h6v6M14 10l7-7M3 21l7-7" />,
  fullscreen: <path d="M4 9V4h5M15 4h5v5M20 15v5h-5M9 20H4v-5" />,
  leave: <path d="M9 4v5H4M15 4v5h5M20 15h-5v5M4 15h5v5" />,
}

function Glyph({ playing }: { playing: boolean }) {
  return (
    <svg className="ic" viewBox="0 0 24 24" aria-hidden="true">
      {playing ? <path d="M8.5 5.5v13M15.5 5.5v13" /> : <path d="M8 5.5v13l10.5-6.5z" fill="currentColor" />}
    </svg>
  )
}

function Icon({ name, size }: { name: keyof typeof ICONS; size?: number }) {
  return (
    <svg className="ic" viewBox="0 0 24 24" aria-hidden="true" style={size ? { width: size, height: size } : undefined}>
      {ICONS[name]}
    </svg>
  )
}

const SPEEDS = [0.75, 1, 1.25, 1.5, 1.75, 2]
const PREFS_KEY = 'study-helper:player'
const SKIP = 10
/** Full screen while playing: the controls hide after this long without the mouse or a key. */
const IDLE_MS = 3000
const JUMPS: Record<string, number> = { ArrowRight: 5, ArrowLeft: -5, l: SKIP, j: -SKIP }
const FOCUSABLE = 'button:not([disabled]), input:not([disabled]), select:not([disabled]), [href], [tabindex]:not([tabindex="-1"])'

interface Prefs {
  speed: number
  volume: number
  muted: boolean
}

/** Speed and volume stay per browser; a browser that refuses to keep them just starts from the usual again. */
function readPrefs(): Prefs {
  const prefs: Prefs = { speed: 1, volume: 1, muted: false }
  try {
    const saved = JSON.parse(localStorage.getItem(PREFS_KEY) ?? '{}') as Partial<Prefs>
    if (SPEEDS.includes(saved.speed as number)) prefs.speed = saved.speed as number
    if (typeof saved.volume === 'number' && saved.volume >= 0 && saved.volume <= 1) prefs.volume = saved.volume
    if (saved.muted === true) prefs.muted = true
  } catch {
    return prefs
  }
  return prefs
}

function savePrefs(prefs: Prefs): void {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(prefs))
  } catch {
    return
  }
}

const speedName = (speed: number) => `${String(speed).replace('.', ',')}×`

const INTERACTIVE = 'input, textarea, select, button, a[href], [contenteditable]:not([contenteditable="false"])'

/** Whether a key that lands on this element is the player's: a field keeps its typing, a control its own keys. */
function ownKey(target: HTMLElement | null, key: string): boolean {
  if (!target) return true
  const tag = target.tagName
  if (tag === 'SELECT' || tag === 'TEXTAREA' || target.closest('[contenteditable]:not([contenteditable="false"])')) return false
  if (tag === 'INPUT') return (target as HTMLInputElement).type === 'range' && key !== 'ArrowLeft' && key !== 'ArrowRight'
  if (tag === 'BUTTON' || tag === 'A') return key !== ' ' && key !== 'Enter'
  return true
}

type FullscreenBox = HTMLElement & { webkitRequestFullscreen?: () => void }
type FullscreenVideo = HTMLMediaElement & { webkitEnterFullscreen?: () => void }

function openFullscreen(box: HTMLElement, element: HTMLMediaElement | null): void {
  const old = box as FullscreenBox
  if (typeof box.requestFullscreen === 'function') void Promise.resolve(box.requestFullscreen()).catch(() => undefined)
  else if (typeof old.webkitRequestFullscreen === 'function') old.webkitRequestFullscreen()
  // iPhone only takes the video itself to full screen, with its own controls
  else (element as FullscreenVideo | null)?.webkitEnterFullscreen?.()
}

function leaveFullscreen(): void {
  if (typeof document.exitFullscreen === 'function') void Promise.resolve(document.exitFullscreen()).catch(() => undefined)
}

function Tool({ label, hint, icon, className, ...rest }: { label: string; hint: string; icon: ReactNode } & Omit<ComponentProps<'button'>, 'title' | 'aria-label'>) {
  return (
    <button {...rest} className={className ? `ibtn ${className}` : 'ibtn'} aria-label={label} title={hint}>
      {icon}
    </button>
  )
}

export function MediaPlayer({ player, media, onTime, onPlayFrom }: MediaPlayerProps) {
  const [playing, setPlaying] = useState(false)
  const [time, setTime] = useState(0)
  const [duration, setDuration] = useState(0)
  const [big, setBig] = useState(false)
  const [fullscreen, setFullscreen] = useState(false)
  // full screen while playing: the controls hide after a moment without the mouse or a key
  const [idle, setIdle] = useState(false)
  const idleTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [prefs, setPrefs] = useState(readPrefs)
  const [waiting, setWaiting] = useState(Boolean(media.url))
  const [ready, setReady] = useState(false)
  const [loaded, setLoaded] = useState<[number, number][]>([])
  const [failure, setFailure] = useState<string | null>(null)
  const reloads = useRef({ url: media.url, count: 0 })
  const section = useRef<HTMLElement>(null)
  const box = useRef<HTMLDivElement>(null)
  const expandButton = useRef<HTMLButtonElement>(null)
  const shrinkButton = useRef<HTMLButtonElement>(null)
  const opened = useRef(false)
  if (reloads.current.url !== media.url) {
    reloads.current = { url: media.url, count: 0 }
    setWaiting(Boolean(media.url))
    setReady(false)
    setLoaded([])
    setFailure(null)
  }
  const expanded = big && media.video
  const silent = prefs.muted || prefs.volume === 0

  const toggle = () => {
    if (playing) player.current?.pause()
    else onPlayFrom(time)
  }
  const retry = () => {
    reloads.current.count = 0
    setFailure(null)
    setWaiting(true)
    player.current?.load()
  }
  const moveTo = (seconds: number) => {
    if (player.current) player.current.currentTime = seconds
    setTime(seconds)
    onTime(seconds)
  }
  const skip = (seconds: number) => {
    const element = player.current
    if (element && duration) moveTo(Math.min(Math.max(element.currentTime + seconds, 0), duration))
  }
  const keep = (change: Partial<Prefs>) => {
    const next = { ...prefs, ...change }
    setPrefs(next)
    savePrefs(next)
  }
  const mute = () => keep(silent ? { muted: false, volume: prefs.volume || 0.5 } : { muted: true })
  const inFullscreen = () => Boolean(box.current) && document.fullscreenElement === box.current
  const toggleFullscreen = () => {
    if (inFullscreen()) leaveFullscreen()
    else if (box.current) openFullscreen(box.current, player.current)
  }
  const shrink = () => {
    if (inFullscreen()) leaveFullscreen()
    setBig(false)
  }

  const handleKey = (event: KeyboardEvent) => {
    if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey) return
    const target = event.target instanceof HTMLElement ? event.target : null
    const key = event.key.length === 1 ? event.key.toLowerCase() : event.key
    const inside = Boolean(target && section.current?.contains(target))
    // the open screen listens to the whole page, but a field or a button of the page behind keeps its own keys
    if (!inside && target?.closest(INTERACTIVE)) return
    const done = () => event.preventDefault()
    if (key === 'Escape') {
      if (inFullscreen()) leaveFullscreen()
      else if (expanded) setBig(false)
      else return
      return done()
    }
    if (key === 'Tab') {
      if (!expanded || !box.current) return
      const items = [...box.current.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(item => item.checkVisibility?.() ?? true)
      const first = items[0]
      const last = items.at(-1)
      const active = document.activeElement
      const out = !box.current.contains(active)
      if (first && last && event.shiftKey && (out || active === first)) last.focus()
      else if (first && last && !event.shiftKey && (out || active === last)) first.focus()
      else return
      return done()
    }
    if (!ownKey(target, key)) return
    if (key === ' ' || key === 'k') toggle()
    else if (key === 'm') mute()
    else if (key === 'f' && media.video) {
      setBig(true)
      toggleFullscreen()
    } else if (duration && key in JUMPS) skip(JUMPS[key])
    else return
    done()
  }
  const keys = useRef(handleKey)
  keys.current = handleKey

  // the speed and the sound of the browser go to the element; a new load starts again from the default speed
  useEffect(() => {
    const element = player.current
    if (!element) return
    element.defaultPlaybackRate = prefs.speed
    element.playbackRate = prefs.speed
    element.volume = prefs.volume
    element.muted = prefs.muted
  }, [prefs, media.video])

  useEffect(() => {
    if (!expanded) return
    const listener = (event: KeyboardEvent) => {
      waking.current()
      keys.current(event)
    }
    document.addEventListener('keydown', listener)
    return () => document.removeEventListener('keydown', listener)
  }, [expanded])

  useEffect(() => {
    const sync = () => setFullscreen(Boolean(box.current) && document.fullscreenElement === box.current)
    document.addEventListener('fullscreenchange', sync)
    const element = box.current
    return () => {
      document.removeEventListener('fullscreenchange', sync)
      if (element && document.fullscreenElement === element) leaveFullscreen()
    }
  }, [])

  const watching = fullscreen && playing
  const wake = () => {
    if (idleTimer.current) clearTimeout(idleTimer.current)
    setIdle(false)
    if (watching) idleTimer.current = setTimeout(() => setIdle(true), IDLE_MS)
  }
  const waking = useRef(wake)
  waking.current = wake
  useEffect(() => {
    wake()
    return () => {
      if (idleTimer.current) clearTimeout(idleTimer.current)
    }
  }, [watching])

  // expanded, the page behind stays still: the wheel and the finger over the backdrop or the video scroll nothing
  useEffect(() => {
    if (!expanded) return
    const still = (event: Event) => {
      if (!(event.target as Element | null)?.closest?.('input')) event.preventDefault()
    }
    const parts = [section.current?.querySelector('.mplayer-backdrop'), box.current].filter((part): part is Element => Boolean(part))
    for (const part of parts) {
      part.addEventListener('wheel', still, { passive: false })
      part.addEventListener('touchmove', still, { passive: false })
    }
    const root = document.documentElement
    const before = root.style.overflow
    root.style.overflow = 'hidden'
    return () => {
      for (const part of parts) {
        part.removeEventListener('wheel', still)
        part.removeEventListener('touchmove', still)
      }
      root.style.overflow = before
    }
  }, [expanded])

  useEffect(() => {
    if (expanded) {
      opened.current = true
      shrinkButton.current?.focus()
    } else if (opened.current) {
      opened.current = false
      expandButton.current?.focus()
    }
  }, [expanded])

  // crossOrigin before src: React sets them in this order, and with src first Chrome starts the load without
  // CORS and then refuses every seek of the remote media ("FFmpegDemuxer: demuxer seek failed")
  const events = {
    crossOrigin: media.remote ? ('anonymous' as const) : undefined,
    // a shared media comes from the internet: downloading ahead keeps the play and the jumps from waiting
    preload: media.remote ? 'auto' : 'metadata',
    src: media.url ?? undefined,
    onPlay: (event: SyntheticEvent<HTMLMediaElement>) => {
      bothEars(event.currentTarget)
      setPlaying(true)
    },
    onPause: () => setPlaying(false),
    onLoadStart: () => setWaiting(true),
    onCanPlay: () => {
      setReady(true)
      setWaiting(false)
    },
    onPlaying: () => {
      setReady(true)
      setWaiting(false)
    },
    onWaiting: () => setWaiting(true),
    onSeeking: () => setWaiting(true),
    onSeeked: () => setWaiting(false),
    onStalled: (event: SyntheticEvent<HTMLMediaElement>) => void (!event.currentTarget.paused && setWaiting(true)),
    // preload "metadata" stops after the start on purpose: that is not loading
    onSuspend: (event: SyntheticEvent<HTMLMediaElement>) => void (event.currentTarget.readyState >= 1 && setWaiting(false)),
    onProgress: (event: SyntheticEvent<HTMLMediaElement>) => setLoaded(loadedOf(event.currentTarget)),
    // Chrome sometimes fails the first load made while the app opens ("FFmpegDemuxer: demuxer seek failed",
    // MEDIA_ERR_NETWORK) and then never asks for more bytes; the same element loaded again a moment later plays and seeks.
    onError: (event: SyntheticEvent<HTMLMediaElement>) => {
      const element = event.currentTarget
      const code = element.error?.code ?? 0
      if (code !== 2 || reloads.current.count >= 3) {
        const url = media.url
        setWaiting(false)
        void failureOf(media, code).then(reason => reloads.current.url === url && setFailure(reason))
        return
      }
      const count = ++reloads.current.count
      const at = element.currentTime
      setTimeout(() => {
        if (!element.error) return
        if (at > 0) element.addEventListener('loadedmetadata', () => void (element.currentTime = at), { once: true })
        element.load()
      }, 1500 * 2 ** (count - 1))
    },
    onDurationChange: (event: SyntheticEvent<HTMLMediaElement>) => {
      setDuration(Number.isFinite(event.currentTarget.duration) ? event.currentTarget.duration : 0)
      setLoaded(loadedOf(event.currentTarget))
    },
    onTimeUpdate: (event: SyntheticEvent<HTMLMediaElement>) => {
      setTime(event.currentTarget.currentTime)
      onTime(event.currentTarget.currentTime)
    },
  }

  return (
    <section
      ref={section}
      className="mplayer"
      aria-label="Player da gravação"
      onKeyDown={event => {
        wake()
        handleKey(event.nativeEvent)
      }}
    >
      {expanded && <div className="mplayer-backdrop" aria-hidden="true" onClick={shrink} />}
      <div
        ref={box}
        className="mplayer-box"
        data-big={expanded ? 'true' : undefined}
        data-fullscreen={fullscreen ? 'true' : undefined}
        data-idle={watching && idle ? 'true' : undefined}
        onMouseMove={watching ? wake : undefined}
        onPointerDown={watching ? wake : undefined}
        role={expanded ? 'dialog' : undefined}
        aria-modal={expanded ? true : undefined}
        aria-label={expanded ? 'Player da gravação ampliado' : undefined}
      >
        {media.video ? (
          <div className="mplayer-stage" onClick={expanded ? toggle : undefined} onDoubleClick={expanded ? toggleFullscreen : undefined}>
            <video ref={element => void (player.current = element)} playsInline {...events} />
            {failure && expanded && (
              <p className="mplayer-failure" role="alert">
                {failure}
              </p>
            )}
            {!expanded && (
              <button ref={expandButton} className="mplayer-shot" aria-label="Ampliar a tela" aria-expanded="false" title="Ampliar a tela" onClick={() => setBig(true)}>
                <Icon name="expand" />
              </button>
            )}
          </div>
        ) : (
          <audio ref={element => void (player.current = element)} {...events} />
        )}
        <div className="mplayer-controls">
          <Tool className="mplayer-play" label={playing ? 'Pausar' : 'Tocar'} hint={playing ? 'Pausar (K)' : 'Tocar (K)'} icon={<Glyph playing={playing} />} onClick={toggle} />
          {failure ? (
            <>
              {!expanded && (
                <span className="mplayer-failure" role="alert">
                  {failure}
                </span>
              )}
              <button className="btn quiet mplayer-retry" onClick={retry}>
                Tentar de novo
              </button>
            </>
          ) : (
            <>
              <Tool label="Voltar 10 segundos" hint="Voltar 10 segundos (J)" icon={<Icon name="back" size={20} />} onClick={() => skip(-SKIP)} disabled={!duration} />
              <Tool label="Avançar 10 segundos" hint="Avançar 10 segundos (L)" icon={<Icon name="forward" size={20} />} onClick={() => skip(SKIP)} disabled={!duration} />
              <div className="mplayer-scrub">
                <span className="mplayer-time">{clockTime(time)}</span>
                <input
                  className="mplayer-bar"
                  type="range"
                  aria-label="Posição na gravação"
                  aria-valuetext={`${clockTime(time)} de ${clockTime(duration)}`}
                  title={media.remote && duration ? loadedTitle(loaded, media.size) : undefined}
                  style={{ '--played': percent(duration ? Math.min(time, duration) / duration : 0), '--loaded': loadedLayer(loaded) } as CSSProperties}
                  min={0}
                  max={duration}
                  step={1}
                  value={Math.min(time, duration)}
                  disabled={!duration}
                  onChange={event => moveTo(Number(event.target.value))}
                />
                <span className="mplayer-time">{clockTime(duration)}</span>
              </div>
              <select className="mplayer-speed" aria-label="Velocidade" title="Velocidade" value={String(prefs.speed)} onChange={event => keep({ speed: Number(event.target.value) })}>
                {SPEEDS.map(speed => (
                  <option key={speed} value={String(speed)}>
                    {speedName(speed)}
                  </option>
                ))}
              </select>
              <Tool label={silent ? 'Voltar o som' : 'Tirar o som'} hint={silent ? 'Voltar o som (M)' : 'Tirar o som (M)'} icon={<Icon name={silent ? 'muted' : 'volume'} />} onClick={mute} />
              <input
                className="mplayer-vol"
                type="range"
                aria-label="Volume"
                aria-valuetext={`${Math.round((prefs.muted ? 0 : prefs.volume) * 100)}%`}
                style={{ '--played': percent(prefs.muted ? 0 : prefs.volume) } as CSSProperties}
                min={0}
                max={100}
                step={5}
                value={Math.round((prefs.muted ? 0 : prefs.volume) * 100)}
                onChange={event => keep({ volume: Number(event.target.value) / 100, muted: false })}
              />
            </>
          )}
          {expanded && <Tool label={fullscreen ? 'Sair da tela cheia' : 'Tela cheia'} hint={fullscreen ? 'Sair da tela cheia (F)' : 'Tela cheia (F)'} icon={<Icon name={fullscreen ? 'leave' : 'fullscreen'} />} onClick={toggleFullscreen} />}
          {expanded && <Tool ref={shrinkButton} label="Diminuir a tela" hint="Diminuir a tela (Esc)" icon={<Icon name="shrink" />} onClick={shrink} aria-expanded={true} />}
        </div>
        {waiting && !failure && (
          <span className="mplayer-state" role="status">
            {ready ? 'Carregando…' : 'Carregando a mídia…'}
          </span>
        )}
      </div>
    </section>
  )
}
