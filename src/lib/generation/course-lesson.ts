import type { FileMeta, FolderMeta } from '@/types/domain'

const OUTLINE_LINES = 80

export function courseOf(folders: FolderMeta[], folderId: string | null): FolderMeta | null {
  const byId = new Map(folders.map(folder => [folder.id, folder]))
  const seen = new Set<string>()
  let current = folderId
  while (current && !seen.has(current)) {
    seen.add(current)
    const folder = byId.get(current)
    if (!folder) return null
    if (folder.isCourse) return folder
    current = folder.parentId
  }
  return null
}

function outline(folders: FolderMeta[], files: FileMeta[], courseId: string): string {
  const lines: string[] = []
  const walk = (folderId: string, depth: number) => {
    for (const file of files.filter(item => item.folderId === folderId && !item.deletedAt).sort((a, b) => a.position - b.position)) lines.push(`${'  '.repeat(depth)}- ${file.name}`)
    for (const folder of folders.filter(item => item.parentId === folderId && !item.deletedAt).sort((a, b) => a.position - b.position)) {
      lines.push(`${'  '.repeat(depth)}- ${folder.name}`)
      walk(folder.id, depth + 1)
    }
  }
  walk(courseId, 0)
  return lines.slice(0, OUTLINE_LINES).join('\n')
}

export function courseLessonInput(file: FileMeta, folders: FolderMeta[], files: FileMeta[]): string {
  const course = courseOf(folders, file.folderId)
  const excerpt = file.pendingExcerpt || course?.courseMaterial || ''
  const parts = [`# ${file.name}`]
  if (file.description) parts.push(`Esta aula precisa cobrir: ${file.description}`)
  if (course) {
    parts.push(`## Onde esta aula se encaixa\nCurso: ${course.name}`)
    if (course.courseDescription) parts.push(course.courseDescription)
    const structure = outline(folders, files, course.id)
    if (structure) parts.push(`Estrutura do curso:\n${structure}`)
    parts.push('Escreva SÓ esta aula. Não repita o que pertence às outras aulas da lista acima.')
  }
  parts.push(`## Material desta aula\n${excerpt}`)
  return parts.join('\n\n')
}

export function lineageOf(file: FileMeta, files: FileMeta[]): FileMeta[] {
  const byId = new Map(files.map(item => [item.id, item]))
  const chain: FileMeta[] = []
  const seen = new Set<string>([file.id])
  let current = file.parentFileId ? byId.get(file.parentFileId) : undefined
  while (current && !seen.has(current.id)) {
    seen.add(current.id)
    chain.push(current)
    current = current.parentFileId ? byId.get(current.parentFileId) : undefined
  }
  return chain
}

const LINEAGE_CONTEXT_CHARS = 1200

export function selectionInput(file: FileMeta, content: string, files: FileMeta[], excerpt: string, userPrompt: string, mode: 'concept' | 'context'): string {
  if (mode === 'concept') {
    const instruction = userPrompt.trim() || 'Explique o conceito por trás deste trecho, sem prender ao documento de origem.'
    return `Trecho selecionado:\n\n${excerpt}\n\nInstrução:\n\n${instruction}`
  }
  if (userPrompt.trim()) return `Trecho selecionado:\n\n${excerpt}\n\nInstrução:\n\n${userPrompt.trim()}`
  const origin = [`Documento de origem: ${file.name}`, ...lineageOf(file, files).map(step => `Veio de: ${step.name}`)]
  return `${origin.join('\n')}\n\nContexto do documento:\n\n${content.slice(0, LINEAGE_CONTEXT_CHARS)}\n\nExplique o trecho abaixo, considerando de onde ele veio:\n\n${excerpt}`
}

export function selectionTitle(excerpt: string): string {
  const condensed = excerpt.split(/\s+/).filter(Boolean).join(' ')
  return condensed.length <= 60 ? condensed : `${condensed.slice(0, 57)}...`
}

export function explanationName(markdown: string, excerpt: string): string {
  for (const line of markdown.split('\n')) {
    const stripped = line.trim()
    if (stripped.startsWith('#')) {
      const title = stripped.replace(/^#+/, '').trim()
      if (title) return title
    }
  }
  return excerpt.split(/\s+/).filter(Boolean).join(' ').slice(0, 60) || 'Explicação'
}
