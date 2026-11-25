/**
 * The marks of each operation of the Lista de operações (spec 007, FR-001, research R1; ids in contracts/ui.md): `comeca` at the click,
 * `termina` when the result is there; the measure closes at the first frame painted after it. Only with `?medidas` in the address (kept
 * for the tab) or the Playwright's signal (`window.__ESTUDO_MEDIR__`); otherwise both calls return at once and record nothing.
 */

export type OpId =
  | 'abrir-app-cache'
  | 'abrir-app-novo'
  | 'entrar'
  | 'tela-biblioteca'
  | 'tela-gravacoes'
  | 'tela-geracoes'
  | 'tela-idiomas'
  | 'tela-config'
  | 'tela-admin'
  | 'abrir-pasta'
  | 'abrir-nota-texto'
  | 'abrir-nota-midia'
  | 'abrir-nota-pdf'
  | 'digitar'
  | 'guardar-texto'
  | 'criar'
  | 'renomear'
  | 'mover'
  | 'apagar'
  | 'restaurar'
  | 'buscar'
  | 'abrir-locais'
  | 'levar-para-app'
  | 'enviar-midia'
  | 'tocar-midia'
  | 'pular-minuto'
  | 'abrir-cartoes'
  | 'revisar-cartao'
  | 'abrir-prova'
  | 'responder-prova'
  | 'abrir-idiomas'
  | 'revisar-idiomas'
  | 'pedir-geracao'
  | 'salvar-gravacao'
  | 'compartilhar'
  | 'abrir-link'
  | 'importar-link'
  | 'mudanca-outro-aparelho'

export interface Medida {
  op: OpId
  /** From the click to the first frame painted after the result. */
  ms: number
  /** When it ended (epoch ms). */
  at: number
}

const FLAG = 'study-helper:medidas'

interface MeasureWindow {
  __ESTUDO_MEDIR__?: boolean
  __ESTUDO_MEDIDAS__?: Medida[]
}

function fromPage(): boolean {
  if (typeof window === 'undefined') return false
  if ((window as MeasureWindow).__ESTUDO_MEDIR__ === true) return true
  try {
    if (new URLSearchParams(window.location.search).has('medidas')) {
      sessionStorage.setItem(FLAG, '1')
      return true
    }
    return sessionStorage.getItem(FLAG) === '1'
  } catch {
    return false
  }
}

let on = fromPage()
const started = new Map<OpId, number>()
const done: Medida[] = []
const listeners = new Set<(medida: Medida) => void>()

export const medindo = (): boolean => on

/** Turns the marks on or off (the measures panel, the tests). */
export function ligarMedidas(value: boolean): void {
  on = value
  started.clear()
  done.length = 0
  if (typeof window !== 'undefined') (window as MeasureWindow).__ESTUDO_MEDIDAS__ = done
}

if (typeof window !== 'undefined') (window as MeasureWindow).__ESTUDO_MEDIDAS__ = done

/** When an action started, for an operation known only at its end (a note opened, by its type). */
export interface Desde {
  at: number
  perf: number
}

export const agora = (): Desde => ({ at: Date.now(), perf: performance.now() })

export function comeca(op: OpId, desde?: Desde): void {
  if (!on) return
  started.set(op, desde?.at ?? Date.now())
  if (desde) performance.mark(`op:${op}:start`, { startTime: desde.perf })
  else performance.mark(`op:${op}:start`)
}

/** After the next paint: a frame, then a task (the frame callback runs before the paint itself). */
function afterPaint(run: () => void): void {
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => setTimeout(run, 0))
  else setTimeout(run, 16)
}

export function termina(op: OpId): void {
  if (!on) return
  const from = started.get(op)
  if (from === undefined) return
  started.delete(op)
  afterPaint(() => {
    performance.mark(`op:${op}:end`)
    try {
      performance.measure(`op:${op}`, `op:${op}:start`, `op:${op}:end`)
    } catch {
      // a mark cleared in between (another tab of the measures) only loses the timeline entry, not the measure
    }
    const medida: Medida = { op, ms: Date.now() - from, at: Date.now() }
    done.push(medida)
    for (const listener of listeners) listener(medida)
  })
}

export const medidas = (): Medida[] => [...done]

/** Hears every measure that closes; gives back the function that stops hearing. */
export function aoMedir(listener: (medida: Medida) => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}
