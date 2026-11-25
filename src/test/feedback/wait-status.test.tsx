import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'

import { WaitStatus } from '@/components/ui/WaitStatus'
import { advance, startWait, type Wait } from '@/lib/wait'

// O componente de toda espera (spec 007, contracts/ui.md, seção WaitStatus): o que acontece, quanto já foi, quando termina, que não
// travou; parado, desde quando e o que fazer; no fim, o resultado ou o motivo.

const at = (hours: number, minutes: number, seconds = 0) => new Date(2026, 10, 24, hours, minutes, seconds).getTime()

beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
})

function running(): Wait {
  let wait = startWait('Escrevendo a Ata', { unit: 'pedaços', total: 6, now: at(1, 20), normalStepMs: 5 * 60_000 })
  for (let part = 1; part <= 5; part++) wait = advance(wait, { done: part, label: `pedaço ${part} de 6 pronto` }, at(1, 20 + part * 4))
  return wait
}

describe('enquanto anda', () => {
  it('mostra o que acontece, quanto já foi, o horário previsto e que não travou', () => {
    vi.setSystemTime(at(1, 40, 12))
    render(<WaitStatus wait={running()} />)
    expect(screen.getByText('Escrevendo a Ata')).toBeInTheDocument()
    expect(screen.getByText('5 de 6 pedaços')).toBeInTheDocument()
    expect(screen.getByText('deve terminar por volta de 01:44')).toBeInTheDocument()
    expect(screen.getByText('sem travar: última parte há 12 s')).toBeInTheDocument()
    const bar = screen.getByRole('progressbar')
    expect(bar).toHaveAttribute('aria-valuenow', '83')
    expect(bar).toHaveAttribute('aria-valuetext', '5 de 6 pedaços')
  })

  it('o "há N s" anda sozinho, a cada segundo', () => {
    vi.setSystemTime(at(1, 40, 12))
    render(<WaitStatus wait={running()} />)
    act(() => {
      vi.advanceTimersByTime(3000)
    })
    expect(screen.getByText('sem travar: última parte há 15 s')).toBeInTheDocument()
  })

  it('com a previsão pelo histórico, diz de onde ela vem', () => {
    vi.setSystemTime(at(1, 0, 10))
    render(<WaitStatus wait={startWait('Escrevendo a Ata', { unit: 'etapas', total: 4, now: at(1, 0), history: { ms: 5 * 60_000, label: 'Atas' } })} />)
    expect(screen.getByText('deve terminar por volta de 01:05, pelas últimas Atas parecidas')).toBeInTheDocument()
  })

  it('sem total, não há barra cheia nem porcentagem, e diz que o total ainda não se sabe', () => {
    vi.setSystemTime(at(1, 0, 30))
    const wait = advance(startWait('Lendo o link', { unit: 'páginas lidas', now: at(1, 0) }), { done: 3 }, at(1, 0, 20))
    render(<WaitStatus wait={wait} />)
    expect(screen.getByText('3 páginas lidas · o total ainda não se sabe')).toBeInTheDocument()
    expect(screen.getByRole('progressbar')).not.toHaveAttribute('aria-valuenow')
    expect(screen.queryByText(/deve terminar/)).toBeNull()
  })

  it('a linha lida pelo leitor de tela muda no máximo a cada 10 s', () => {
    vi.setSystemTime(at(1, 40, 12))
    const { rerender } = render(<WaitStatus wait={running()} />)
    const live = screen.getByRole('status')
    const first = live.textContent
    expect(first).toContain('5 de 6 pedaços')
    const sixth = advance(running(), { done: 6 }, at(1, 40, 14))
    vi.setSystemTime(at(1, 40, 14))
    rerender(<WaitStatus wait={sixth} />)
    expect(screen.getByRole('status').textContent).toBe(first)
    act(() => {
      vi.advanceTimersByTime(10_000)
    })
    expect(screen.getByRole('status').textContent).toContain('6 de 6 pedaços')
  })
})

describe('parado', () => {
  it('diz desde quando nada anda, o normal da etapa, e oferece o que fazer', () => {
    vi.setSystemTime(at(1, 40))
    let wait = startWait('Lendo a tela', { unit: 'quadros', total: 40, now: at(1, 30), normalStepMs: 60_000 })
    wait = advance(wait, { done: 1 }, at(1, 31))
    const onCancel = vi.fn()
    const onRetry = vi.fn()
    render(<WaitStatus wait={wait} onCancel={onCancel} onRetry={onRetry} />)
    const alert = screen.getByRole('alert')
    expect(alert).toHaveTextContent('Nada andou desde 01:31. Normal para esta etapa é até 1 min.')
    fireEvent.click(screen.getByRole('button', { name: 'Cancelar' }))
    fireEvent.click(screen.getByRole('button', { name: 'Tentar de novo' }))
    expect(onCancel).toHaveBeenCalledOnce()
    expect(onRetry).toHaveBeenCalledOnce()
    // "Esperar" guarda o aviso até mais um tempo normal sem andar
    fireEvent.click(screen.getByRole('button', { name: 'Esperar' }))
    expect(screen.queryByRole('alert')).toBeNull()
    act(() => {
      vi.advanceTimersByTime(61_000)
    })
    expect(screen.getByRole('alert')).toBeInTheDocument()
  })

  it('sem quem cancele nem tente de novo, só "Esperar"', () => {
    vi.setSystemTime(at(1, 40))
    const wait = advance(startWait('Lendo a tela', { unit: 'quadros', total: 40, now: at(1, 30), normalStepMs: 60_000 }), { done: 1 }, at(1, 31))
    render(<WaitStatus wait={wait} />)
    expect(screen.getByRole('button', { name: 'Esperar' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Cancelar' })).toBeNull()
  })
})

describe('no fim', () => {
  it('diz o resultado', () => {
    vi.setSystemTime(at(1, 45))
    const onOpen = vi.fn()
    render(<WaitStatus wait={{ ...running(), outcome: { ok: true, text: 'Ata pronta' } }} onOpen={onOpen} />)
    expect(screen.getByText('Ata pronta')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Abrir' }))
    expect(onOpen).toHaveBeenCalledOnce()
    expect(screen.queryByRole('progressbar')).toBeNull()
  })

  it('na falha, o motivo e o que fazer', () => {
    vi.setSystemTime(at(1, 45))
    render(<WaitStatus wait={{ ...running(), outcome: { ok: false, text: 'A IA do app está fora do ar agora.', next: 'Tente de novo em alguns minutos.' } }} onRetry={vi.fn()} />)
    expect(screen.getByText('A IA do app está fora do ar agora.')).toBeInTheDocument()
    expect(screen.getByText('Tente de novo em alguns minutos.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Tentar de novo' })).toBeInTheDocument()
  })
})
