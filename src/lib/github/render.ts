import { createStarryNight } from '@wooorm/starry-night'
import { markdownToHTML } from 'comrak'
import { toHtml } from 'hast-util-to-html'
import onigurumaUrl from 'vscode-oniguruma/release/onig.wasm?url'

type Grammar = Parameters<Awaited<ReturnType<typeof createStarryNight>>['register']>[0][number]

const GRAMMARS: Record<string, () => Promise<{ default: Grammar }>> = {
  bash: () => import('@wooorm/starry-night/source.shell'),
  c: () => import('@wooorm/starry-night/source.c'),
  cpp: () => import('@wooorm/starry-night/source.c++'),
  csharp: () => import('@wooorm/starry-night/source.cs'),
  css: () => import('@wooorm/starry-night/source.css'),
  diff: () => import('@wooorm/starry-night/source.diff'),
  go: () => import('@wooorm/starry-night/source.go'),
  html: () => import('@wooorm/starry-night/text.html.basic'),
  java: () => import('@wooorm/starry-night/source.java'),
  javascript: () => import('@wooorm/starry-night/source.js'),
  json: () => import('@wooorm/starry-night/source.json'),
  kotlin: () => import('@wooorm/starry-night/source.kotlin'),
  markdown: () => import('@wooorm/starry-night/text.md'),
  mermaid: () => import('@wooorm/starry-night/source.mermaid'),
  php: () => import('@wooorm/starry-night/text.html.php'),
  python: () => import('@wooorm/starry-night/source.python'),
  ruby: () => import('@wooorm/starry-night/source.ruby'),
  rust: () => import('@wooorm/starry-night/source.rust'),
  sql: () => import('@wooorm/starry-night/source.sql'),
  swift: () => import('@wooorm/starry-night/source.swift'),
  typescript: () => import('@wooorm/starry-night/source.ts'),
  xml: () => import('@wooorm/starry-night/text.xml'),
  yaml: () => import('@wooorm/starry-night/source.yaml'),
}

const ALIASES: Record<string, string> = {
  'c++': 'cpp',
  cs: 'csharp',
  htm: 'html',
  js: 'javascript',
  jsx: 'javascript',
  kt: 'kotlin',
  md: 'markdown',
  mjs: 'javascript',
  py: 'python',
  rb: 'ruby',
  rs: 'rust',
  sh: 'bash',
  shell: 'bash',
  tsx: 'typescript',
  ts: 'typescript',
  yml: 'yaml',
  zsh: 'bash',
}

const OWN_DOMAINS = /^https?:\/\/([^/]*\.)?(github\.com|github\.io|githubusercontent\.com)/

type Engine = Awaited<ReturnType<typeof createStarryNight>>

let engine: Engine | null = null
const loaded = new Map<string, Grammar>()

async function engineFor(languages: readonly string[]): Promise<Engine> {
  const missing = [...new Set(languages)].filter(name => GRAMMARS[name] && !loaded.has(name))
  for (const name of missing) loaded.set(name, (await GRAMMARS[name]()).default)
  if (!engine || missing.length) {
    engine = await createStarryNight([...loaded.values()], {
      getOnigurumaUrlFetch: async () => new URL(onigurumaUrl, location.href),
    })
  }
  return engine
}

function decode(text: string): string {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
}

function slug(text: string): string {
  return text.toLowerCase().trim().replace(/[^\p{L}\p{N}\-_ ]+/gu, '').replace(/ /g, '-')
}

const ANCHOR_ICON = '<span aria-hidden="true" class="octicon octicon-link"></span>'

async function highlightBlocks(html: string): Promise<string> {
  const blocks = [...html.matchAll(/<pre><code class="language-([^"]+)">([\s\S]*?)<\/code><\/pre>/g)]
  const names = blocks.map(([, language]) => ALIASES[language] ?? language)
  const starryNight = blocks.length ? await engineFor(names) : null
  let painted = html
  for (const [index, [whole, language, body]] of blocks.entries()) {
    const scope = starryNight && GRAMMARS[names[index]] ? starryNight.flagToScope(names[index]) : undefined
    const source = decode(body).replace(/\n$/, '')
    const inner = scope && starryNight
      ? toHtml(starryNight.highlight(source, scope), { characterReferences: { useNamedReferences: true } })
      : body.replace(/\n$/, '')
    const wrapper = scope ? ` highlight-${scope.replace(/\./g, '-')}` : ''
    painted = painted.replace(whole, `<div class="highlight${wrapper}"><pre>${inner}</pre></div>`)
  }
  return painted.replace(/<pre><code>([\s\S]*?)<\/code><\/pre>/g, (_, body: string) => `<div class="highlight"><pre>${body.replace(/\n$/, '')}</pre></div>`)
}

function asGithub(html: string): string {
  const linked = html.replace(/<a href="(https?:\/\/[^"]+)">/g, (whole, href: string) =>
    OWN_DOMAINS.test(href) ? whole : `<a href="${href}" rel="nofollow">`)
  const voids = linked.replace(/<hr \/>/g, '<hr>').replace(/<br \/>/g, '<br>')
  const items = voids.replace(/<li>([\s\S]*?)<\/li>/g, (whole, inner: string) => {
    if (inner.includes('<li>') || inner.startsWith('\n')) return whole
    return `${inner.startsWith('<') ? '<li>\n' : '<li>'}${inner}${inner.endsWith('>') ? '\n</li>' : '</li>'}`
  })
  const quotes = items.split(/(<[^>]*>)/).map((part, index) => (index % 2 ? part : part.replace(/&quot;/g, '"'))).join('')
  return quotes.replace(/<h([1-6])>([\s\S]*?)<\/h\1>/g, (_, level: string, inner: string) => {
    const plain = inner.replace(/<[^>]+>/g, '')
    const id = slug(plain)
    return `<div class="markdown-heading"><h${level} class="heading-element">${inner}</h${level}><a id="user-content-${id}" class="anchor" aria-label="Permalink: ${plain}" href="#${id}">${ANCHOR_ICON}</a></div>`
  })
}

export async function renderMarkdown(markdown: string): Promise<string> {
  const html = markdownToHTML(markdown, {
    extension: { autolink: true, footnotes: true, strikethrough: true, table: true, tagfilter: true, shortcodes: true },
    render: { unsafe: true, gfmQuirks: true },
  })
  return asGithub(await highlightBlocks(html))
}
