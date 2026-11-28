import { act, fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// T194 (dono, 27/11: "O sistema precisa ser rápido e fluido (mesmo que haja latência no servidor)… Corrija tudo"): a operação de um item
// não segura mais o app na janela do meio (escolha F de 21/11, mantida para lote, irreversível e conta). A mudança aparece na hora (a
// biblioteca já mostrava e desfazia se falhasse); até 1 s nada pisca; passou disso, um aviso girando no canto; falhou, o aviso fica com o
// motivo e "Tentar de novo" até fechar.

import { Toasts } from '@/components/ui/Toasts'
import { SHOW_AFTER_MS, unheld } from '@/lib/working'
import { useBlockingStore } from '@/stores/blocking'
import { useUiStore } from '@/stores/ui'

const later = <T,>() => {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((ok, no) => ((resolve = ok), (reject = no)))
  return { promise, resolve, reject }
}

beforeEach(() => {
  vi.useFakeTimers()
  useUiStore.setState({ toasts: [] })
  useBlockingStore.setState({ ops: [] })
  render(
    <MemoryRouter>
      <Toasts />
    </MemoryRouter>,
  )
})

afterEach(() => vi.useRealTimers())

describe('a operação de um item não segura o app (T194)', () => {
  it('rápida (menos de 1 s): nada pisca; no fim, só o aviso de pronto', async () => {
    const work = later<void>()
    const running = unheld('Apagando "Limites"…', () => work.promise, { done: '"Limites" foi para a lixeira' })
    expect(useBlockingStore.getState().ops).toHaveLength(0)
    await act(async () => void vi.advanceTimersByTime(SHOW_AFTER_MS - 100))
    expect(screen.queryByText('Apagando "Limites"…')).toBeNull()
    await act(async () => work.resolve())
    expect(await running).toBe(true)
    expect(screen.getByText('"Limites" foi para a lixeira')).toBeInTheDocument()
  })

  it('demorou mais de 1 s: o aviso girando aparece no canto, sem a janela do meio, e sai quando acaba', async () => {
    const work = later<void>()
    const running = unheld('Apagando "Limites"…', () => work.promise, { done: '"Limites" foi para a lixeira' })
    await act(async () => void vi.advanceTimersByTime(SHOW_AFTER_MS + 10))
    expect(screen.getByText('Apagando "Limites"…')).toBeInTheDocument()
    expect(useBlockingStore.getState().ops).toHaveLength(0)
    await act(async () => work.resolve())
    await running
    expect(screen.queryByText('Apagando "Limites"…')).toBeNull()
    expect(screen.getByText('"Limites" foi para a lixeira')).toBeInTheDocument()
  })

  it('falhou: o aviso fica com o motivo até fechar (não some sozinho), e "Tentar de novo" faz de novo', async () => {
    let attempts = 0
    const work = vi.fn(async () => {
      if (attempts++ === 0) throw new Error('o Drive não respondeu')
    })
    expect(await unheld('Apagando "Limites"…', work, { done: '"Limites" foi para a lixeira', failed: 'Não deu para apagar "Limites"' })).toBe(false)
    const failure = screen.getByRole('alert')
    expect(failure).toHaveTextContent('Não deu para apagar "Limites": o Drive não respondeu')
    await act(async () => void vi.advanceTimersByTime(60_000))
    expect(screen.getByRole('alert')).toBeInTheDocument()
    await act(async () => void fireEvent.click(screen.getByRole('button', { name: 'Tentar de novo' })))
    expect(work).toHaveBeenCalledTimes(2)
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.getByText('"Limites" foi para a lixeira')).toBeInTheDocument()
  })

  it('"Fechar o aviso" tira a falha', async () => {
    await unheld('Apagando "Limites"…', async () => Promise.reject(new Error('o Drive não respondeu')))
    expect(screen.getByRole('alert')).toHaveTextContent('Apagando "Limites" não terminou: o Drive não respondeu')
    fireEvent.click(screen.getByRole('button', { name: 'Fechar o aviso' }))
    expect(screen.queryByRole('alert')).toBeNull()
  })
})
