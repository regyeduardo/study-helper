// Spec 005, FR-022 (T052; dono, 25/11: "Juntar"): as repetições de antes da regra, desfeitas uma vez. Pastas de mesmo nome na mesma
// pasta viram uma só (o conteúdo vai para a mais antiga, juntando também as subpastas de mesmo nome; a vazia vai para a Lixeira); notas
// de mesmo nome ficam, e a mais nova ganha " (2)". O mesmo cenário do teste do servidor (names_repair_test.go).
import { describe, expect, it } from 'vitest'

import type { FileMeta, FolderMeta } from '@/types/domain'
import { newFileMeta, newFolderMeta } from '@/lib/defaults'
import { planNameRepair } from '@/lib/names-repair'

const at = (iso: string) => ({ at: iso, deviceId: 'd', deviceName: 'Notebook' })
const folder = (id: string, name: string, parentId: string | null, created: string, deletedAt: string | null = null): FolderMeta =>
  newFolderMeta({ id, name, parentId, created: at(created), updated: at(created), deletedAt })
const note = (id: string, name: string, folderId: string | null, created: string): FileMeta => newFileMeta({ id, name, type: 'class', folderId, created: at(created), updated: at(created) })

const FOLDERS = [
  folder('vp6', 'VP6', null, '2026-11-01T10:00:00Z'),
  folder('hm-a', 'HM', 'vp6', '2026-11-02T10:00:00Z'),
  folder('hm-b', 'hm ', 'vp6', '2026-11-03T10:00:00Z'),
  folder('hm-lixo', 'HM', 'vp6', '2026-11-01T09:00:00Z', '2026-11-24T10:00:00Z'),
  folder('aulas-a', 'Aulas', 'hm-a', '2026-11-02T11:00:00Z'),
  folder('aulas-b', 'aulas', 'hm-b', '2026-11-03T11:00:00Z'),
]
const FILES = [
  note('resumo-a', 'Resumo', 'hm-a', '2026-11-02T12:00:00Z'),
  note('resumo-b', 'Resumo', 'hm-b', '2026-11-03T12:00:00Z'),
  note('outra', 'Outra', 'hm-b', '2026-11-03T13:00:00Z'),
  note('aula1-a', 'Aula 1', 'aulas-a', '2026-11-02T13:00:00Z'),
  note('aula1-b', 'aula 1', 'aulas-b', '2026-11-03T14:00:00Z'),
  note('plano-1', 'Plano', null, '2026-11-01T10:00:00Z'),
  note('plano-2', 'Plano', null, '2026-11-05T10:00:00Z'),
  note('plano-3', 'Plano (2)', null, '2026-11-04T10:00:00Z'),
]

describe('juntar as repetições de antes da regra', () => {
  it('as pastas iguais viram a mais antiga, juntando as de dentro; a vazia vai para a Lixeira; a nota mais nova ganha número', () => {
    const plan = planNameRepair(FOLDERS, FILES)
    expect(plan.folders).toEqual([
      { id: 'hm-b', parentId: 'vp6', trash: true },
      { id: 'aulas-b', parentId: 'hm-a', trash: true },
    ])
    expect(Object.fromEntries(plan.files.map(file => [file.id, [file.folderId, file.name]]))).toEqual({
      'resumo-b': ['hm-a', 'Resumo (2)'],
      outra: ['hm-a', 'Outra'],
      'aula1-b': ['aulas-a', 'aula 1 (2)'],
      'plano-2': [null, 'Plano (3)'],
    })
  })

  it('sem repetição, nada a fazer; e o que a Lixeira tem não conta', () => {
    expect(planNameRepair([FOLDERS[0], FOLDERS[1], FOLDERS[3]], [FILES[0], FILES[5]])).toEqual({ folders: [], files: [] })
  })
})
