import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'

import { BlockingWindow } from '@/components/ui/BlockingWindow'
import { blocking } from '@/lib/blocking'
import { working } from '@/lib/working'
import { type BlockingOp, timeLeft, useBlockingStore } from '@/stores/blocking'
import { useJobsStore } from '@/stores/jobs'
import { useSyncStore } from '@/stores/sync'
import { useUiStore } from '@/stores/ui'
import { deferred } from '@/test/feedback/slow'

// Escolha F do dono (21/11/2026): toda operação que a pessoa espera abre uma janela no meio da tela, com a barra, quantos de quantos,
// quanto falta e Cancelar quando dá para parar; enquanto ela está aberta o app não recebe clique nem tecla.

const flush = () => act(async () => await Promise.resolve())

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true })
  useBlockingStore.setState({ ops: [] })
  useJobsStore.setState({ jobs: [], live: {}, proposals: [] })
  useUiStore.setState({ toasts: [] })
})
afterEach(() => {
  vi.useRealTimers()
})

function app(onEscape = vi.fn()) {
  const view = render(
    <>
      <main>
        <button onClick={onEscape}>Botão do app</button>
      </main>
      <BlockingWindow />
    </>,
  )
  window.addEventListener('keydown', event => event.key === 'Escape' && onEscape())
  return view
}

