import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react'

import type { RecordingData, RecordingMark } from '@/types/domain'
import { MediaPlayer, type MeetingMedia } from '@/components/reader/MediaPlayer'
import { MinutesTab } from '@/components/reader/MinutesTab'
import { TranscriptTab } from '@/components/reader/TranscriptTab'
import { Icon } from '@/components/ui/Icon'
import { clockTime, speakerName } from '@/lib/transcription/export'
import type { SecondTabAgent } from '@/stores/jobs'

export interface SecondTab {
  label: string
  node: ReactNode
}

interface MeetingTabsProps {
  recording: RecordingData
  media: MeetingMedia
  name?: string
  second?: SecondTab
  onRename?(speakerId: string, name: string): void
  onGenerate?(agent: SecondTabAgent): void
  onRedo?(): void
  onMarks?(marks: RecordingMark[]): void
}

type TabId = 'transcript' | 'second'

export function MeetingTabs({ recording, media, name, second, onRename, onGenerate, onRedo, onMarks }: MeetingTabsProps) {
  const player = useRef<HTMLMediaElement | null>(null)
  const [tab, setTab] = useState<TabId>(second ? 'second' : 'transcript')
  const [time, setTime] = useState<number | null>(null)
  const [waiting, setWaiting] = useState<number | null>(null)
  const shown: TabId = second ? tab : 'transcript'
  const hasSecond = Boolean(second)

  useEffect(() => {
    if (hasSecond) setTab('second')
  }, [hasSecond])

  const start = useCallback((seconds: number) => {
    const audio = player.current
    if (!audio) return
    audio.currentTime = seconds
    setTime(seconds)
    void Promise.resolve(audio.play()).catch(() => undefined)
  }, [])

  const playFrom = (seconds: number) => {
    if (media.url) start(seconds)
    else {
      setWaiting(seconds)
      void media.request()
    }
  }

  useEffect(() => {
    if (waiting === null || !media.url) return
    setWaiting(null)
    start(waiting)
  }, [waiting, media.url, start])

  const speaking = time === null ? undefined : recording.blocks.findLast(block => block.start <= time)

  return (
    <div className="meeting">
      <div className="meeting-tabs" role="tablist" aria-label="Partes da nota">
        <button role="tab" aria-selected={shown === 'transcript'} onClick={() => setTab('transcript')}>
          Transcrição
        </button>
        {second && (
          <button role="tab" aria-selected={shown === 'second'} onClick={() => setTab('second')}>
            {second.label}
          </button>
        )}
        {second && onRedo && (
          <span className="meeting-make">
            <button className="btn" onClick={onRedo}>
              <Icon name="sync" />
              Refazer a {second.label}
            </button>
          </span>
        )}
        {!second && onGenerate && (
          <span className="meeting-make">
            <button className="btn" onClick={() => onGenerate('meeting')}>
              <Icon name="plus" />
              Gerar a Ata
            </button>
            <button className="btn" onClick={() => onGenerate('lesson')}>
              <Icon name="plus" />
              Gerar a Aula
            </button>
          </span>
        )}
      </div>
      {shown === 'second' && second ? (
        <MinutesTab frames={recording.frames} onMoment={playFrom}>{second.node}</MinutesTab>
      ) : (
        <TranscriptTab recording={recording} name={name} time={time} onPlay={media.available ? playFrom : undefined} onRename={onRename} onMarks={onMarks} />
      )}
      {media.available && (
        <div className="meeting-dock">
          {speaking && shown === 'second' && (
            <button className="meeting-now" aria-label={`Ver na transcrição: ${speaking.text}`} title="Ver na transcrição" onClick={() => setTab('transcript')}>
              <b>{speaking.speaker ? speakerName(recording, speaking.speaker) : clockTime(speaking.start)}</b>
              <span>{speaking.text}</span>
            </button>
          )}
          <MediaPlayer player={player} media={media} onTime={setTime} onPlayFrom={playFrom} />
        </div>
      )}
    </div>
  )
}
