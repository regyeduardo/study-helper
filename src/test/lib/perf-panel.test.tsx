import '@/test/account/storage-shim'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'

import { PerfPanel } from '@/components/ui/PerfPanel'
import { comeca, ligarMedidas, termina } from '@/lib/perf'

// O painel de medidas (spec 007, T023): para o roteiro no celular de verdade, onde o Playwright não chega. Só existe com as medidas
// ligadas (?medidas); mostra cada operação feita com o tempo e a meta, e copia os números para o dono mandar.

beforeEach(() => vi.useFakeTimers({ shouldAdvanceTime: true }))
afterEach(() => {
  vi.useRealTimers()
  ligarMedidas(false)
})

describe('PerfPanel', () => {
  it('sem as medidas ligadas, não aparece', () => {
    ligarMedidas(false)
    const { container } = render(<PerfPanel />)
    expect(container).toBeEmptyDOMElement()
  })

  it('mostra cada operação feita, com o tempo e se ficou na meta', async () => {
    ligarMedidas(true)
    render(<PerfPanel />)
    expect(screen.getByRole('region', { name: 'Medidas' })).toBeInTheDocument()
    comeca('abrir-pasta')
    await act(async () => {
      await vi.advanceTimersByTimeAsync(700)
    })
    termina('abrir-pasta')
    await act(async () => {
      await vi.advanceTimersByTimeAsync(50)
    })
    const row = screen.getByText('abrir-pasta').closest('li')!
    expect(row).toHaveTextContent(/7\d\d ms/)
    expect(row).toHaveTextContent('meta 500 ms')
    expect(row).toHaveTextContent('fora')
  })

  it('copia os números e limpa', async () => {
    ligarMedidas(true)
    const write = vi.fn(async () => undefined)
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: write } })
    render(<PerfPanel />)
    comeca('buscar')
    termina('buscar')
    await act(async () => {
      await vi.advanceTimersByTimeAsync(50)
    })
    fireEvent.click(screen.getByRole('button', { name: 'Copiar' }))
    expect(write).toHaveBeenCalledWith(expect.stringContaining('"op":"buscar"'))
    fireEvent.click(screen.getByRole('button', { name: 'Limpar' }))
    expect(screen.queryByText('buscar')).toBeNull()
  })
})
