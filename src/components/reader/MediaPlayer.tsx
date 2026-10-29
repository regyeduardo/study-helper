import { type RefObject, type SyntheticEvent, useCallback, useEffect, useRef, useState } from 'react'

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
  notice?: string
  request(): Promise<void>
}

export const SHARED_MEDIA_EXPIRED = 'A mídia deste compartilhamento expirou (fica 3 dias).'

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
    return { url: sharedMedia.url, available: true, video, remote: true, request: nothing }
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

  const toggle = () => {
    if (playing) player.current?.pause()
    else onPlayFrom(time)
  }
  const moveTo = (seconds: number) => {
    if (player.current) player.current.currentTime = seconds
    setTime(seconds)
    onTime(seconds)
  }

  const events = {
    src: media.url ?? undefined,
    crossOrigin: media.remote ? ('anonymous' as const) : undefined,
    preload: 'metadata',
    onPlay: (event: SyntheticEvent<HTMLMediaElement>) => {
      bothEars(event.currentTarget)
      setPlaying(true)
    },
    onPause: () => setPlaying(false),
    onDurationChange: (event: SyntheticEvent<HTMLMediaElement>) => setDuration(Number.isFinite(event.currentTarget.duration) ? event.currentTarget.duration : 0),
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
      <span className="mplayer-time">{clockTime(time)}</span>
      <input className="mplayer-bar" type="range" aria-label="Posição na gravação" min={0} max={duration} step={1} value={Math.min(time, duration)} disabled={!duration} onChange={event => moveTo(Number(event.target.value))} />
      <span className="mplayer-time">{clockTime(duration)}</span>
    </section>
  )
}
