import { docxText } from '@/lib/imports/docx'
import { parseFrontmatter } from '@/lib/imports/frontmatter'
import { pdfText } from '@/lib/imports/pdf'
import { type ImportedDocument, readZip } from '@/lib/imports/zip'
import { extensionOf } from '@/lib/generation/uploads'

export async function importDocument(file: File): Promise<ImportedDocument> {
  const extension = extensionOf(file.name)
  const bytes = await file.arrayBuffer()
  if (extension === 'md') {
    const { meta, body } = parseFrontmatter(new TextDecoder().decode(bytes))
    return { markdown: body, type: meta.type }
  }
  if (extension === 'zip') return readZip(bytes)
  if (extension === 'pdf') return { markdown: await pdfText(bytes) }
  if (extension === 'docx') return { markdown: await docxText(bytes) }
  throw new Error(`Formato não suportado: ${extension}. Aceitos: .md, .zip, .pdf e .docx.`)
}
