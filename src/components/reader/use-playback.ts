import { useEffect, useRef, useState } from 'react'

import { type MeetingMedia, playAt } from '@/components/reader/MediaPlayer'

/** Plays from a second; a media not opened yet (kept in Drive) is asked for first, and plays as soon as it arrives. */
export function usePlayback(media: MeetingMedia) {
  const player = useRef<HTMLMediaElement | null>(null)
  const [time, setTime] = useState<number | null>(null)
  const [waiting, setWaiting] = useState<number | null>(null)
  const playFrom = (seconds: number) => {
    if (media.url && player.current) {
      setTime(seconds)
      return playAt(player.current, seconds)
    }
    setWaiting(seconds)
    void media.request()
  }
  useEffect(() => {
    if (waiting === null || !media.url || !player.current) return
    setWaiting(null)
    setTime(waiting)
    playAt(player.current, waiting)
  }, [waiting, media.url])
  return { player, time, setTime, playFrom }
}
