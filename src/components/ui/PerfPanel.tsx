import { useEffect, useState } from 'react'

import { aoMedir, ligarMedidas, type Medida, medidas, medindo } from '@/lib/perf'
import { METAS } from '@/lib/perf-metas'

import '@/styles/perf-panel.css'

const KEPT = 30

const show = (ms: number) => (ms >= 1000 ? `${(ms / 1000).toLocaleString('pt-BR', { maximumFractionDigits: 2 })} s` : `${Math.round(ms)} ms`)

/**
 * The measures panel (spec 007, T023): only with `?medidas`, for the manual test on a real phone, where the Playwright does not reach.
 * Each operation the person does shows with its time and its target; "Copiar" gives the numbers to send.
 */
export function PerfPanel() {
  const [list, setList] = useState<Medida[]>(() => medidas().slice(-KEPT))
  useEffect(() => (medindo() ? aoMedir(medida => setList(current => [...current, medida].slice(-KEPT))) : undefined), [])
  if (!medindo()) return null
  const copy = () => void navigator.clipboard?.writeText(JSON.stringify({ aparelho: navigator.userAgent, medidas: list }))
  const clear = () => {
    ligarMedidas(true)
    setList([])
  }
  return (
    <section className="perf-panel" role="region" aria-label="Medidas">
      <header>
        <b>Medidas</b>
        <button className="btn quiet" onClick={copy}>
          Copiar
        </button>
        <button className="btn quiet" onClick={clear}>
          Limpar
        </button>
      </header>
      <ol>
        {list
          .slice()
          .reverse()
          .map(medida => {
            const meta = METAS[medida.op]
            const inside = meta === undefined ? null : medida.ms <= meta
            return (
              <li key={`${medida.op}-${medida.at}`} className={inside === false ? 'out' : undefined}>
                <span className="op">{medida.op}</span>
                <span className="ms">{show(medida.ms)}</span>
                {meta !== undefined && <span className="meta">{`meta ${show(meta)} · ${inside ? 'dentro' : 'fora'}`}</span>}
              </li>
            )
          })}
      </ol>
    </section>
  )
}
