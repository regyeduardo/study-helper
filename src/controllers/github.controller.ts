import { withAlerts, withTaskLists } from '@/lib/github/alerts'
import { renderMarkdown } from '@/lib/github/render'
import { KeyValueStore } from '@/lib/storage/idb'

const cache = new KeyValueStore('study-helper-render-cache')
const memory = new Map<string, string>()

export class RenderError extends Error {}

function plainDigest(text: string): string {
  let first = 0x811c9dc5
  let second = 0x01000193
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index)
    first = Math.imul(first ^ code, 0x01000193)
    second = Math.imul(second ^ code, 0x5bd1e995)
  }
  return `${(first >>> 0).toString(16)}${(second >>> 0).toString(16)}-${text.length}`
}

async function digest(markdown: string): Promise<string> {
  if (!crypto.subtle) return plainDigest(markdown)
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(markdown))
  return [...new Uint8Array(bytes)].map(byte => byte.toString(16).padStart(2, '0')).join('')
}

export async function renderMarkdownController(markdown: string): Promise<string> {
  const key = `local-${await digest(markdown)}`
  const remembered = memory.get(key) ?? (await cache.get<string>('cache', key).catch(() => undefined))
  if (remembered) {
    memory.set(key, remembered)
    return remembered
  }

  let html: string
  try {
    html = withTaskLists(withAlerts(await renderMarkdown(markdown)))
  } catch {
    throw new RenderError('Não consegui desenhar o documento.')
  }
  memory.set(key, html)
  await cache.put('cache', key, html).catch(() => undefined)
  return html
}
