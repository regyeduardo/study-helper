// --- localStorage helpers ---

export function getStorageItem<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key)
    if (raw === null) return fallback
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}

export function setStorageItem<T>(key: string, value: T): void {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch {
    // localStorage may be full or unavailable
  }
}

export function removeStorageItem(key: string): void {
  try {
    localStorage.removeItem(key)
  } catch {
    // ignore
  }
}

// ---

export function forcePaint(): Promise<void> {
  void document.body.offsetHeight
  return new Promise<void>((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
  )
}

export function getTitleFromMarkdown(markdown: string): string | null {
  if (!markdown) return null
  const match = markdown.match(/^#\s+(.*?)(?:\n|$)/m)
  if (!match) return null
  let title = match[1].trim()
  title = title.replace(/^[^\w\s]{1,3}\s*/, '')
  title = title.replace(/^(Aula|Resumo|Documento)[:\s]*/i, '')
  title = title.trim()
  if (!title) return null
  title = title
    .replace(/[<>:"/\\|?*]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase()
    .slice(0, 80)
  return title || null
}

export function getRawTitleFromMarkdown(markdown: string): string | null {
  if (!markdown) return null
  const match = markdown.match(/^#\s+(.*?)(?:\n|$)/m)
  if (!match) return null
  const title = match[1].trim()
  return title || null
}

export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}

// Fisher-Yates shuffle (uniform, unbiased)
export function shuffleArray<T>(arr: T[]): T[] {
  const shuffled = [...arr]
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]]
  }
  return shuffled
}

// ---

/**
 * Escape HTML special characters (&, <, >, ") using the browser DOM.
 */
export function escapeHtml(text: string): string {
  const div = document.createElement('div')
  div.appendChild(document.createTextNode(text))
  return div.innerHTML
}
