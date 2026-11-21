// FR-060 (spec 003): trocar à mão o nome de quem fala vale em tudo o que mostra aquela voz: a gravação, a transcrição, o texto da nota e as notas que nasceram dela.
import { beforeEach, describe, expect, it } from 'vitest'

import type { MeetingDocument, RecordingData } from '@/types/domain'
import { renameSpeakerEverywhere } from '@/lib/transcription/rename-everywhere'
import { useLibraryStore } from '@/stores/library'
import { studyLibrary } from '@/test/generation/study-fixture'

const RECORDING: RecordingData = {
  blocks: [
    { speaker: 's1', start: 12, end: 20, text: 'O prazo do portal novo é março.' },
    { speaker: 's2', start: 100, end: 110, text: 'O fornecedor pediu mais duas semanas.' },
  ],
  speakers: [
    { id: 's1', name: 'Marina', suggested: false },
    { id: 's2', name: 'Falante 2', suggested: true },
  ],
  marks: [],
}

const ATA = '# Ata\n\n- Falante 2 pediu mais duas semanas.\n- Marina confirmou março.\n\n> Falante 2: "O fornecedor pediu mais duas semanas."'

let memory: ReturnType<typeof studyLibrary>

async function meeting() {
  const library = useLibraryStore.getState()
  const media = await library.createFile({ name: 'Reunião de kickoff', type: 'audio', folderId: null, origin: { input: 'recording', name: 'kickoff.webm', mime: 'audio/webm', storage: 'none' } }, '')
  await library.updateSidecar(media.id, sidecar => ({ ...sidecar, recording: RECORDING, transcript: 'texto antigo' }))
  const ata = await library.createFile({ name: 'Ata: Reunião de kickoff', type: 'meeting', parentFileId: media.id, folderId: null }, ATA)
  const document = { id: 'doc-1', kind: 'ata', parts: [], markdown: ATA, images: [], createdAt: '2026-11-20T10:00:00.000Z', models: {} } as MeetingDocument
  await library.updateSidecar(ata.id, sidecar => ({ ...sidecar, documents: [document] }))
  const explanation = await library.createFile({ name: 'Explicação: prazo', type: 'explanation', parentFileId: ata.id, folderId: null }, 'Quem pediu prazo foi Falante 2.')
  const other = await library.createFile({ name: 'Outra reunião', type: 'meeting', folderId: null }, 'Falante 2 falou de outra coisa.')
  return { media: media.id, ata: ata.id, explanation: explanation.id, other: other.id }
}

beforeEach(() => {
  memory = studyLibrary()
})

describe('trocar o nome de quem fala vale em tudo', () => {
  it('na nota de mídia: a gravação, a transcrição e a marca de sugestão', async () => {
    const { media } = await meeting()
    await renameSpeakerEverywhere(media, 's2', 'Rafael')
    const sidecar = memory.sidecars.get(media)!
    expect(sidecar.recording?.speakers[1]).toEqual({ id: 's2', name: 'Rafael', suggested: false })
    expect(sidecar.transcript).toContain('Rafael [01:40]: O fornecedor pediu mais duas semanas.')
  })

  it('nas notas que nasceram dela, até as netas: o texto e o documento da Ata; citações ficam como estão', async () => {
    const { media, ata, explanation } = await meeting()
    await renameSpeakerEverywhere(media, 's2', 'Rafael')
    expect(memory.contents.get(ata)).toBe('# Ata\n\n- Rafael pediu mais duas semanas.\n- Marina confirmou março.\n\n> Falante 2: "O fornecedor pediu mais duas semanas."')
    expect(memory.sidecars.get(ata)?.documents?.[0].markdown).toBe(memory.contents.get(ata))
    expect(memory.contents.get(explanation)).toBe('Quem pediu prazo foi Rafael.')
  })

  it('não mexe em notas de outra mídia, nem em parte de outra palavra', async () => {
    const { media, other } = await meeting()
    await renameSpeakerEverywhere(media, 's1', 'Marina Souza')
    expect(memory.contents.get(other)).toBe('Falante 2 falou de outra coisa.')
    await renameSpeakerEverywhere(media, 's2', 'Rafael')
    expect(memory.contents.get(other)).toBe('Falante 2 falou de outra coisa.')
  })

  it('o mesmo nome de novo não regrava nada', async () => {
    const { media, ata } = await meeting()
    const before = memory.sidecars.get(ata)
    await renameSpeakerEverywhere(media, 's1', 'Marina')
    expect(memory.sidecars.get(ata)).toBe(before)
  })
})
