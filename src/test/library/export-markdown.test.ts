import { beforeEach, describe, expect, it, vi } from 'vitest'

import { defaultIndex, newFileMeta, newSidecar } from '@/lib/defaults'
import { exportFileAsMarkdown } from '@/lib/exports/library-export'
import { useLibraryStore } from '@/stores/library'
import { installBlobShim } from '@/test/imports/blob-shim'
import type { FileMeta, MeetingDocument } from '@/types/domain'
import { downloadBlob } from '@/utils/download'

vi.mock('@/utils/download', async importOriginal => ({ ...(await importOriginal<typeof import('@/utils/download')>()), downloadBlob: vi.fn() }))

installBlobShim()

const TRANSCRIPT = 'Natália Lenza [00:34]: Pode ir, né?\nRegy Niles [00:35]: Pode.'

const ata: MeetingDocument = {
  id: 'ata-1',
  kind: 'ata',
  parts: ['resumo', 'tarefas'],
  markdown: '# Curva de vendas\n\n## Tarefas\n\n- Regy: arrumar o campo [▸ 02:09](#t=129)\n\n![Tela da curva](imagens/print-1.png)\n',
  images: [{ name: 'print-1.png', dataUrl: 'data:image/png;base64,AAAA' }],
  createdAt: '2026-10-29T13:00:00.000Z',
  models: {},
}

function openNote(documents?: MeetingDocument[]): FileMeta {
  const meta = newFileMeta({ name: 'Curva de vendas e regras de datas', type: 'reading' })
  useLibraryStore.setState({ files: [meta], index: defaultIndex(), opened: { [meta.id]: { content: TRANSCRIPT, sidecar: { ...newSidecar(meta), ...(documents ? { documents } : {}) } } } })
  return meta
}

async function exported(id: string): Promise<{ text: string; name: string }> {
  await exportFileAsMarkdown(id)
  const [blob, name] = vi.mocked(downloadBlob).mock.calls.at(-1)!
  return { text: await (blob as Blob).text(), name }
}

beforeEach(() => vi.mocked(downloadBlob).mockClear())

describe('Exportar .md', () => {
  it('a note with an Ata takes the Ata, with its prints, and then the transcription', async () => {
    const { text, name } = await exported(openNote([ata]).id)
    expect(name).toBe('Curva de vendas e regras de datas.md')
    expect(text).toContain('## Tarefas\n\n- Regy: arrumar o campo')
    expect(text).toContain('![Tela da curva](data:image/png;base64,AAAA)')
    expect(text).toContain(`# Transcrição\n\n${TRANSCRIPT}`)
    expect(text.indexOf('## Tarefas')).toBeLessThan(text.indexOf('# Transcrição'))
  })

  it('a note without an Ata stays as it was', async () => {
    const { text } = await exported(openNote().id)
    expect(text).toBe(`---\ntype: reading\n---\n\n${TRANSCRIPT}`)
  })
})
