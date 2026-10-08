import { diffWords } from 'diff'
import { type MouseEvent, type ReactNode, useState } from 'react'

import type { RecordingData, RecordingMark, RecordingSpeaker, TranscriptBlock } from '@/types/domain'
import { type MarkActions, MarkGlyph, Markers } from '@/components/reader/Markers'
import { Icon } from '@/components/ui/Icon'
import { newId } from '@/lib/ids'
import { clockTime, transcriptSrt, transcriptText } from '@/lib/transcription/export'
import { downloadBlob, safeFilename } from '@/utils/download'

const TONES = 4

interface TranscriptTabProps {
  recording: RecordingData
  name?: string
  time?: number | null
  onPlay?(seconds: number): void
  onRename?(speakerId: string, name: string): void
  onMarks?(marks: RecordingMark[]): void
}

const apart = (event: MouseEvent) => event.stopPropagation()

function Speech({ block }: { block: TranscriptBlock }) {
  if (!block.original) return <p>{block.text}</p>
  const parts: ReactNode[] = []
  let heard = ''
  for (const [index, part] of diffWords(block.original, block.text).entries()) {
    if (part.removed) heard = part.value
    else if (part.added) {
      parts.push(
        <span key={index} className="tr-fix" title={`Ouvido: ${heard.trim() || 'nada'}`}>
          {part.value}
        </span>,
      )
      heard = ''
    } else {
      parts.push(part.value)
      heard = ''
    }
  }
  return <p>{parts}</p>
}

function Who({ speaker, onRename }: { speaker: RecordingSpeaker; onRename?(speakerId: string, name: string): void }) {
  const [draft, setDraft] = useState<string | null>(null)
  const commit = () => {
    const name = draft?.trim()
    setDraft(null)
    if (name && (name !== speaker.name || speaker.suggested)) onRename?.(speaker.id, name)
  }
  if (draft !== null) {
    return (
      <input
        className="tr-rename"
        aria-label="Nome do falante"
        autoFocus
        value={draft}
        onClick={apart}
        onFocus={event => event.target.select()}
        onChange={event => setDraft(event.target.value)}
        onBlur={() => setDraft(null)}
        onKeyDown={event => {
          if (event.key === 'Enter') commit()
          if (event.key === 'Escape') setDraft(null)
        }}
      />
    )
  }
  return (
    <>
      {onRename ? (
        <button
          className="tr-who"
          aria-label={`Renomear ${speaker.name}`}
          title="Renomear em todas as falas"
          onClick={event => {
            apart(event)
            setDraft(speaker.name)
          }}
        >
          {speaker.name}
        </button>
      ) : (
        <span className="tr-who">{speaker.name}</span>
      )}
      {speaker.suggested && <span className="tr-hint">sugestão</span>}
      {speaker.suggested && onRename && (
        <button
          className="tr-ok"
          aria-label={`Confirmar o nome ${speaker.name}`}
          title="Confirmar este nome"
          onClick={event => {
            apart(event)
            onRename(speaker.id, speaker.name)
          }}
        >
          <svg className="ic" viewBox="0 0 24 24" aria-hidden="true">
            <path d="m5 12.5 4.5 4.5L19 7.5" />
          </svg>
        </button>
      )}
    </>
  )
}

export function TranscriptTab({ recording, name = 'reunião', time = null, onPlay, onRename, onMarks }: TranscriptTabProps) {
  const [editing, setEditing] = useState<string | null>(null)
  const ids = recording.speakers.map(speaker => speaker.id)
  const playing = time === null ? -1 : recording.blocks.findLastIndex(block => block.start <= time)
  const marked = new Map<number, RecordingMark[]>()
  for (const mark of recording.marks) {
    const at = Math.max(0, recording.blocks.findLastIndex(block => block.start <= mark.at))
    marked.set(at, [...(marked.get(at) ?? []), mark])
  }
  const ordered = (marks: RecordingMark[]) => [...marks].sort((a, b) => a.at - b.at)
  const actions: MarkActions | undefined = onMarks && {
    editing,
    onEditing: setEditing,
    onChange: changed => onMarks(recording.marks.map(mark => (mark.id === changed.id ? changed : mark))),
    onRemove: id => {
      setEditing(null)
      onMarks(recording.marks.filter(mark => mark.id !== id))
    },
  }
  const markAt = (seconds: number) => {
    const mark: RecordingMark = { id: newId(), kind: 'mark', at: seconds, text: '' }
    onMarks?.(ordered([...recording.marks, mark]))
    setEditing(mark.id)
  }
  const play = (seconds: number) => {
    if (onPlay && !window.getSelection()?.toString()) onPlay(seconds)
  }
  const save = (text: string, extension: string) => downloadBlob(new Blob([text], { type: 'text/plain;charset=utf-8' }), `${safeFilename(name)} - transcrição.${extension}`)
  return (
    <>
      <div className="tr-tools">
        <button className="btn" onClick={() => save(transcriptText(recording), 'txt')}>
          <Icon name="download" />
          Exportar .txt
        </button>
        <button className="btn" onClick={() => save(transcriptSrt(recording), 'srt')}>
          <Icon name="download" />
          Exportar .srt
        </button>
      </div>
      {recording.warning && (
        <div className="banner" role="status" style={{ marginTop: 10 }}>
          {recording.warning}
        </div>
      )}
      <ol className="tr-list" aria-label="Transcrição">
        {recording.blocks.map((block, index) => {
          const position = ids.indexOf(block.speaker)
          const clock = clockTime(block.start)
          return (
            <li
              key={`${block.start}-${block.speaker}`}
              className={onPlay ? 'tr-block playable' : 'tr-block'}
              data-tone={block.speaker ? (Math.max(position, 0) % TONES) + 1 : 0}
              aria-current={index === playing ? 'true' : undefined}
              onClick={() => play(block.start)}
            >
              <div className="tr-head">
                {block.speaker && <Who speaker={recording.speakers[position] ?? { id: block.speaker, name: block.speaker, suggested: false }} onRename={onRename} />}
                {onPlay ? (
                  <button className="tr-time" aria-label={`Tocar a partir de ${clock}`}>
                    {clock}
                  </button>
                ) : (
                  <time className="tr-time">{clock}</time>
                )}
                {onMarks && (
                  <button
                    className="tr-add"
                    aria-label="Marcar esta fala"
                    title="Marcar ou anotar esta fala"
                    onClick={event => {
                      apart(event)
                      markAt(block.start)
                    }}
                  >
                    <MarkGlyph kind="mark" />
                  </button>
                )}
              </div>
              <Speech block={block} />
              <Markers marks={marked.get(index) ?? []} actions={actions} />
            </li>
          )
        })}
      </ol>
    </>
  )
}
