const FRONTMATTER = /^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/

export function parseFrontmatter(content: string): { meta: Record<string, string>; body: string } {
  const match = FRONTMATTER.exec(content)
  if (!match) return { meta: {}, body: content }
  const meta: Record<string, string> = {}
  for (const line of match[1].split('\n')) {
    const separator = line.indexOf(':')
    if (separator > 0) meta[line.slice(0, separator).trim()] = line.slice(separator + 1).trim()
  }
  return { meta, body: match[2].trim() }
}

export function addFrontmatter(content: string, fileType?: string | null): string {
  return fileType ? `---\ntype: ${fileType}\n---\n\n${content}` : content
}
