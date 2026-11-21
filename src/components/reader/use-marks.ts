import { useState } from 'react'

import type { FileSidecar, RecordingMark } from '@/types/domain'
import type { MarkActions } from '@/components/reader/Markers'
import { newId } from '@/lib/ids'
import { useLibraryStore } from '@/stores/library'

/** The marks of a recording, in the order of the media. */
export const inOrder = (marks: RecordingMark[]): RecordingMark[] => [...marks].sort((a, b) => a.at - b.at)

/** A flag at a moment, with no text yet. */
export const newMark = (at: number): RecordingMark => ({ id: newId(), kind: 'mark', at, text: '' })

/** The sidecar with these marks; a media that was never transcribed gets a recording with no speech to hold them. */
export function withMarks(sidecar: FileSidecar, marks: RecordingMark[]): FileSidecar {
  return { ...sidecar, recording: { blocks: [], speakers: [], ...sidecar.recording, marks } }
}

/** Shows the marks at once and saves them behind, so that a slow storage never makes the field wait. */
export function saveMarks(fileId: string, marks: RecordingMark[]): void {
  useLibraryStore.setState(state => (state.opened[fileId] ? { opened: { ...state.opened, [fileId]: { ...state.opened[fileId], sidecar: withMarks(state.opened[fileId].sidecar, marks) } } } : {}))
  void useLibraryStore.getState().updateSidecar(fileId, sidecar => withMarks(sidecar, marks))
}

/**
 * The marks of one media and the one being edited. A mark made at the player (`add`) opens for editing
 * wherever the list is, so the state lives above both. Without `onMarks` nothing can be changed.
 */
export function useMarks(marks: RecordingMark[], onMarks?: (marks: RecordingMark[]) => void) {
  const [editing, setEditing] = useState<string | null>(null)
  const actions: MarkActions | undefined = onMarks && {
    editing,
    onEditing: setEditing,
    onChange: changed => onMarks(marks.map(mark => (mark.id === changed.id ? changed : mark))),
    onRemove: id => {
      setEditing(null)
      onMarks(marks.filter(mark => mark.id !== id))
    },
  }
  const add = onMarks && ((seconds: number) => {
    const mark = newMark(seconds)
    onMarks(inOrder([...marks, mark]))
    setEditing(mark.id)
  })
  return { actions, add, editing, setEditing }
}
