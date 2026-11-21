// História 10 (003): uma biblioteca de antes abre sem nenhuma reescrita; as entradas são lidas como notas do seu tipo.
import { describe, expect, it, vi } from 'vitest'

import type { FileMeta, FileSidecar, Snapshot, SourceMeta } from '@/types/domain'
import { defaultIndex, newFileMeta } from '@/lib/defaults'
import { migrateEntries } from '@/lib/entry-migration'
import { familyCount } from '@/lib/family'
import { isSourceNote, noteTypeOf } from '@/lib/file-types'
import type { Repository } from '@/lib/storage/repository'

const source = (fields: Partial<SourceMeta> & Pick<SourceMeta, 'input'>): SourceMeta => ({ name: 'x', storage: 'none', ...fields })

function spyRepo(files: FileMeta[]) {
  const saveFile = vi.fn(async (sidecar: FileSidecar) => sidecar)
  const putSource = vi.fn(async () => ({ ref: 'x' }))
  const saveIndex = vi.fn(async () => undefined)
  const repo = {
    readContent: async () => 'texto próprio da nota',
    readSidecar: async (id: string) => ({ meta: files.find(file => file.id === id)!, questions: [], attempts: [], highlights: [] }),
    saveFile,
    putSource,
    saveIndex,
  } as unknown as Repository
  return { repo, saveFile, putSource, saveIndex }
}

const snapshotOf = (files: FileMeta[], migrated: boolean): Snapshot => ({ folders: [], files, index: { ...defaultIndex(), ...(migrated ? { entriesMigratedAt: '2026-11-08T10:00:00Z' } : {}) } }) as Snapshot

const OLD_VIDEO = newFileMeta({ id: 'video', name: 'kickoff.mp4', type: 'reading', role: 'entrada', kept: 'arquivo', origin: source({ input: 'file', mime: 'video/mp4' }) })
const OLD_PDF = newFileMeta({ id: 'pdf', name: 'contrato.pdf', type: 'reading', role: 'entrada', kept: 'registro', origin: source({ input: 'file', mime: 'application/pdf' }) })
const ATA = newFileMeta({ id: 'ata', name: 'Ata', type: 'meeting', parentFileId: 'video', artifacts: [{ id: 'm', kind: 'mapa', name: 'Mapa', updatedAt: '2026-11-08T10:00:00Z' }] })
const LESSON = newFileMeta({ id: 'aula', name: 'Aula', type: 'class', parentFileId: 'pdf' })

describe('biblioteca de antes', () => {
  it('abre sem gravar nada: nenhum item, nenhuma cópia, nenhum índice', async () => {
    const files = [OLD_VIDEO, OLD_PDF, ATA, LESSON]
    const spy = spyRepo(files)
    const snapshot = snapshotOf(files, true)
    expect(await migrateEntries(spy.repo, snapshot)).toBe(snapshot)
    expect(spy.saveFile).not.toHaveBeenCalled()
    expect(spy.putSource).not.toHaveBeenCalled()
    expect(spy.saveIndex).not.toHaveBeenCalled()
  })

  it('cada entrada é lida como nota do seu tipo, com a mesma família e os mesmos artefatos', () => {
    const files = [OLD_VIDEO, OLD_PDF, ATA, LESSON]
    expect(files.filter(isSourceNote).map(noteTypeOf)).toEqual(['video', 'pdf'])
    expect(familyCount(files, 'video')).toEqual({ notes: 1, artifacts: 1 })
    expect(familyCount(files, 'pdf')).toEqual({ notes: 1, artifacts: 0 })
    expect(OLD_VIDEO.role).toBe('entrada')
  })

  it('uma nota de fonte feita agora, sem role, não ganha entrada nova da migração antiga', async () => {
    const video = newFileMeta({ id: 'novo', name: 'reuniao.webm', type: 'video', kept: 'registro', origin: source({ input: 'recording', mime: 'video/webm' }) })
    const spy = spyRepo([video])
    const result = await migrateEntries(spy.repo, snapshotOf([video], false))
    expect(result.files).toEqual([video])
    expect(spy.saveFile).not.toHaveBeenCalled()
    expect(spy.putSource).not.toHaveBeenCalled()
  })
})
