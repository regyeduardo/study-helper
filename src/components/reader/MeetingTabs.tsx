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
  ata?: ReactNode
  onChooseParts?(): void
  onRename?(speakerId: string, name: string): void
  onGenerate?(agent: SecondTabAgent): void
  onRedo?(): void
  onRedoTranscript?(instruction: string): void
  onMarks?(marks: RecordingMark[]): void
  startAt?: number
}

type TabId = 'transcript' | 'second' | 'ata'

export function MeetingTabs({ recording, media, name, second, ata, onChooseParts, onRename, onGenerate, onRedo, onRedoTranscript, onMarks, startAt }: MeetingTabsProps) {
  const player = useRef<HTMLMediaElement | null>(null)
  const [tab, setTab] = useState<TabId>(startAt !== undefined ? 'transcript' : ata ? 'ata' : second ? 'second' : 'transcript')
  const [time, setTime] = useState<number | null>(startAt ?? null)
  const [waiting, setWaiting] = useState<number | null>(startAt ?? null)

  useEffect(() => {
    if (startAt !== undefined && !media.url) void media.request()
  }, [])
  const shown: TabId = tab === 'ata' ? (ata ? 'ata' : 'transcript') : tab === 'second' && !second ? 'transcript' : tab
  const hasSecond = Boolean(second)
  const hasAta = Boolean(ata)
  const secondLabel = second && ata && second.label === 'Ata' ? 'Ata anterior' : second?.label

  useEffect(() => {
    if (hasSecond) setTab('second')
  }, [hasSecond])

  useEffect(() => {
    if (hasAta) setTab('ata')
  }, [hasAta])

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
        {ata && (
          <button role="tab" aria-selected={shown === 'ata'} onClick={() => setTab('ata')}>
            Ata
          </button>
        )}
        {second && (
          <button role="tab" aria-selected={shown === 'second'} onClick={() => setTab('second')}>
            {secondLabel}
          </button>
        )}
        {second && onRedo && !(onChooseParts && second.label === 'Ata') && (
          <span className="meeting-make">
            <button className="btn" onClick={onRedo}>
              <Icon name="sync" />
              Refazer a {secondLabel}
            </button>
          </span>
        )}
        {!second && onGenerate && (
          <span className="meeting-make">
            <button className="btn" onClick={() => onGenerate('lesson')}>
              <Icon name="plus" />
              Gerar a Aula
            </button>
          </span>
        )}
        {onChooseParts && (
          <span className="meeting-make">
            <button className="btn" onClick={onChooseParts}>
              <Icon name="plus" />
              {ata || second?.label === 'Ata' ? 'Refazer a Ata' : 'Gerar a Ata'}
            </button>
          </span>
        )}
      </div>
      {shown === 'ata' && ata ? (
        <MinutesTab onMoment={playFrom}>{ata}</MinutesTab>
      ) : shown === 'second' && second ? (
        <MinutesTab frames={recording.frames} onMoment={playFrom}>{second.node}</MinutesTab>
      ) : (
        <TranscriptTab recording={recording} name={name} time={time} onPlay={media.available ? playFrom : undefined} onRename={onRename} onMarks={onMarks} onRedo={onRedoTranscript} />
      )}
      {media.available && (
        <div className="meeting-dock">
          {speaking && shown !== 'transcript' && (
            <button className="meeting-now" aria-label={`Ver na transcrição: ${speaking.text}`} title="Ver na transcrição" onClick={() => setTab('transcript')}>
              <b>{speaking.speaker ? speakerName(recording, speaking.speaker) : clockTime(speaking.start)}</b>
              <span>{speaking.text}</span>
            </button>
          )}
          <MediaPlayer player={player} media={media} onTime={setTime} onPlayFrom={playFrom} />
        </div>
      )}
      {!media.available && media.notice && (
        <div className="banner" role="status">
          {media.notice}
        </div>
      )}
    </div>
  )
}
