// O texto sobre a cor de destaque (botão principal, contador, caixa marcada) passa no AA (4,5:1) no claro e no escuro, nos 4 visuais.
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const css = readFileSync(path.resolve(__dirname, '../../styles/app.css'), 'utf8')

/** The tokens of a block: `--name:value;` pairs. */
function tokens(block: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const match of block.matchAll(/--([\w-]+):\s*([^;]+);/g)) out[match[1]] = match[2].trim()
  return out
}

const light = tokens(css.slice(css.indexOf(':root{'), css.indexOf('}', css.indexOf(':root{'))))
const darkStart = css.indexOf(':root[data-theme="dark"]{')
const dark = { ...light, ...tokens(css.slice(darkStart, css.indexOf('}', darkStart))) }

function luminance(hex: string): number {
  const value = hex.replace('#', '')
  const [r, g, b] = [0, 2, 4].map(at => parseInt(value.slice(at, at + 2), 16) / 255).map(c => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4))
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (hi + 0.05) / (lo + 0.05)
}

/** A token's color, following `var(--x)`. */
function color(theme: Record<string, string>, name: string): string {
  let value = theme[name]
  while (value?.startsWith('var(')) value = theme[value.slice(6, -1)]
  return value
}

describe('Texto sobre a cor de destaque', () => {
  for (const [name, theme] of [
    ['claro', light],
    ['escuro', dark],
  ] as const) {
    for (const accent of ['acc1', 'acc2', 'acc3', 'acc4']) {
      it(`${name}, ${accent}: pelo menos 4,5:1`, () => {
        expect(contrast(color(theme, 'on-accent'), color(theme, accent))).toBeGreaterThanOrEqual(4.5)
      })
    }
  }

  it('o botão principal e os outros preenchidos usam a cor de texto do tema, não branco fixo', () => {
    expect(css).toMatch(/\.btn\.primary\{[^}]*color:var\(--on-accent\)/)
    expect(css).toMatch(/\.check\.on\{[^}]*color:var\(--on-accent\)/)
  })
})
