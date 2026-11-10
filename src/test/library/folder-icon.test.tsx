import { readFileSync } from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'

import type { FolderColor } from '@/types/domain'
import { FolderIcon } from '@/components/ui/FolderIcon'

const SPOKEN: Record<FolderColor, string> = { vermelho: 'Pasta vermelha', laranja: 'Pasta laranja', amarelo: 'Pasta amarela', verde: 'Pasta verde', azul: 'Pasta azul', roxo: 'Pasta roxa', cinza: 'Pasta cinza' }
const COLORS = Object.keys(SPOKEN) as FolderColor[]

const css = readFileSync(path.resolve(__dirname, '../../styles/app.css'), 'utf8')
const block = (selector: string) => css.slice(css.indexOf(selector)).slice(0, css.slice(css.indexOf(selector)).indexOf('}'))
const tokenOf = (color: FolderColor) => new RegExp(`--folder-${color}:([^;]+);`).exec(block(':root{'))?.[1].trim()

describe('FolderIcon', () => {
  it.each(COLORS)('a pasta %s tem a cor do tema e diz o nome da cor', color => {
    render(<FolderIcon color={color} />)
    const icon = screen.getByRole('img', { name: SPOKEN[color] })
    expect(icon).toHaveAttribute('title', SPOKEN[color])
    expect(icon.style.color).toBe(`var(--folder-${color})`)
  })

  it('sem cor, é o ícone de hoje, só decorativo', () => {
    const { container } = render(<FolderIcon />)
    expect(screen.queryByRole('img')).toBeNull()
    expect(container.querySelector('svg')).toHaveAttribute('aria-hidden', 'true')
  })
})

describe('tokens das cores de pasta', () => {
  it('o laranja #f0883e é a única cor nova; as outras são tons do tema, que mudam no escuro', () => {
    expect(tokenOf('laranja')).toBe('#f0883e')
    for (const color of COLORS.filter(item => item !== 'laranja')) {
      const tone = /^var\((--[\w-]+)\)$/.exec(tokenOf(color) ?? '')?.[1]
      expect(tone, color).toBeTruthy()
      expect(block('@media (prefers-color-scheme: dark)'), color).toContain(`${tone}:`)
      expect(block(':root[data-theme="dark"]'), color).toContain(`${tone}:`)
    }
  })
})
