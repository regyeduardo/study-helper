import type { Blocker } from '@/lib/blocking'
import { descendantsOf } from '@/lib/family'
import { readsAsTranscript } from '@/lib/file-types'
import { transcriptText } from '@/lib/transcription/export'
import { renameInText, renameSpeaker } from '@/lib/transcription/turns'
import { working } from '@/lib/working'
import { useLibraryStore } from '@/stores/library'

/**
 * Renaming a voice reaches everything that shows it (spec 003, FR-060): the recording and the transcript of the note, the note's text, and
 * the notes born of it, grandchildren included (the Ata and its document, an Explicação…). Quoted lines keep what was said.
 * `blocker` hears "2 de 5" as each note is written.
 */
export async function renameSpeakerEverywhere(fileId: string, speakerId: string, name: string, blocker?: Pick<Blocker, 'progress'>): Promise<void> {
  const library = useLibraryStore.getState()
  const meta = library.files.find(file => file.id === fileId)
  const opened = await library.openFile(fileId)
  const recording = opened.sidecar.recording
  const before = recording?.speakers.find(speaker => speaker.id === speakerId)
  if (!meta || !recording || !before) return
  const children = before.name === name ? [] : descendantsOf(useLibraryStore.getState().files, fileId)
  blocker?.progress({ done: 0, total: 1 + children.length, current: meta.name })
  const renamed = renameSpeaker(recording, speakerId, name)
  const text = transcriptText(renamed).trim()
  await library.updateSidecar(fileId, sidecar => ({ ...sidecar, recording: renamed, ...(sidecar.transcript !== undefined || readsAsTranscript(meta) ? { transcript: text } : {}) }))
  const content = readsAsTranscript(meta) ? (opened.content.trim() ? text : opened.content) : renameInText(opened.content, before.name, name)
  if (content !== opened.content) await library.saveContent(fileId, content)
  blocker?.progress({ done: 1 })
  for (const [index, child] of children.entries()) {
    blocker?.progress({ current: child.name })
    const born = await useLibraryStore.getState().openFile(child.id)
    const changed = renameInText(born.content, before.name, name)
    if (changed !== born.content) await useLibraryStore.getState().saveContent(child.id, changed)
    const documents = born.sidecar.documents
    if (documents?.some(document => renameInText(document.markdown, before.name, name) !== document.markdown)) {
      await useLibraryStore.getState().updateSidecar(child.id, sidecar => ({ ...sidecar, documents: sidecar.documents?.map(document => ({ ...document, markdown: renameInText(document.markdown, before.name, name) })) }))
    }
    blocker?.progress({ done: index + 2 })
  }
}

/**
 * The rename from a click (the note and the entrada): the app waits in the window "Trocando o nome em 4 notas…" with the count until the
 * last note is written, and a failure stays there with its reason. Confirming a suggested name rewrites only the note.
 */
export function renameSpeakerOnClick(fileId: string, speakerId: string, name: string): Promise<boolean> {
  const library = useLibraryStore.getState()
  const same = library.opened[fileId]?.sidecar.recording?.speakers.find(speaker => speaker.id === speakerId)?.name === name
  const notes = same ? 1 : 1 + descendantsOf(library.files, fileId).length
  return working(`Trocando o nome em ${notes} ${notes === 1 ? 'nota' : 'notas'}…`, blocker => renameSpeakerEverywhere(fileId, speakerId, name, blocker))
}
