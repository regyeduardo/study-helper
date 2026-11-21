// Shared set-up of the entry-chat-*.test.tsx files: an entrada with a recording, its Ata and (maybe) the media kept in this browser.
import type { Artifact, RecordingData, TutorArtifact } from '@/types/domain'
import { artifactMeta } from '@/lib/artifacts'
import { useLibraryStore } from '@/stores/library'
import { studyLibrary } from '@/test/generation/study-fixture'

export const RECORDING: RecordingData = {
  blocks: [
    { speaker: 's1', start: 12, end: 20, text: 'O prazo do portal novo é março.' },
    { speaker: 's2', start: 100, end: 110, text: 'O fornecedor pediu mais duas semanas.' },
  ],
  speakers: [
    { id: 's1', name: 'Marina', suggested: false },
    { id: 's2', name: 'Rafael', suggested: false },
  ],
  marks: [],
}

export type MediaKind = 'audio' | 'video' | 'none'

/** `kept`: the files the mocked `readLocalMedia` hands out, by entrada id. `seconds` 0 = the length is not known. */
export async function chatEntry({ media = 'audio', seconds = 300, kept }: { media?: MediaKind; seconds?: number; kept: Map<string, File> }) {
  const memory = studyLibrary()
  const library = useLibraryStore.getState()
  const mime = media === 'video' ? 'video/mp4' : 'audio/webm'
  const name = media === 'video' ? 'Reunião de kickoff.mp4' : 'Reunião de kickoff.webm'
  const entry = await library.createFile({ name, type: 'reading', role: 'entrada', folderId: null, origin: { input: 'recording', name, mime, storage: 'none' } }, 'texto corrido')
  await library.updateSidecar(entry.id, sidecar => ({ ...sidecar, recording: RECORDING }))
  const ata = await library.createFile({ name: 'Ata do kickoff', type: 'meeting', parentFileId: entry.id, folderId: null }, '# Ata\n\nPrazo do portal: março.')
  if (media !== 'none') {
    kept.set(entry.id, new File(['som'], name, { type: mime }))
    useLibraryStore.setState({ localMedia: [{ storedName: 'envio-1', name, mime, durationSeconds: seconds, size: 3, createdAt: '', fileIds: [entry.id] }] })
  }
  return { memory, entry: entry.id, ata: ata.id, name }
}

export interface Seed {
  id: string
  turns: TutorArtifact['turns']
  updatedAt: string
  scope?: TutorArtifact['scope']
  name?: string
}

/** Conversations written straight into the entrada's sidecar, with the dates given (a save would stamp "now"). */
export async function seedConversations(fileId: string, seeds: Seed[]): Promise<void> {
  const list: Artifact[] = seeds.map(seed => ({
    id: seed.id,
    kind: 'tutor',
    name: seed.name ?? seed.turns[0]?.text ?? 'Conversa',
    createdAt: seed.updatedAt,
    updatedAt: seed.updatedAt,
    turns: seed.turns,
    ...(seed.scope ? { scope: seed.scope } : {}),
  }))
  await useLibraryStore.getState().updateSidecar(fileId, sidecar => ({ ...sidecar, artifacts: list, meta: { ...sidecar.meta, ...artifactMeta(list) } }))
}

/** What is saved in the entrada, straight from the repository. */
export const savedConversations = (memory: ReturnType<typeof studyLibrary>, fileId: string): TutorArtifact[] => (memory.sidecars.get(fileId)?.artifacts ?? []).filter((item): item is TutorArtifact => item.kind === 'tutor')
