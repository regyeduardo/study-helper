import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

const ROOT = join(__dirname, '..', '..', '..')
const STYLES = join(ROOT, 'src', 'styles')
const sheets = readdirSync(STYLES)
  .filter(name => name.endsWith('.css'))
  .map(name => ({ name, text: readFileSync(join(STYLES, name), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '') }))

const phone = sheets.find(sheet => sheet.name === 'phone.css')!.text

/** The text of the `@media <query> { ... }` block: braces counted, so nested rules stay inside. */
function mediaBlock(css: string, query: RegExp): string {
  const start = css.search(query)
  if (start < 0) return ''
  const open = css.indexOf('{', start)
  let depth = 0
  for (let at = open; at < css.length; at++) {
    if (css[at] === '{') depth++
    if (css[at] === '}' && --depth === 0) return css.slice(open + 1, at)
  }
  return ''
}

describe('the page on a phone', () => {
  it('goes edge to edge, so env(safe-area-inset-*) means something', () => {
    const html = readFileSync(join(ROOT, 'index.html'), 'utf8')
    expect(html).toMatch(/<meta name="viewport"[^>]*viewport-fit=cover/)
    expect(phone).toMatch(/\.app-root\s*{[^}]*env\(safe-area-inset-top\)[^}]*env\(safe-area-inset-bottom\)/)
  })

  it('loads phone.css after app.css, so it wins on equal weight', () => {
    const main = readFileSync(join(ROOT, 'src', 'main.tsx'), 'utf8')
    expect(main.indexOf("'@/styles/phone.css'")).toBeGreaterThan(main.indexOf("'@/styles/app.css'"))
  })

  it('never lets Safari zoom into a field: 16px for every field under a finger', () => {
    const touch = mediaBlock(phone, /@media \(pointer: coarse\)/)
    expect(touch).toMatch(/select,\s*textarea\s*{\s*font-size:\s*16px\s*!important/)
    expect(touch).toMatch(/input:not\(/)
  })

  it('keeps the small controls at 36px or more, or gives them a hit area that is', () => {
    const touch = mediaBlock(phone, /@media \(pointer: coarse\)/)
    expect(touch).toMatch(/\.btn\s*{\s*min-height:\s*36px/)
    expect(touch).toMatch(/\.ibtn\s*{\s*min-width:\s*36px;\s*min-height:\s*36px/)
    expect(touch).toMatch(/\.tr-add::after[\s\S]*?inset:\s*-8px/)
    expect(touch).toMatch(/\.mplayer-bar\s*{\s*height:\s*36px/)
  })
})

describe('the height of the screen on iOS', () => {
  // 100vh is the page with Safari's bars hidden: a window sized with it ends below the visible area. dvh is what is visible.
  it('every vh height has a dvh twin in the same rule', () => {
    const lonely: string[] = []
    for (const sheet of sheets) {
      for (const [, body] of sheet.text.matchAll(/{([^{}]*)}/g)) {
        const declarations = body.split(';').map(item => item.trim()).filter(Boolean)
        const [vh, dvh] = [new Map<string, number>(), new Set<string>()]
        declarations.forEach((declaration, index) => {
          const [property, ...rest] = declaration.split(':')
          const value = rest.join(':')
          if (/\d(?:vh)\b/.test(value)) vh.set(property.trim(), index)
          if (/\ddvh\b/.test(value)) dvh.add(`${property.trim()}@${index}`)
        })
        for (const [property, index] of vh) {
          const twin = [...dvh].some(entry => entry.startsWith(`${property}@`) && Number(entry.split('@')[1]) > index)
          if (!twin) lonely.push(`${sheet.name}: ${body.trim().slice(0, 90)}`)
        }
      }
    }
    expect(lonely).toEqual([])
  })

  it('the windows follow the area above the keyboard', () => {
    const narrow = mediaBlock(phone, /@media \(max-width: 760px\)/)
    expect(narrow).toMatch(/\.dialog\s*{\s*max-height:\s*calc\(var\(--vvh, 100dvh\)/)
    expect(narrow).toMatch(/\.dialog\.settings\s*{\s*height:\s*calc\(var\(--vvh, 100dvh\)/)
  })
})

describe('what only appears under the mouse', () => {
  // A finger has no hover: whatever starts hidden must be shown, or dropped, when there is none.
  const HIDDEN_UNTIL_HOVER: [string, string][] = [
    ['app.css', '.tr-add'],
    ['explorer.css', '.ex-grip'],
    ['filter-panel.css', '.fp-only'],
  ]

  it.each(HIDDEN_UNTIL_HOVER)('%s: %s is shown, or gone, when there is no hover', (file, selector) => {
    const text = sheets.find(sheet => sheet.name === file)!.text
    const noHover = mediaBlock(text, /@media \(hover:\s*none\)/)
    expect(noHover.includes(selector)).toBe(true)
  })

  it('the row actions of the library are hidden only where there is a mouse', () => {
    const text = sheets.find(sheet => sheet.name === 'explorer.css')!.text
    expect(mediaBlock(text, /@media \(hover:\s*hover\)/)).toContain('.ex-act .ibtn:not(.on){opacity:0}')
  })
})
