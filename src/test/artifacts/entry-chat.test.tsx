import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'

import type { FileMeta, FileSidecar, RecordingData, TutorArtifact } from '@/types/domain'
import { TutorDialog } from '@/components/dialogs/TutorDialog'
import { newFileMeta, newSidecar } from '@/lib/defaults'
import { CHUNK_CHARS } from '@/lib/generation/minutes'
import { chatInput, entryChatContext } from '@/lib/generation/entry-chat'
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

describe('o que o Chat da mídia lê', () => {
  const meta = (id: string, fields: Partial<FileMeta> = {}) => newFileMeta({ id, name: id, type: 'class', ...fields })
  const files = [
    meta('e', { name: 'Reunião de kickoff.mp4', role: 'entrada', type: 'reading' }),
    meta('ata', { name: 'Ata do kickoff', type: 'meeting', parentFileId: 'e' }),
    meta('exp', { name: 'Explicação: caminho crítico', type: 'explanation', parentFileId: 'ata' }),
    meta('lixo', { name: 'Nota apagada', parentFileId: 'e', deletedAt: '2026-11-01T10:00:00.000Z' }),
    meta('outra', { name: 'Outra reunião' }),
  ]
  const contents: Record<string, string> = { e: 'texto corrido', ata: '# Ata\n\nPrazo do portal: março.', exp: 'Caminho crítico é a sequência mais longa.', lixo: 'Não deve aparecer.', outra: 'De outra mídia.' }
  const sidecars: Record<string, FileSidecar> = Object.fromEntries(files.map(file => [file.id, newSidecar(file)]))
  sidecars.e = { ...sidecars.e, recording: RECORDING }
  const open = async (id: string) => ({ content: contents[id], sidecar: sidecars[id] })

  it('a transcrição da mídia e todas as notas que nasceram dela, até as netas; sem a Lixeira e sem outras mídias', async () => {
    const context = await entryChatContext(files, 'e', open)
    expect(context.original).toEqual({ label: 'Transcrição da mídia', text: 'Marina [00:12]: O prazo do portal novo é março.\nRafael [01:40]: O fornecedor pediu mais duas semanas.' })
    expect(context.notes).toEqual([
      { name: 'Ata do kickoff', text: '# Ata\n\nPrazo do portal: março.' },
      { name: 'Explicação: caminho crítico', text: 'Caminho crítico é a sequência mais longa.' },
    ])
  })

  it('entrada sem gravação (PDF, link, texto): lê o conteúdo dela', async () => {
    const context = await entryChatContext(files, 'e', async id => ({ content: contents[id], sidecar: id === 'e' ? newSidecar(files[0]) : sidecars[id] }))
    expect(context.original).toEqual({ label: 'Conteúdo da entrada', text: 'texto corrido' })
  })

  it('a IA recebe cada parte com o nome dela e a conversa', () => {
    const input = chatInput({ original: { label: 'Transcrição da mídia', text: 'Rafael [01:40]: O fornecedor pediu mais duas semanas.' }, notes: [{ name: 'Ata do kickoff', text: 'Prazo do portal: março.' }] }, [{ who: 'você', text: 'Quem pediu mais prazo?' }])
    expect(input).toContain('Transcrição da mídia:\nRafael [01:40]: O fornecedor pediu mais duas semanas.')
    expect(input).toContain('Nota "Ata do kickoff":\nPrazo do portal: março.')
    expect(input).toContain('Pessoa: Quem pediu mais prazo?')
  })

  it('transcrição longa: vão as falas sobre a pergunta, não só o começo', () => {
    const filler = Array.from({ length: 12 }, (_, index) => `Marina [${index}:00]: ${'falando de outra coisa '.repeat(CHUNK_CHARS / 90)}`).join('\n')
    const text = `${filler}\nRafael [13:00]: O fornecedor pediu mais duas semanas.`
    const input = chatInput({ original: { label: 'Transcrição da mídia', text }, notes: [] }, [{ who: 'você', text: 'O que o fornecedor pediu?' }])
    expect(input).toContain('Rafael [13:00]: O fornecedor pediu mais duas semanas.')
    expect(input.length).toBeLessThan(text.length)
  })
})

const inputs: string[] = []

beforeEach(() => {
  inputs.length = 0
  installFetch((request: CapturedRequest) => {
    inputs.push(userContentOf(request))
    return openAiStream('Foi o Rafael, em [01:40].')
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('janela do Chat', () => {
  it('chama "Chat", sem os modos do tutor; pergunta com a transcrição e as notas, e guarda a conversa na entrada', async () => {
    const memory = studyLibrary()
    const library = useLibraryStore.getState()
    const entry = await library.createFile({ name: 'Reunião de kickoff.mp4', type: 'reading', role: 'entrada', folderId: null }, 'texto corrido')
    await library.updateSidecar(entry.id, sidecar => ({ ...sidecar, recording: RECORDING }))
    await library.createFile({ name: 'Ata do kickoff', type: 'meeting', parentFileId: entry.id, folderId: null }, '# Ata\n\nPrazo do portal: março.')
    render(<TutorDialog fileId={entry.id} chat />)
    expect(screen.getByRole('dialog', { name: 'Chat: Reunião de kickoff.mp4' })).toBeInTheDocument()
    expect(screen.queryByRole('group', { name: 'Modo do tutor' })).not.toBeInTheDocument()
    fireEvent.change(screen.getByRole('textbox', { name: 'Sua pergunta ou resposta' }), { target: { value: 'Quem pediu mais prazo?' } })
    fireEvent.click(screen.getByRole('button', { name: 'Enviar' }))
    await waitFor(() => expect(inputs).toHaveLength(1))
    expect(inputs[0]).toContain('Rafael [01:40]: O fornecedor pediu mais duas semanas.')
    expect(inputs[0]).toContain('Nota "Ata do kickoff":')
    expect(await within(screen.getByRole('list', { name: 'Conversa do chat' })).findByText('Chat')).toBeInTheDocument()
    await waitFor(() => expect((memory.sidecars.get(entry.id)?.artifacts ?? []).filter((item): item is TutorArtifact => item.kind === 'tutor')[0]?.turns).toHaveLength(2))
  })
})
