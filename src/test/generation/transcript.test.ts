import { describe, expect, it, vi } from 'vitest'

import { newFileMeta, newSidecar } from '@/lib/defaults'
import { transcriptFileName, transcriptOf } from '@/lib/generation/transcript'
import type { Repository } from '@/lib/storage/repository'

function repoWith(transcript: string | undefined, content: string): Repository {
  return {
    readSidecar: vi.fn(async (id: string) => ({ ...newSidecar(newFileMeta({ name: 'x', type: 'meeting' })), meta: { ...newFileMeta({ name: 'x', type: 'meeting' }), id }, transcript })),
    readContent: vi.fn(async () => content),
  } as unknown as Repository
}

describe('transcription to download', () => {
  it('uses the transcription kept next to the note', async () => {
    const meta = newFileMeta({ name: 'Reunião', type: 'meeting' })
    expect(await transcriptOf(meta, repoWith('Falante 1: oi', '# Ata'))).toBe('Falante 1: oi')
  })

  it('uses the text of an older transcription-only note made from a recording', async () => {
    const meta = { ...newFileMeta({ name: 'Aula gravada', type: 'reading' }), origin: { input: 'recording' as const, name: 'aula.webm', mime: 'audio/webm', storage: 'none' as const } }
    expect(await transcriptOf(meta, repoWith(undefined, 'Falante 1: bom dia'))).toBe('Falante 1: bom dia')
  })

  it('has nothing for notes that did not come from audio', async () => {
    const pasted = { ...newFileMeta({ name: 'Texto', type: 'reading' }), origin: { input: 'text' as const, name: 'texto colado', storage: 'none' as const } }
    expect(await transcriptOf(pasted, repoWith(undefined, 'qualquer coisa'))).toBeNull()
    expect(await transcriptOf(newFileMeta({ name: 'Aula', type: 'class' }), repoWith(undefined, '# Aula'))).toBeNull()
  })

  it('names the file after the note, without characters a file name cannot have', () => {
    expect(transcriptFileName('Reunião 28/09: time')).toBe('Reunião 28-09- time - transcrição.txt')
  })
})
