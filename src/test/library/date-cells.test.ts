// Spec 007 (T047, medida do celular de 26/11): a data de cada linha (Criado e Atualizado) sai de formatadores feitos uma vez por fuso,
// não a cada célula. Com 100 gravações, a tela Gravações fazia 600 formatadores ao abrir: 261 ms dos ~600 ms de desenho no celular.
// O texto continua o mesmo: "Hoje" ou dd/mm/aaaa, e a hora hh:mm, no fuso da pessoa.
import { afterEach, expect, it, vi } from 'vitest'

import { dayAndTime } from '@/components/library/FileRows'

afterEach(() => vi.restoreAllMocks())

it('escreve o dia e a hora no fuso da pessoa', () => {
  expect(dayAndTime('2026-10-20T10:00:00Z', 'America/Sao_Paulo')).toEqual({ day: '20/10/2026', time: '07:00' })
  expect(dayAndTime('2026-10-20T20:30:00Z', 'Asia/Tokyo')).toEqual({ day: '21/10/2026', time: '05:30' })
})

it('o que é de hoje diz "Hoje"', () => {
  expect(dayAndTime(new Date().toISOString(), 'America/Sao_Paulo').day).toBe('Hoje')
})

it('uma data inválida não derruba a linha: diz o mesmo de antes', () => {
  expect(dayAndTime('não é data', 'America/Sao_Paulo')).toEqual({ day: 'Invalid Date', time: 'Invalid Date' })
})

it('200 células fazem os formatadores uma vez por fuso, não um a cada célula', () => {
  const day = vi.spyOn(Date.prototype, 'toLocaleDateString')
  const time = vi.spyOn(Date.prototype, 'toLocaleTimeString')
  const made = vi.spyOn(Intl, 'DateTimeFormat')
  for (let i = 0; i < 200; i++) dayAndTime(new Date(Date.UTC(2026, 9, 1 + (i % 28), i % 24)).toISOString(), 'Europe/Lisbon')
  expect(day).not.toHaveBeenCalled()
  expect(time).not.toHaveBeenCalled()
  expect(made.mock.calls.length).toBeLessThanOrEqual(2)
})
