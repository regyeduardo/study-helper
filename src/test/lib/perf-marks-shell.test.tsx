import '@/test/account/storage-shim'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, render, screen } from '@testing-library/react'
import { MemoryRouter, Route, Routes, useNavigate } from 'react-router-dom'

import { ligarMedidas, medidas } from '@/lib/perf'
import { marcarRotas, opDaRota, useFimDaRota } from '@/lib/perf-routes'

// Marcas de trocar de tela e abrir pasta (spec 007, T016): começam quando o endereço muda e terminam no quadro depois de a tela nova
// aparecer.

describe('opDaRota', () => {
  it('dá a operação de cada tela', () => {
    expect(opDaRota('/')).toBe('tela-biblioteca')
    expect(opDaRota('/biblioteca')).toBe('tela-biblioteca')
    expect(opDaRota('/biblioteca/pasta-1')).toBe('abrir-pasta')
    expect(opDaRota('/gravacoes')).toBe('tela-gravacoes')
    expect(opDaRota('/geracoes')).toBe('tela-geracoes')
    expect(opDaRota('/idiomas')).toBe('tela-idiomas')
    expect(opDaRota('/administracao')).toBe('tela-admin')
    expect(opDaRota('/arquivo/nota-1')).toBeNull()
  })
})

describe('no roteador', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    ligarMedidas(true)
  })
  afterEach(() => {
    vi.useRealTimers()
    ligarMedidas(false)
  })

  function Shell() {
    useFimDaRota()
    const navigate = useNavigate()
    return (
      <>
        <button onClick={() => navigate('/gravacoes')}>Gravações</button>
        <button onClick={() => navigate('/biblioteca/pasta-1')}>Pasta</button>
        <Routes>
          <Route path="/" element={<p>Início</p>} />
          <Route path="/gravacoes" element={<p>Lista de gravações</p>} />
          <Route path="/biblioteca/:id" element={<p>Notas da pasta</p>} />
        </Routes>
      </>
    )
  }

  it('mede da troca do endereço ao quadro depois da tela nova', async () => {
    // o roteador de dados avisa a troca do endereço (aqui, falso: o clique no Link do roteador de dados quebra no jsdom)
    let listener: (state: { location: { pathname: string } }) => void = () => undefined
    const router = { state: { location: { pathname: '/' } }, subscribe: (fn: typeof listener) => ((listener = fn), () => undefined) }
    marcarRotas(router)
    render(
      <MemoryRouter initialEntries={['/']}>
        <Shell />
      </MemoryRouter>,
    )
    for (const [button, path] of [['Gravações', '/gravacoes'], ['Pasta', '/biblioteca/pasta-1']]) {
      listener({ location: { pathname: path } })
      await act(async () => {
        screen.getByText(button).click()
      })
    }
    expect(screen.getByText('Notas da pasta')).toBeInTheDocument()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(50)
    })
    expect(medidas().map(medida => medida.op)).toEqual(['tela-gravacoes', 'abrir-pasta'])
  })
})
