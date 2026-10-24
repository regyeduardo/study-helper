import { afterEach, describe, expect, it, vi } from 'vitest'
import 'fake-indexeddb/auto'

import { withAlerts, withTaskLists } from '@/lib/github/alerts'
import { copyButtons, headingAnchors } from '@/lib/github/chrome'
import { mountDiagrams } from '@/lib/github/diagrams'
import { installFetch } from '@/test/ai/fake-provider'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
  document.body.innerHTML = ''
  document.documentElement.removeAttribute('data-theme')
})

describe('GitHub alerts and task lists', () => {
  it('turns [!WARNING] blockquotes into GitHub alert blocks', () => {
    const html = withAlerts('<blockquote>\n<p>[!WARNING]\ncuidado com isso</p>\n</blockquote>')
    expect(html).toContain('<div class="markdown-alert markdown-alert-warning">')
    expect(html).toContain('<p class="markdown-alert-title"><svg')
    expect(html).toContain('octicon-alert')
    expect(html).toContain('Warning</p><p>cuidado com isso</p>')
    expect(html).not.toContain('<blockquote>')
  })

  it.each(['NOTE', 'TIP', 'IMPORTANT', 'WARNING', 'CAUTION'])('handles %s', kind => {
    expect(withAlerts(`<blockquote><p>[!${kind}] x</p></blockquote>`)).toContain(`markdown-alert-${kind.toLowerCase()}`)
  })

  it('leaves normal blockquotes alone', () => {
    expect(withAlerts('<blockquote><p>citação</p></blockquote>')).toBe('<blockquote><p>citação</p></blockquote>')
  })

  it('turns [ ] and [x] items into disabled checkboxes', () => {
    const html = withTaskLists('<ul>\n<li>[x] feito</li>\n<li>[ ] falta</li>\n</ul>')
    expect(html).toBe(
      '<ul class="contains-task-list">\n<li class="task-list-item"><input type="checkbox" disabled="" class="task-list-item-checkbox" aria-label="Completed task" checked=""> feito</li>\n<li class="task-list-item"><input type="checkbox" disabled="" class="task-list-item-checkbox" aria-label="Incomplete task"> falta</li>\n</ul>',
    )
  })
})

describe('GitHub chrome', () => {
  it('wraps headings with anchors and adds copy buttons except for mermaid', () => {
    const root = document.createElement('article')
    root.innerHTML = '<h2>Etapas da Fase</h2><pre><code>x</code></pre><div class="highlight highlight-source-mermaid"><pre>flowchart TD</pre></div>'
    headingAnchors(root)
    copyButtons(root)
    const anchor = root.querySelector('.markdown-heading > a.anchor') as HTMLAnchorElement
    expect(anchor.getAttribute('href')).toBe('#etapas-da-fase')
    expect(anchor.getAttribute('aria-label')).toBe('Permalink: Etapas da Fase')
    expect(root.querySelectorAll('button[aria-label="Copiar o código"]')).toHaveLength(1)
    expect(root.querySelector('.highlight-source-mermaid button')).toBeNull()
    headingAnchors(root)
    expect(root.querySelectorAll('a.anchor')).toHaveLength(1)
  })
})

