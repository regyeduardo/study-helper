import { type Locator, type Page } from '@playwright/test'

/**
 * The Lista de operações of spec 007 (contracts/ui.md), measured inside the page (research R1): the click is dispatched in the page
 * and the clock stops at the first frame painted after the result is there and the window of choice F is gone. Each measure is split
 * between the network (API requests in the window), the server (Server-Timing "total" of those requests) and the device (the rest).
 */

export interface Pronto {
  /** CSS of the element that shows the result. */
  css?: string
  /** Text it must have. */
  text?: string
  /** The result is the element leaving (a note out of the list). */
  gone?: boolean
  /** A condition of its own, as JS returning a boolean (a media playing). */
  js?: string
}

export interface Medida {
  op: string
  ms: number
  rede: number
  servidor: number
  aparelho: number
  pedidos: number
}

export async function medir(page: Page, op: string, alvo: Locator, pronto: Pronto, api: string, timeout = 60_000): Promise<Medida> {
  const target = await alvo.elementHandle({ timeout: 30_000 })
  if (!target) throw new Error(`${op}: alvo não achado`)
  const out = await page.evaluate(
    async ({ el, pronto, api, timeout }) => {
      const visible = (node: Element) => node.getClientRects().length > 0
      const ok = (): boolean => {
        if (document.querySelector('.blk-layer')) return false
        if (pronto.js) return Boolean(new Function(`return (${pronto.js})`)())
        const nodes = [...document.querySelectorAll(pronto.css ?? 'body')].filter(node => visible(node) && (!pronto.text || (node.textContent ?? '').includes(pronto.text)))
        return pronto.gone ? nodes.length === 0 : nodes.length > 0
      }
      // a result already on the screen before the click would measure nothing: a failure, not a number
      if (ok()) throw new Error('o resultado já estava na tela antes do clique')
      performance.clearResourceTimings()
      const t0 = performance.now()
      ;(el as HTMLElement).click()
      // a click on React runs in the same task; the result is checked at every frame
      await new Promise(resolve => setTimeout(resolve, 0))
      while (!ok()) {
        if (performance.now() - t0 > timeout) throw new Error('tempo esgotado esperando o resultado')
        await new Promise(resolve => requestAnimationFrame(resolve))
      }
      await new Promise(resolve => requestAnimationFrame(() => setTimeout(resolve, 0)))
      const t1 = performance.now()
      const calls = (performance.getEntriesByType('resource') as PerformanceResourceTiming[]).filter(entry => entry.name.startsWith(api) && entry.startTime >= t0 - 1 && entry.startTime <= t1)
      // the network is the union of the requests' intervals; the server, what they spent on it (capped by that union)
      const spans = calls.map(entry => [entry.startTime, Math.min(entry.responseEnd || t1, t1)] as [number, number]).sort((a, b) => a[0] - b[0])
      let union = 0
      let end = -Infinity
      for (const [start, stop] of spans) {
        if (stop <= end) continue
        union += stop - Math.max(start, end)
        end = stop
      }
      const server = calls.reduce((sum, entry) => sum + (entry.serverTiming.find(timing => timing.name === 'total')?.duration ?? 0), 0)
      return { ms: t1 - t0, union, server: Math.min(server, union), calls: calls.length }
    },
    { el: target, pronto, api, timeout },
  )
  return { op, ms: out.ms, rede: out.union - out.server, servidor: out.server, aparelho: out.ms - out.union, pedidos: out.calls }
}

/** Opening the app, from the start of the navigation to the library on screen (no click: the navigation is the start). */
export async function medirAbertura(page: Page, op: string, url: string, pronto: Pronto, api: string): Promise<Medida> {
  await page.goto(url, { waitUntil: 'commit' })
  const out = await page.evaluate(
    async ({ pronto, api }) => {
      const ok = () => {
        const nodes = [...document.querySelectorAll(pronto.css ?? 'body')].filter(node => node.getClientRects().length > 0 && (!pronto.text || (node.textContent ?? '').includes(pronto.text)))
        return nodes.length > 0 && !document.querySelector('.blk-layer')
      }
      while (!ok()) await new Promise(resolve => requestAnimationFrame(resolve))
      await new Promise(resolve => requestAnimationFrame(() => setTimeout(resolve, 0)))
      const t1 = performance.now()
      const calls = (performance.getEntriesByType('resource') as PerformanceResourceTiming[]).filter(entry => entry.name.startsWith(api) && entry.startTime <= t1)
      const spans = calls.map(entry => [entry.startTime, Math.min(entry.responseEnd || t1, t1)] as [number, number]).sort((a, b) => a[0] - b[0])
      let union = 0
      let end = -Infinity
      for (const [start, stop] of spans) {
        if (stop <= end) continue
        union += stop - Math.max(start, end)
        end = stop
      }
      const server = calls.reduce((sum, entry) => sum + (entry.serverTiming.find(timing => timing.name === 'total')?.duration ?? 0), 0)
      return { ms: t1, union, server: Math.min(server, union), calls: calls.length }
    },
    { pronto, api },
  )
  return { op, ms: out.ms, rede: out.union - out.server, servidor: out.server, aparelho: out.ms - out.union, pedidos: out.calls }
}

/** Types in a field the way a person does, measuring from the last key to the result. */
export async function medirDigitando(page: Page, op: string, campo: Locator, texto: string, pronto: Pronto, api: string): Promise<Medida> {
  await campo.fill(texto.slice(0, -1))
  await campo.focus()
  return medirTecla(page, op, campo, texto, pronto, api)
}

async function medirTecla(page: Page, op: string, campo: Locator, texto: string, pronto: Pronto, api: string): Promise<Medida> {
  const el = await campo.elementHandle()
  const out = await page.evaluate(
    async ({ el, value, pronto, api }) => {
      const input = el as HTMLInputElement
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
      const ok = () => {
        const nodes = [...document.querySelectorAll(pronto.css ?? 'body')].filter(node => node.getClientRects().length > 0 && (!pronto.text || (node.textContent ?? '').includes(pronto.text)))
        return nodes.length > 0
      }
      performance.clearResourceTimings()
      const t0 = performance.now()
      setter.call(input, value)
      input.dispatchEvent(new Event('input', { bubbles: true }))
      while (!ok()) {
        if (performance.now() - t0 > 60_000) throw new Error('tempo esgotado')
        await new Promise(resolve => requestAnimationFrame(resolve))
      }
      await new Promise(resolve => requestAnimationFrame(() => setTimeout(resolve, 0)))
      const t1 = performance.now()
      const calls = (performance.getEntriesByType('resource') as PerformanceResourceTiming[]).filter(entry => entry.name.startsWith(api) && entry.startTime >= t0 - 1)
      const server = calls.reduce((sum, entry) => sum + (entry.serverTiming.find(timing => timing.name === 'total')?.duration ?? 0), 0)
      const union = calls.reduce((sum, entry) => sum + Math.max(0, Math.min(entry.responseEnd || t1, t1) - entry.startTime), 0)
      return { ms: t1 - t0, union: Math.min(union, t1 - t0), server: Math.min(server, union), calls: calls.length }
    },
    { el, value: texto, pronto, api },
  )
  return { op, ms: out.ms, rede: out.union - out.server, servidor: out.server, aparelho: out.ms - out.union, pedidos: out.calls }
}
