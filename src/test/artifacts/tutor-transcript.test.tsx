import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'

import type { FileMeta, FileSidecar, RecordingData } from '@/types/domain'
import { TutorDialog } from '@/components/dialogs/TutorDialog'
import { newFileMeta, newSidecar } from '@/lib/defaults'
import { CHUNK_CHARS } from '@/lib/generation/minutes'
import { transcriptAbove, tutorInput } from '@/lib/generation/tutor'
import { useLibraryStore } from '@/stores/library'
import { type CapturedRequest, installFetch, openAiStream, userContentOf } from '@/test/ai/fake-provider'
import { studyLibrary } from '@/test/generation/study-fixture'

const RECORDING: RecordingData = {
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

describe('o que o tutor lê da transcrição', () => {
  it('a transcrição vai junto da nota, como contexto', () => {
    const input = tutorInput('# Ata\n\nPrazo: março.', 'perguntar', [{ who: 'você', text: 'Quem pediu mais prazo?' }], 'Rafael [01:40]: O fornecedor pediu mais duas semanas.\n')
    expect(input).toContain('Nota:\n# Ata')
    expect(input).toContain('Transcrição da gravação')
    expect(input).toContain('Rafael [01:40]: O fornecedor pediu mais duas semanas.')
  })

  it('sem transcrição, nada muda', () => {
    expect(tutorInput('# Ata', 'perguntar', [])).not.toContain('Transcrição')
  })

  it('transcrição longa: vão as falas sobre a pergunta, não só o começo', () => {
    const filler = Array.from({ length: 12 }, (_, index) => `Marina [${index}:00]: ${'falando de outra coisa '.repeat(CHUNK_CHARS / 90)}`).join('\n')
    const transcript = `${filler}\nRafael [13:00]: O fornecedor pediu mais duas semanas.\n`
    const input = tutorInput('# Ata', 'perguntar', [{ who: 'você', text: 'O que o fornecedor pediu?' }], transcript)
    expect(input).toContain('Rafael [13:00]: O fornecedor pediu mais duas semanas.')
    expect(input.length).toBeLessThan(transcript.length)
  })
})

describe('de onde vem a transcrição', () => {
  const meta = (id: string, fields: Partial<FileMeta> = {}) => newFileMeta({ id, name: id, type: 'class', ...fields })
  const files = [meta('e', { role: 'entrada', type: 'reading' }), meta('ata', { type: 'meeting', parentFileId: 'e' }), meta('exp', { type: 'explanation', parentFileId: 'ata' }), meta('solta')]
  const sidecars: Record<string, FileSidecar> = {
    e: { ...newSidecar(files[0]), recording: RECORDING },
    ata: newSidecar(files[1]),
    exp: newSidecar(files[2]),
    solta: newSidecar(files[3]),
  }
  const open = async (id: string) => ({ sidecar: sidecars[id] })

  it('a nota nascida da gravação lê a transcrição dela', async () => {
    expect(await transcriptAbove(files, 'ata', open)).toContain('Rafael [01:40]: O fornecedor pediu mais duas semanas.')
  })

  it('a nota nascida de outra nota sobe até a gravação', async () => {
    expect(await transcriptAbove(files, 'exp', open)).toContain('Marina [00:12]: O prazo do portal novo é março.')
  })

  it('transcrição só em texto também vale', async () => {
    const only: Record<string, FileSidecar> = { ...sidecars, e: { ...newSidecar(files[0]), transcript: 'No seminário a turma resolveu o exercício 3.' } }
    expect(await transcriptAbove(files, 'ata', async id => ({ sidecar: only[id] }))).toBe('No seminário a turma resolveu o exercício 3.')
  })

  it('nota sem gravação acima: nada', async () => {
    expect(await transcriptAbove(files, 'solta', open)).toBe('')
  })

  it('a própria gravação não manda a transcrição duas vezes', async () => {
    expect(await transcriptAbove(files, 'e', open)).toBe('')
  })
})

const inputs: string[] = []

beforeEach(() => {
  inputs.length = 0
  installFetch((request: CapturedRequest) => {
    inputs.push(userContentOf(request))
    return openAiStream('Foi o fornecedor.')
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('Tutor de uma nota nascida de gravação', () => {
  it('pergunta com a nota e a transcrição da gravação', async () => {
    studyLibrary()
    const library = useLibraryStore.getState()
    const entry = await library.createFile({ name: 'Reunião de kickoff.mp4', type: 'reading', role: 'entrada', folderId: null }, 'Marina: o prazo do portal novo é março.')
    await library.updateSidecar(entry.id, sidecar => ({ ...sidecar, recording: RECORDING }))
    const ata = await library.createFile({ name: 'Ata do kickoff', type: 'meeting', parentFileId: entry.id, folderId: null }, '# Ata\n\nPrazo do portal: março.')
    render(<TutorDialog fileId={ata.id} />)
    fireEvent.change(screen.getByRole('textbox', { name: 'Sua pergunta ou resposta' }), { target: { value: 'Quem pediu mais prazo?' } })
    fireEvent.click(screen.getByRole('button', { name: 'Enviar' }))
    await waitFor(() => expect(inputs).toHaveLength(1))
    expect(inputs[0]).toContain('Prazo do portal: março.')
    expect(inputs[0]).toContain('Rafael [01:40]: O fornecedor pediu mais duas semanas.')
  })
})
