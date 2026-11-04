import { strToU8, zipSync } from 'fflate'

import { printMarkdownAsPdf } from '@/lib/exports/pdf'
import { withImages } from '@/lib/generation/ata'
import { addFrontmatter } from '@/lib/imports/frontmatter'
import { buildZip } from '@/lib/imports/zip'
import { useLibraryStore } from '@/stores/library'
import { downloadBlob, safeFilename } from '@/utils/download'

export async function exportFileAsMarkdown(id: string): Promise<void> {
  const library = useLibraryStore.getState()
  const meta = library.files.find(file => file.id === id)
  if (!meta) return
  const { content, sidecar } = await library.openFile(id)
  const ata = sidecar.documents?.filter(item => item.kind === 'ata').at(-1)
  // The Ata note made from the recording is the Ata itself; an old note keeps its Ata above the transcription.
  const body = !ata ? content : meta.parentFileId ? withImages(content, ata.images) : `${withImages(ata.markdown, ata.images).trim()}\n\n---\n\n# Transcrição\n\n${content}`
  downloadBlob(new Blob([addFrontmatter(body, meta.type)], { type: 'text/markdown' }), `${safeFilename(meta.name)}.md`)
}

/** The Ata note's prints live in its document: the paper gets them inline. */
export async function exportFileAsPdf(id: string): Promise<void> {
  const library = useLibraryStore.getState()
  const meta = library.files.find(file => file.id === id)
  if (!meta) return
  const { content, sidecar } = await library.openFile(id)
  const ata = sidecar.documents?.filter(item => item.kind === 'ata').at(-1)
  await printMarkdownAsPdf(ata && meta.parentFileId ? withImages(content, ata.images) : content, meta.name)
}

export async function exportFileAsZip(id: string): Promise<void> {
  const library = useLibraryStore.getState()
  const meta = library.files.find(file => file.id === id)
  if (!meta) return
  const { content, sidecar } = await library.openFile(id)
  downloadBlob(buildZip(content, sidecar.questions, safeFilename(meta.name), meta.type), `${safeFilename(meta.name)}.zip`)
}

export async function exportFilesAsZip(ids: string[]): Promise<void> {
  const library = useLibraryStore.getState()
  const entries: Record<string, Uint8Array> = {}
  for (const id of ids) {
    const meta = library.files.find(file => file.id === id)
    if (!meta) continue
    const { content, sidecar } = await library.openFile(id)
    const base = safeFilename(meta.name)
    let name = base
    for (let copy = 2; entries[`${name}.md`]; copy++) name = `${base} (${copy})`
    entries[`${name}.md`] = strToU8(addFrontmatter(content, meta.type))
    if (sidecar.questions.length) entries[`${name}-questions.json`] = strToU8(JSON.stringify(sidecar.questions, null, 2))
  }
  downloadBlob(new Blob([zipSync(entries)], { type: 'application/zip' }), ids.length === 1 ? `${Object.keys(entries)[0]?.replace(/\.md$/, '') ?? 'conteudo'}.zip` : 'estudo.zip')
}
