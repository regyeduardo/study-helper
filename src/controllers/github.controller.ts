import { withAlerts, withTaskLists } from '@/lib/github/alerts'
import { KeyValueStore } from '@/lib/storage/idb'

const GITHUB_API = 'https://api.github.com'
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

export async function renderMarkdownController(markdown: string, token: string): Promise<string> {
  const key = await digest(markdown)
  const remembered = memory.get(key) ?? (await cache.get<string>('cache', key).catch(() => undefined))
  if (remembered) {
    memory.set(key, remembered)
    return remembered
  }

  const headers: Record<string, string> = { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'Content-Type': 'application/json' }
  if (token) headers.Authorization = `Bearer ${token}`
  let response: Response
  try {
    response = await fetch(`${GITHUB_API}/markdown`, { method: 'POST', headers, body: JSON.stringify({ text: markdown, mode: 'markdown' }) })
  } catch {
    throw new RenderError('Não consegui falar com o GitHub para desenhar o documento.')
  }
  if ((response.status === 403 || response.status === 429) && !token) {
    throw new RenderError('O GitHub recusou por limite de uso (60 por hora sem token). Ponha um token do GitHub nas Configurações.')
  }
  if (!response.ok) throw new RenderError(`O GitHub recusou o documento (${response.status}).`)
  const html = withTaskLists(withAlerts(await response.text()))
  memory.set(key, html)
  await cache.put('cache', key, html).catch(() => undefined)
  return html
}
