// Spec 007, história 6 (T130, FR-060 a FR-063; contracts/ui.md, Inventário de esperas): toda espera do inventário mostra o que está
// acontecendo, quanto já foi, quando deve terminar e que não travou; parada, diz desde quando. Uma espera fora do inventário não existe.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, render, screen } from '@testing-library/react'

import { BlockingWindow } from '@/components/ui/BlockingWindow'
import { WaitStatus } from '@/components/ui/WaitStatus'
import { advance, startWait } from '@/lib/wait'
import { WAIT_CATALOG, waitEntry } from '@/lib/wait-catalog'
import { useBlockingStore } from '@/stores/blocking'
import { useSyncStore } from '@/stores/sync'

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: false })
  vi.setSystemTime(new Date(2026, 10, 24, 10, 0, 0))
  useBlockingStore.setState({ ops: [] })
})
afterEach(() => vi.useRealTimers())

describe('o inventário', () => {
  it('tem todas as esperas do contrato, cada uma com onde aparece, a unidade e a base da previsão', () => {
    expect(WAIT_CATALOG).toHaveLength(28)
    for (const entry of WAIT_CATALOG) {
      expect(entry.where, entry.id).toBeTruthy()
      expect(entry.unit, entry.id).toBeTruthy()
      expect(['parts', 'history', 'parts+history', 'queue']).toContain(entry.basis)
      if (entry.basis !== 'queue') expect(entry.normalStepMs, entry.id).toBeGreaterThan(0)
    }
  })

  it('uma espera fora do inventário é um erro', () => {
    expect(() => waitEntry('espera-inventada')).toThrow('Espera fora do inventário')
  })

  it.each(WAIT_CATALOG.filter(entry => entry.basis !== 'queue').map(entry => [entry.id, entry] as const))('%s: as quatro coisas, e o aviso quando para', (_id, entry) => {
    const start = Date.now()
    let wait = startWait(entry.label, { unit: 'partes', total: 10, normalStepMs: entry.normalStepMs!, now: start })
    wait = advance(wait, { done: 2, label: 'parte 2 de 10' }, start + 2 * 1000)
    vi.setSystemTime(start + 3 * 1000)
    const { unmount } = render(<WaitStatus wait={wait} />)
    expect(screen.getByText(entry.label)).toBeInTheDocument()
    expect(screen.getByText('2 de 10 partes')).toBeInTheDocument()
    expect(screen.getByText(/^deve terminar por volta de \d\d:\d\d$/)).toBeInTheDocument()
    expect(screen.getByText(/^sem travar: última parte há \d+ s$/)).toBeInTheDocument()
    unmount()
    vi.setSystemTime(start + 2 * 1000 + 2 * entry.normalStepMs! + 1000)
    render(<WaitStatus wait={wait} />)
    expect(screen.getByRole('alert')).toHaveTextContent('Nada andou desde')
  })

  it('a fila mostra a posição', () => {
    const queue = waitEntry('fila')
    render(<WaitStatus wait={startWait('Na fila da conta: 2º', { now: Date.now() })} />)
    expect(queue.basis).toBe('queue')
    // the line and the one the screen reader hears
    expect(screen.getAllByText('Na fila da conta: 2º').length).toBeGreaterThan(0)
  })
})

describe('a janela do meio da tela (escolha F)', () => {
  it('diz quando deve terminar, que não travou, e avisa quando nada anda', () => {
    useSyncStore.setState({ conflicts: [], conflictsHidden: false } as never)
    render(<BlockingWindow />)
    let id = ''
    act(() => {
      id = useBlockingStore.getState().open('Movendo 10 itens…', { phase: 'Levando para Reuniões', done: 0, total: 10 })
    })
    for (let n = 1; n <= 4; n++) {
      act(() => {
        vi.advanceTimersByTime(1000)
        useBlockingStore.getState().progress(id, { done: n })
      })
    }
    act(() => vi.advanceTimersByTime(1000))
    expect(screen.getByText(/deve terminar por volta de 10:00/)).toBeInTheDocument()
    expect(screen.getByText(/^sem travar: última parte há \d+ s$/)).toBeInTheDocument()
    act(() => vi.advanceTimersByTime(61_000))
    expect(screen.getByRole('alert')).toHaveTextContent('Nada andou desde 10:00. Normal para esta etapa é até 30 s.')
  })
})
