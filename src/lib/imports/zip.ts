import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate'

import { addFrontmatter, parseFrontmatter } from '@/lib/imports/frontmatter'

export interface ImportedDocument {
  markdown: string
  questions?: unknown
  type?: string
}

export function readZip(bytes: ArrayBuffer): ImportedDocument {
  const entries = unzipSync(new Uint8Array(bytes))
  let markdown = ''
  let questions: unknown
  let type: string | undefined
  for (const [name, data] of Object.entries(entries)) {
    if (name.endsWith('/') || name.startsWith('__MACOSX/') || name.startsWith('.')) continue
    const content = strFromU8(data)
    if (name.endsWith('.md')) {
      const parsed = parseFrontmatter(content)
      markdown = parsed.body
      type = parsed.meta.type || type
    } else if (name.endsWith('.json')) {
      try {
        questions = JSON.parse(content)
      } catch {
        continue
      }
    }
  }
  if (!markdown) throw new Error('Nenhum arquivo .md encontrado no ZIP.')
  return { markdown, questions, type }
}

export function buildZip(markdown: string, questions: unknown, filename: string, type?: string | null): Blob {
  const files: Record<string, Uint8Array> = { [`${filename}.md`]: strToU8(addFrontmatter(markdown, type)) }
  if (questions && (!Array.isArray(questions) || questions.length)) files[`${filename}-questions.json`] = strToU8(JSON.stringify(questions, null, 2))
  return new Blob([zipSync(files)], { type: 'application/zip' })
}