describe('A janela que trava o app', () => {
  it('trava na hora do clique, aparece no meio depois de um instante e some quando a operação acaba', async () => {
    app()
    const gate = deferred()
    let finished = false
    void blocking('Levando para o App', async () => {
      await gate.promise
      finished = true
    })
    await flush()
    // already holding the app (no click passes), the window itself still hidden so a quick one does not blink
    expect(document.querySelector('.blk-layer')).not.toBeNull()
    expect(screen.queryByRole('alertdialog')).toBeNull()
    await act(async () => vi.advanceTimersByTime(350))
    const window_ = screen.getByRole('alertdialog', { name: 'Levando para o App' })
    expect(window_).toHaveAttribute('aria-busy', 'true')
    await act(async () => {
      gate.resolve()
      await gate.promise
    })
    expect(finished).toBe(true)
    expect(screen.queryByRole('alertdialog')).toBeNull()
    expect(document.querySelector('.blk-layer')).toBeNull()
  })

  it('mostra a etapa, "478 de 1.284", o tamanho, o item da vez e a barra com o número', async () => {
    app()
    const gate = deferred()
    void blocking('Levando para o App', async blocker => {
      blocker.progress({ phase: 'Copiando as notas', done: 478, total: 1284, doneBytes: 1.1e9, totalBytes: 3.2e9, current: 'Aula 12 · Derivadas' })
      await gate.promise
    })
    await act(async () => vi.advanceTimersByTime(350))
    const window_ = screen.getByRole('alertdialog')
    expect(window_).toHaveTextContent('Copiando as notas')
    expect(window_).toHaveTextContent('478 de 1.284')
    expect(window_).toHaveTextContent('Aula 12 · Derivadas')
    const bar = screen.getByRole('progressbar')
    expect(bar).toHaveAttribute('aria-valuenow', '34')
    expect(bar).toHaveAttribute('aria-valuetext', '478 de 1.284')
    gate.resolve()
  })

  it('sem total, a barra corre sem número', async () => {
    app()
    const gate = deferred()
    void blocking('Apagando a mídia', () => gate.promise)
    await act(async () => vi.advanceTimersByTime(350))
    expect(screen.getByRole('progressbar')).not.toHaveAttribute('aria-valuenow')
    gate.resolve()
  })

  it('Cancelar só aparece quando dá para parar; vira "Cancelando…" e avisa a operação', async () => {
    app()
    const gate = deferred()
    let seen = false
    void blocking(
      'Levando para o App',
      async blocker => {
        await gate.promise
        seen = blocker.cancelled && blocker.signal.aborted
      },
      { cancellable: true },
    )
    await act(async () => vi.advanceTimersByTime(350))
    fireEvent.click(screen.getByRole('button', { name: 'Cancelar' }))
    expect(screen.getByRole('button', { name: 'Cancelando…' })).toBeDisabled()
    await act(async () => {
      gate.resolve()
      await gate.promise
    })
    expect(seen).toBe(true)

    const other = deferred()
    void blocking('Apagando a mídia', () => other.promise)
    await act(async () => vi.advanceTimersByTime(350))
    expect(screen.queryByRole('button', { name: 'Cancelar' })).toBeNull()
    other.resolve()
  })

  it('as teclas não chegam ao app: Esc não fecha a janela de baixo; com Cancelar, Esc cancela', async () => {
    const onEscape = vi.fn()
    app(onEscape)
    const gate = deferred()
    void blocking('Apagando a mídia', () => gate.promise)
    await act(async () => vi.advanceTimersByTime(350))
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' })
    expect(onEscape).not.toHaveBeenCalled()
    expect(screen.getByRole('alertdialog')).toBeInTheDocument()
    gate.resolve()
    await flush()

    const stoppable = deferred()
    let cancelled = false
    void blocking(
      'Levando para o App',
      async blocker => {
        await stoppable.promise
        cancelled = blocker.cancelled
      },
      { cancellable: true },
    )
    await act(async () => vi.advanceTimersByTime(350))
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' })
    expect(onEscape).not.toHaveBeenCalled()
    await act(async () => {
      stoppable.resolve()
      await stoppable.promise
    })
    expect(cancelled).toBe(true)
  })

  // the page is held from the click: the layer takes every tap, no key reaches the app, and the rest of the page leaves the screen
  // reader (aria-hidden), the focus waiting in the window. Not with "inert": the browser restyled the whole page to put it and again to
  // take it, ~0.3 s on the phone at each move or delete (spec 007, T047)
  it('o resto da página fica de fora enquanto a janela está aberta, e volta depois', async () => {
    const { container } = app()
    const gate = deferred()
    void blocking('Apagando a mídia', () => gate.promise)
    await flush()
    expect(container).toHaveAttribute('aria-hidden', 'true')
    expect(container).not.toHaveAttribute('inert')
    expect(document.querySelector('.blk-layer')).toHaveFocus()
    await act(async () => {
      gate.resolve()
      await gate.promise
    })
    expect(container).not.toHaveAttribute('aria-hidden')
  })

  it('uma falha volta para quem chamou e a janela fecha', async () => {
    app()
    await expect(blocking('Apagando a mídia', async () => Promise.reject(new Error('O Drive não respondeu.')))).rejects.toThrow('O Drive não respondeu.')
    expect(useBlockingStore.getState().ops).toHaveLength(0)
  })

  it('"done" diz o fim num aviso', async () => {
    app()
    await blocking('Levando para o App', async () => undefined, { done: 'Pronto: 3 itens no App' })
    expect(useUiStore.getState().toasts.map(toast => toast.text)).toContain('Pronto: 3 itens no App')
  })
})

describe('Um conflito no meio de uma operação', () => {
  // a write inside the operation may ask the person which version stays: that window must be answerable, or the app would hang
  const conflict = { kind: 'text', fileId: 'f1', name: 'Limites', mine: 'a', theirs: 'b' } as never

  it('a janela sai da frente enquanto o conflito pergunta, e volta depois da resposta', async () => {
    const { container } = app()
    useSyncStore.setState({ conflicts: [], conflictsHidden: false })
    const gate = deferred()
    void blocking('Apagando a mídia', () => gate.promise)
    await act(async () => vi.advanceTimersByTime(350))
    expect(screen.getByRole('alertdialog')).toBeInTheDocument()
    let answer: Promise<unknown> = Promise.resolve()
    await act(async () => {
      answer = useSyncStore.getState().askConflict(conflict)
    })
    expect(screen.queryByRole('alertdialog')).toBeNull()
    expect(container).not.toHaveAttribute('aria-hidden')
    await act(async () => useSyncStore.getState().settleConflict(useSyncStore.getState().conflicts[0].id, conflict))
    await answer
    expect(screen.getByRole('alertdialog')).toBeInTheDocument()
    expect(container).toHaveAttribute('aria-hidden', 'true')
    gate.resolve()
  })

  it('com o conflito deixado para depois, a janela diz que espera por ele e oferece resolver', async () => {
    app()
    useSyncStore.setState({ conflicts: [], conflictsHidden: false })
    const gate = deferred()
    void blocking('Apagando a mídia', () => gate.promise)
    await act(async () => {
      void useSyncStore.getState().askConflict(conflict)
      useSyncStore.getState().hideConflicts()
    })
    await act(async () => vi.advanceTimersByTime(350))
    expect(screen.getByRole('alertdialog')).toHaveTextContent('Esperando você resolver um conflito')
    fireEvent.click(screen.getByRole('button', { name: 'Resolver o conflito' }))
    expect(useSyncStore.getState().conflictsHidden).toBe(false)
    expect(screen.queryByRole('alertdialog')).toBeNull()
    useSyncStore.setState({ conflicts: [], conflictsHidden: false })
    gate.resolve()
  })
})

