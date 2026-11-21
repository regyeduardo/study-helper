import { descendantsOf } from '@/lib/family'
import { readsAsTranscript } from '@/lib/file-types'
import { transcriptText } from '@/lib/transcription/export'
import { renameInText, renameSpeaker } from '@/lib/transcription/turns'
import { useLibraryStore } from '@/stores/library'

/**
 * Renaming a voice reaches everything that shows it (spec 003, FR-060): the recording and the transcript of the note, the note's text, and
 * the notes born of it, grandchildren included (the Ata and its document, an Explicação…). Quoted lines keep what was said.
 */
export async function renameSpeakerEverywhere(fileId: string, speakerId: string, name: string): Promise<void> {
  const library = useLibraryStore.getState()
  const meta = library.files.find(file => file.id === fileId)
  const opened = await library.openFile(fileId)
  const recording = opened.sidecar.recording
  const before = recording?.speakers.find(speaker => speaker.id === speakerId)
  if (!meta || !recording || !before) return
  const renamed = renameSpeaker(recording, speakerId, name)
  const text = transcriptText(renamed).trim()
  await library.updateSidecar(fileId, sidecar => ({ ...sidecar, recording: renamed, ...(sidecar.transcript !== undefined || readsAsTranscript(meta) ? { transcript: text } : {}) }))
  const content = readsAsTranscript(meta) ? (opened.content.trim() ? text : opened.content) : renameInText(opened.content, before.name, name)
  if (content !== opened.content) await library.saveContent(fileId, content)
  if (before.name === name) return
  for (const child of descendantsOf(useLibraryStore.getState().files, fileId)) {
    const born = await useLibraryStore.getState().openFile(child.id)
    const changed = renameInText(born.content, before.name, name)
    if (changed !== born.content) await useLibraryStore.getState().saveContent(child.id, changed)
    const documents = born.sidecar.documents
    if (documents?.some(document => renameInText(document.markdown, before.name, name) !== document.markdown)) {
      await useLibraryStore.getState().updateSidecar(child.id, sidecar => ({ ...sidecar, documents: sidecar.documents?.map(document => ({ ...document, markdown: renameInText(document.markdown, before.name, name) })) }))
    }
  }
}
