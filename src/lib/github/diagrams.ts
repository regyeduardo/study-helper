import { COPY_ICON_MARKUP, FIT_ICON, iconButton } from '@/lib/github/chrome'
import { isDarkTheme } from '@/lib/theme'

function viewerPage(): string {
  return `${import.meta.env.BASE_URL}gh-viewer/${isDarkTheme() ? 'view.html' : 'view-light.html'}`
}
const DEFAULT_HEIGHT = 320
const RETRY_INTERVAL = 2500
const MAX_RETRIES = 24

interface Diagram {
  code: string
  frame: HTMLIFrameElement
  actions: HTMLElement
  waiting: HTMLElement
  ready: boolean
  asked: boolean
  tries: number
}

function send(frame: HTMLIFrameElement, identity: string, command: string, payload: unknown) {
  frame.contentWindow?.postMessage(
    JSON.stringify({ type: 'render:cmd', identity, body: { cmd: command, [command]: payload } }),
    '*',
  )
}

function newFrame(identity: string): HTMLIFrameElement {
  const frame = document.createElement('iframe')
  frame.src = `${viewerPage()}#${identity}`
  frame.referrerPolicy = 'no-referrer'
  frame.height = String(DEFAULT_HEIGHT)
  frame.style.width = '100%'
  frame.style.border = '0'
  frame.style.display = 'block'
  frame.style.background = 'transparent'
  return frame
}

export function mountDiagrams(container: ParentNode): () => void {
  const diagrams = new Map<string, Diagram>()

  container.querySelectorAll('.highlight-source-mermaid').forEach((block, index) => {
    const code = block.querySelector('pre')?.textContent ?? ''
    const identity = `diagrama-${index}-${Date.now()}`
    const frame = newFrame(identity)

    const wrapper = document.createElement('div')
    wrapper.className = 'render-needs-enrichment position-relative'
    wrapper.style.marginBottom = '16px'

    const actions = document.createElement('div')
    actions.className = 'js-render-block-actions position-absolute top-0 pr-2 right-0 d-flex flex-justify-end flex-items-center'
    actions.style.setProperty('display', 'none', 'important')
    actions.append(
      iconButton('Abrir em tela cheia', FIT_ICON, () => fullScreen(code)),
      iconButton('Copiar o diagrama', COPY_ICON_MARKUP, () => navigator.clipboard?.writeText(code)),
    )

    const waiting = document.createElement('p')
    waiting.className = 'color-fg-muted position-absolute top-0 left-0 m-3'
    waiting.textContent = 'Desenhando o diagrama…'

    wrapper.append(frame, waiting, actions)
    block.replaceWith(wrapper)
    diagrams.set(identity, { code, frame, actions, waiting, ready: false, asked: false, tries: 0 })
  })

  if (diagrams.size === 0) return () => {}

  const feed = (diagram: Diagram, identity: string) =>
    send(diagram.frame, identity, 'code_rendering_service:data:ready', {
      data: diagram.code,
      width: diagram.frame.clientWidth,
    })

  const onMessage = (event: MessageEvent) => {
    let message: { type?: string; body?: string; identity?: string; payload?: { height?: number } }
    try {
      message = typeof event.data === 'string' ? JSON.parse(event.data) : event.data
    } catch {
      return
    }
    if (!message || message.type !== 'render' || !message.identity) return

    const diagram = diagrams.get(message.identity)
    if (!diagram) return

    if (message.body === 'hello') send(diagram.frame, message.identity, 'ack', true)
    if (message.body === 'code_rendering_service:markdown:get_data') {
      diagram.asked = true
      feed(diagram, message.identity)
    }
    if (message.body === 'ready') {
      diagram.ready = true
      diagram.frame.height = String((message.payload?.height ?? DEFAULT_HEIGHT) + 24)
      diagram.waiting.remove()
      diagram.actions.style.removeProperty('display')
      send(diagram.frame, message.identity, 'code_rendering_service:ready:ack', true)
    }
  }

  const retry = window.setInterval(() => {
    diagrams.forEach((diagram, identity) => {
      if (diagram.ready || diagram.asked || diagram.tries >= MAX_RETRIES) return
      diagram.tries += 1
      send(diagram.frame, identity, 'ack', true)
    })
  }, RETRY_INTERVAL)

  window.addEventListener('message', onMessage)
  return () => {
    window.removeEventListener('message', onMessage)
    window.clearInterval(retry)
  }
}

function fullScreen(code: string) {
  const identity = `diagrama-cheio-${Date.now()}`
  const overlay = document.createElement('div')
  overlay.style.cssText = 'position:fixed;inset:24px;z-index:80;background:var(--bg);border:1px solid var(--border);border-radius:12px;padding:24px;box-shadow:var(--shadow)'

  const frame = newFrame(identity)
  frame.style.height = '100%'
  frame.height = ''

  const close = iconButton('Fechar', '✕', () => {
    overlay.remove()
    window.removeEventListener('message', onMessage)
  })
  close.style.cssText = 'position:absolute;top:8px;right:12px;color:var(--fg);font-size:18px'

  const onMessage = (event: MessageEvent) => {
    let message: { type?: string; body?: string; identity?: string }
    try {
      message = typeof event.data === 'string' ? JSON.parse(event.data) : event.data
    } catch {
      return
    }
    if (message?.type !== 'render' || message.identity !== identity) return
    if (message.body === 'hello') send(frame, identity, 'ack', true)
    if (message.body === 'code_rendering_service:markdown:get_data') send(frame, identity, 'code_rendering_service:data:ready', { data: code, width: frame.clientWidth })
    if (message.body === 'ready') send(frame, identity, 'code_rendering_service:ready:ack', true)
  }

  window.addEventListener('message', onMessage)
  overlay.append(close, frame)
  document.body.appendChild(overlay)
}
