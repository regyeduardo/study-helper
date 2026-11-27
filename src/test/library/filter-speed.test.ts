// Spec 007 (T047, medida do celular de 26/11): a tela Gravações filtra só as gravações (100 de 1.000 notas), mas o filtro calculava o
// dia de todas as 1.000, a cada desenho (29 ms dos ~60 ms do filtro no celular). Agora o dia é calculado só do que a tela mostra, e uma
// vez por data; o resultado é o mesmo (as contagens e o total da biblioteca não mudam).
import { afterEach, expect, it, vi } from 'vitest'

import type { FileMeta } from '@/types/domain'
import { newFileMeta } from '@/lib/defaults'
import { filterLibrary, NO_FILTERS } from '@/lib/library-filters'

afterEach(() => vi.restoreAllMocks())

const NOW = '2026-11-08T15:00:00Z'
const TZ = 'Europe/Madrid'
const stamp = (at: string) => ({ at, deviceId: 'd1', deviceName: 'Teste' })

// 1.000 notas, cada uma de um minuto diferente; as 100 primeiras são as da tela
const FILES: FileMeta[] = Array.from({ length: 1000 }, (_, index) => {
  const at = new Date(Date.UTC(2026, 9, 1) + index * 60_000 * 37).toISOString()
  return newFileMeta({ id: `n${index}`, name: `Nota ${index}`, type: 'class', folderId: null, created: stamp(at), updated: stamp(at) })
})
const ONLY = new Set(FILES.slice(0, 100).map(file => file.id))

it('filtrar 100 de 1.000 notas calcula o dia só das 100, e a segunda vez nenhum', () => {
  const days = vi.spyOn(Intl.DateTimeFormat.prototype, 'formatToParts')
  const first = filterLibrary({ files: FILES, folders: [], now: NOW, timeZone: TZ, only: ONLY }, NO_FILTERS)
  // the 100 shown and "hoje"
  expect(days.mock.calls.length).toBeLessThanOrEqual(101)
  days.mockClear()
  const again = filterLibrary({ files: FILES, folders: [], now: NOW, timeZone: TZ, only: ONLY }, NO_FILTERS)
  expect(days.mock.calls.length).toBeLessThanOrEqual(1)
  expect(again).toEqual(first)
  // the total stays the library's
  expect(first.total).toBe(1000)
  expect(first.shown).toBe(100)
})

it('o período continua contando pelo dia da pessoa', () => {
  const result = filterLibrary({ files: FILES, folders: [], now: NOW, timeZone: TZ, only: ONLY }, { ...NO_FILTERS, period: { from: '2026-10-01', to: '2026-10-01' } })
  // 1º de outubro em Madri: de 00:00 (22:00 UTC do dia 30) a 23:59; as notas começam 00:00 UTC (02:00 em Madri), uma a cada 37 min
  expect(result.items.map(file => file.id)).toEqual(FILES.slice(0, 100).filter(file => new Date(file.created.at).getTime() < Date.UTC(2026, 9, 1, 22)).map(file => file.id))
})
