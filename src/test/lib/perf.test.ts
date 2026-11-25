import '@/test/account/storage-shim'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { aoMedir, comeca, ligarMedidas, medidas, medindo, termina } from '@/lib/perf'

// As marcas de cada operação da Lista de operações (spec 007, FR-001, research R1): do clique ao primeiro quadro pintado depois do
// resultado. Fora do painel de medidas e do Playwright, não gravam nada e não custam nada.

const frame = async () => {
  await vi.advanceTimersByTimeAsync(40)
}

beforeEach(() => {
  vi.useFakeTimers()
  ligarMedidas(false)
  performance.clearMarks()
  performance.clearMeasures()
})
afterEach(() => {
  vi.useRealTimers()
  ligarMedidas(false)
})

describe('desligadas', () => {
  it('não gravam marca nem medida', async () => {
    const mark = vi.spyOn(performance, 'mark')
    comeca('abrir-nota-texto')
    termina('abrir-nota-texto')
    await frame()
    expect(mark).not.toHaveBeenCalled()
    expect(medidas()).toEqual([])
    mark.mockRestore()
  })
})

describe('ligadas', () => {
  beforeEach(() => ligarMedidas(true))

  it('medem do clique ao quadro pintado depois do resultado', async () => {
    expect(medindo()).toBe(true)
    // o jsdom não guarda `performance.measure`: confere as marcas que o Chrome usa para a linha do tempo
    const mark = vi.spyOn(performance, 'mark')
    comeca('abrir-nota-texto')
    await vi.advanceTimersByTimeAsync(120)
    termina('abrir-nota-texto')
    // ainda não pintou: a medida só fecha depois do quadro
    expect(medidas()).toEqual([])
    await frame()
    const [medida] = medidas()
    expect(medida.op).toBe('abrir-nota-texto')
    expect(medida.ms).toBeGreaterThanOrEqual(120)
    expect(mark.mock.calls.map(call => call[0])).toEqual(['op:abrir-nota-texto:start', 'op:abrir-nota-texto:end'])
    mark.mockRestore()
  })

  it('termina sem começar não mede nada; começar de novo vale o último clique', async () => {
    termina('renomear')
    await frame()
    expect(medidas()).toEqual([])
    comeca('renomear')
    await vi.advanceTimersByTimeAsync(500)
    comeca('renomear')
    await vi.advanceTimersByTimeAsync(40)
    termina('renomear')
    await frame()
    expect(medidas()).toHaveLength(1)
    expect(medidas()[0].ms).toBeLessThan(400)
  })

  it('avisa quem acompanha (o painel de medidas)', async () => {
    const ouvir = vi.fn()
    const parar = aoMedir(ouvir)
    comeca('buscar')
    termina('buscar')
    await frame()
    expect(ouvir).toHaveBeenCalledWith(expect.objectContaining({ op: 'buscar' }))
    parar()
    comeca('buscar')
    termina('buscar')
    await frame()
    expect(ouvir).toHaveBeenCalledTimes(1)
  })

  it('deixa as medidas à mão do Playwright', async () => {
    comeca('tela-biblioteca')
    termina('tela-biblioteca')
    await frame()
    expect((window as unknown as { __ESTUDO_MEDIDAS__: unknown[] }).__ESTUDO_MEDIDAS__).toHaveLength(1)
  })
})

describe('como ligam', () => {
  it('com ?medidas no endereço, ou com o sinal do Playwright', async () => {
    vi.resetModules()
    window.history.replaceState(null, '', '/?medidas')
    const viaEndereco = await import('@/lib/perf')
    expect(viaEndereco.medindo()).toBe(true)
    window.history.replaceState(null, '', '/')
    sessionStorage.clear()
    vi.resetModules()
    ;(window as unknown as { __ESTUDO_MEDIR__?: boolean }).__ESTUDO_MEDIR__ = true
    const viaPlaywright = await import('@/lib/perf')
    expect(viaPlaywright.medindo()).toBe(true)
    delete (window as unknown as { __ESTUDO_MEDIR__?: boolean }).__ESTUDO_MEDIR__
    vi.resetModules()
    const nenhum = await import('@/lib/perf')
    expect(nenhum.medindo()).toBe(false)
  })
})