describe('working(): as ações que antes iam para Tarefas agora abrem a janela', () => {
  it('abre a janela (e não uma linha em Tarefas) e fecha no fim', async () => {
    app()
    const gate = deferred()
    const result = working('Esvaziando a lixeira…', () => gate.promise, { message: 'Apagando 12 itens de vez' })
    await act(async () => vi.advanceTimersByTime(350))
    expect(screen.getByRole('alertdialog', { name: 'Esvaziando a lixeira…' })).toHaveTextContent('Apagando 12 itens de vez')
    expect(useJobsStore.getState().jobs).toHaveLength(0)
    gate.resolve()
    await expect(result).resolves.toBe(true)
    expect(screen.queryByRole('alertdialog')).toBeNull()
  })

  it('numa falha a janela fica com o motivo até "Fechar", e devolve false', async () => {
    app()
    const ok = await working('Apagando "Limites"…', () => Promise.reject(new Error('O Drive não respondeu.')))
    expect(ok).toBe(false)
    await act(async () => vi.advanceTimersByTime(350))
    const window_ = screen.getByRole('alertdialog', { name: 'Apagando "Limites"…' })
    expect(window_).toHaveTextContent('O Drive não respondeu.')
    expect(screen.queryByRole('progressbar')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Fechar' }))
    expect(screen.queryByRole('alertdialog')).toBeNull()
  })
})

describe('Quanto falta', () => {
  const op = (patch: Partial<BlockingOp>): BlockingOp => ({ id: 'x', title: 't', startedAt: 0, countedAt: 0, countedFrom: 0, countedBytesFrom: 0, cancellable: false, cancelling: false, ...patch })

  it('pelo ritmo da etapa: 100 de 1.000 em 1 min → faltam ~9 min', () => {
    expect(timeLeft(op({ done: 100, total: 1000 }), 60_000)).toBe('faltam ~9 min')
  })
  it('pelos bytes quando a etapa mede tamanho', () => {
    expect(timeLeft(op({ done: 1, total: 10, doneBytes: 1e9, totalBytes: 3e9 }), 120_000)).toBe('faltam ~4 min')
  })
  it('nada enquanto é cedo para dizer (menos de 3 s ou de 2 itens)', () => {
    expect(timeLeft(op({ done: 1, total: 100 }), 60_000)).toBeNull()
    expect(timeLeft(op({ done: 50, total: 100 }), 2000)).toBeNull()
  })
  it('pelos bytes também numa etapa sem contagem de itens (a mídia de uma nota indo para outro lugar)', () => {
    expect(timeLeft(op({ doneBytes: 1e8, totalBytes: 4e8 }), 60_000)).toBe('faltam ~3 min')
  })
  it('perto do fim: alguns segundos; muito: horas', () => {
    expect(timeLeft(op({ done: 90, total: 100 }), 90_000)).toBe('faltam alguns segundos')
    expect(timeLeft(op({ done: 10, total: 1000 }), 60_000)).toBe('faltam ~1 h 39 min')
  })
})
