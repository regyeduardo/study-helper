import { afterEach, describe, expect, it, vi } from 'vitest'

import { copyButtons } from '@/lib/github/chrome'
import { renderMarkdown } from '@/lib/github/render'

afterEach(() => {
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
})

/** The note as the reader paints it, with the copy button of each block, and the text each button copies when clicked. */
async function copiedFrom(markdown: string): Promise<{ blocks: string[]; copied: string[]; article: HTMLElement }> {
  const article = document.createElement('article')
  article.innerHTML = await renderMarkdown(markdown)
  document.body.appendChild(article)
  copyButtons(article)
  const writeText = vi.fn(async () => undefined)
  vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } })
  const blocks = [...article.querySelectorAll('pre')].map(pre => pre.textContent ?? '')
  const copied: string[] = []
  for (const button of article.querySelectorAll<HTMLButtonElement>('button[aria-label="Copiar o código"]')) {
    writeText.mockClear()
    button.click()
    copied.push((writeText.mock.calls[0] as unknown as [string] | undefined)?.[0] ?? '')
  }
  return { blocks, copied, article }
}

const fence = (language: string, code: string) => `\`\`\`${language}\n${code}\n\`\`\``

describe('copying a code block of a note', () => {
  it('copies code with $& exactly as written, and the block shows the same', async () => {
    const code = 'preco = "a$&b"\nprint(preco)'
    const { blocks, copied } = await copiedFrom(`Antes do código.\n\n${fence('python', code)}\n\nDepois do código.`)
    expect(blocks).toEqual([code])
    expect(copied).toEqual([code])
  })

  it('does not put pieces of the note into code with $\' or $`', async () => {
    const code = "a = '$''\nb = '$`'\nc = '$$'"
    const { blocks, copied } = await copiedFrom(`# Título do texto\n\n${fence('javascript', code)}\n\nParágrafo depois do bloco.`)
    expect(blocks).toEqual([code])
    expect(copied).toEqual([code])
    expect(copied[0]).not.toContain('Título do texto')
    expect(copied[0]).not.toContain('Parágrafo depois')
  })

  it('keeps $$ and $& in a shell block with echo $HOME', async () => {
    const code = '#!/bin/bash\necho $HOME\necho "pid $$"\nsort $& | uniq\nls $\'x\''
    const { blocks, copied } = await copiedFrom(`Rode assim:\n\n${fence('bash', code)}\n\nFim.`)
    expect(blocks).toEqual([code])
    expect(copied).toEqual([code])
  })

  it('keeps those characters in a block with no language and in one with a language it does not know', async () => {
    const plain = 'echo $HOME $& $$ $\' $`'
    const unknown = 'valor $& e $$ e $\' e $`'
    const { blocks, copied } = await copiedFrom(`Texto de abertura.\n\n\`\`\`\n${plain}\n\`\`\`\n\n${fence('texto-qualquer', unknown)}\n\nTexto final.`)
    expect(blocks).toEqual([plain, unknown])
    expect(copied).toEqual([plain, unknown])
  })

  it('copies each of several blocks, even when two are identical', async () => {
    const code = 'x = "$&"'
    const { copied } = await copiedFrom(`${fence('python', code)}\n\nmeio\n\n${fence('python', code)}\n\n${fence('bash', 'echo $$')}`)
    expect(copied).toEqual([code, code, 'echo $$'])
  })

  it('copies only the code: no button text, no label, no line numbers', async () => {
    const code = 'linha um\nlinha dois\nlinha três'
    const { copied, article } = await copiedFrom(fence('python', code))
    expect(copied).toEqual([code])
    const pre = article.querySelector('pre')!
    expect(pre.querySelector('button, svg, [aria-label]')).toBeNull()
    expect(pre.textContent).toBe(code)
    expect(article.querySelector('.highlight button')).not.toBeNull()
    expect(article.querySelector('.highlight')?.contains(pre)).toBe(true)
  })

  it('copies what the code shows when it has < > & and quotes', async () => {
    const code = 'if (a < b && c > "d") { return \'e\' }'
    const { blocks, copied } = await copiedFrom(fence('javascript', code))
    expect(blocks).toEqual([code])
    expect(copied).toEqual([code])
  })
})
