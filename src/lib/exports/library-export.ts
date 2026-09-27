import { strToU8, zipSync } from 'fflate'

import { addFrontmatter } from '@/lib/imports/frontmatter'
import { buildZip } from '@/lib/imports/zip'
import { useLibraryStore } from '@/stores/library'
import { downloadBlob, safeFilename } from '@/utils/download'

export async function exportFileAsMarkdown(id: string): Promise<void> {
  const library = useLibraryStore.getState()
  const meta = library.files.find(file => file.id === id)
  if (!meta) return
  const { content } = await library.openFile(id)
  downloadBlob(new Blob([addFrontmatter(content, meta.type)], { type: 'text/markdown' }), `${safeFilename(meta.name)}.md`)
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
