import { type CSSProperties, type RefObject, type SyntheticEvent, useCallback, useEffect, useRef, useState } from 'react'

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

function Glyph({ playing }: { playing: boolean }) {
  return (
    <svg className="ic" viewBox="0 0 24 24" aria-hidden="true">
      {playing ? <path d="M8.5 5.5v13M15.5 5.5v13" /> : <path d="M8 5.5v13l10.5-6.5z" fill="currentColor" />}
    </svg>
  )
}

export function MediaPlayer({ player, media, onTime, onPlayFrom }: MediaPlayerProps) {
  const [playing, setPlaying] = useState(false)
  const [time, setTime] = useState(0)
  const [duration, setDuration] = useState(0)
  const [big, setBig] = useState(false)
  const [waiting, setWaiting] = useState(Boolean(media.url))
  const [ready, setReady] = useState(false)
  const [loaded, setLoaded] = useState<[number, number][]>([])
  const [failure, setFailure] = useState<string | null>(null)
  const reloads = useRef({ url: media.url, count: 0 })
  if (reloads.current.url !== media.url) {
    reloads.current = { url: media.url, count: 0 }
    setWaiting(Boolean(media.url))
    setReady(false)
    setLoaded([])
    setFailure(null)
  }

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
    <section className="mplayer" aria-label="Player da gravação">
      {media.video ? (
        <button className="mplayer-shot" aria-label={big ? 'Diminuir a tela' : 'Ampliar a tela'} aria-expanded={big} title={big ? 'Diminuir a tela' : 'Ampliar a tela'} onClick={() => setBig(!big)}>
          <video ref={element => void (player.current = element)} playsInline {...events} />
        </button>
      ) : (
        <audio ref={element => void (player.current = element)} {...events} />
      )}
      <button className="ibtn mplayer-play" onClick={toggle} aria-label={playing ? 'Pausar' : 'Tocar'} title={playing ? 'Pausar' : 'Tocar'}>
        <Glyph playing={playing} />
      </button>
      {failure ? (
        <>
          <span className="mplayer-failure" role="alert">
            {failure}
          </span>
          <button className="btn quiet" onClick={retry}>
            Tentar de novo
          </button>
        </>
      ) : (
        <>
          <span className="mplayer-time">{clockTime(time)}</span>
          <input
            className="mplayer-bar"
            type="range"
            aria-label="Posição na gravação"
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
          {waiting && (
            <span className="mplayer-state" role="status">
              {ready ? 'Carregando…' : 'Carregando a mídia…'}
            </span>
          )}
        </>
      )}
    </section>
  )
}