describe('mountDiagrams', () => {
  it('replaces each mermaid block with a viewer iframe and follows the viewer handshake', () => {
    document.documentElement.setAttribute('data-theme', 'dark')
    const root = document.createElement('article')
    root.innerHTML = '<p>a</p><div class="highlight highlight-source-mermaid"><pre>flowchart TD\nA--&gt;B</pre></div><div class="highlight highlight-source-mermaid"><pre>pie\n "x" : 1</pre></div>'
    document.body.appendChild(root)
    const unmount = mountDiagrams(root)
    const frames = [...root.querySelectorAll('iframe')]
    expect(frames).toHaveLength(2)
    expect(root.querySelector('.highlight-source-mermaid')).toBeNull()
    expect(frames[0].getAttribute('src')).toMatch(/\/gh-viewer\/view\.html#diagrama-0-\d+$/)
    expect(frames[0].referrerPolicy).toBe('no-referrer')
    expect(root.querySelectorAll('button[aria-label="Abrir em tela cheia"]')).toHaveLength(2)

    const identity = frames[0].getAttribute('src')!.split('#')[1]
    const posted: unknown[] = []
    vi.spyOn(frames[0].contentWindow!, 'postMessage').mockImplementation((message: unknown) => {
      posted.push(JSON.parse(message as string))
    })
    const wrapper = frames[0].parentElement!
    const actions = wrapper.querySelector('.js-render-block-actions') as HTMLElement
    expect(actions.style.getPropertyValue('display')).toBe('none')
    expect(wrapper.textContent).toContain('Desenhando o diagrama…')

    window.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ type: 'render', body: 'hello', identity }) }))
    expect(posted).toEqual([{ type: 'render:cmd', identity, body: { cmd: 'ack', ack: true } }])
    window.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ type: 'render', body: 'code_rendering_service:markdown:get_data', identity }) }))
    expect(posted[1]).toEqual({ type: 'render:cmd', identity, body: { cmd: 'code_rendering_service:data:ready', 'code_rendering_service:data:ready': { data: 'flowchart TD\nA-->B', width: 0 } } })
    expect(posted).toHaveLength(2)
    window.dispatchEvent(new MessageEvent('message', { data: { type: 'render', body: 'ready', identity, payload: { height: 200 } } }))
    expect(frames[0].height).toBe('224')
    expect(actions.style.getPropertyValue('display')).toBe('')
    expect(wrapper.textContent).not.toContain('Desenhando o diagrama…')
    unmount()
  })

  it('uses the light viewer in light theme and does nothing without mermaid', () => {
    document.documentElement.setAttribute('data-theme', 'light')
    const root = document.createElement('article')
    root.innerHTML = '<div class="highlight highlight-source-mermaid"><pre>pie</pre></div>'
    mountDiagrams(root)()
    expect(root.querySelector('iframe')!.getAttribute('src')).toContain('/gh-viewer/view-light.html#')
    const empty = document.createElement('article')
    empty.innerHTML = '<p>x</p>'
    expect(typeof mountDiagrams(empty)).toBe('function')
    expect(empty.innerHTML).toBe('<p>x</p>')
  })
})

describe('renderMarkdownController', () => {
  it('desenha o documento sem tocar na rede e guarda o resultado', async () => {
    const { renderMarkdownController } = await import('@/controllers/github.controller')
    const { calls } = installFetch(() => new Response('nao deve ser chamado'))
    const markdown = `> [!NOTE]\n> olha\n\n- [ ] tarefa ${Math.random()}`
    const html = await renderMarkdownController(markdown)
    expect(calls).toHaveLength(0)
    expect(html).toContain('markdown-alert-note')
    expect(html).toContain('task-list-item-checkbox')
    expect(await renderMarkdownController(markdown)).toBe(html)
    expect(calls).toHaveLength(0)
  })

  it('entrega a mesma estrutura que a api do GitHub entregava', async () => {
    const { renderMarkdownController } = await import('@/controllers/github.controller')
    const markdown = `# Titulo da aula\n\nParagrafo ${Math.random()} com [link](https://exemplo.com).\n\n\`\`\`python\ndef soma(a, b):\n    return a + b\n\`\`\`\n\n\`\`\`mermaid\nflowchart TD\n  A --> B\n\`\`\`\n`
    const html = await renderMarkdownController(markdown)
    expect(html).toContain('<div class="markdown-heading"><h1 class="heading-element">Titulo da aula</h1>')
    expect(html).toContain('<a id="user-content-titulo-da-aula" class="anchor" aria-label="Permalink: Titulo da aula" href="#titulo-da-aula">')
    expect(html).toContain('<a href="https://exemplo.com" rel="nofollow">link</a>')
    expect(html).toContain('<div class="highlight highlight-source-python"><pre><span class="pl-k">def</span>')
    expect(html).toContain('<div class="highlight highlight-source-mermaid">')
  })
})
