import { describe, expect, it } from 'vitest'

import type { ArtifactSummary, FileMeta } from '@/types/domain'
import { newFileMeta } from '@/lib/defaults'
import { badgeOf, descendantsOf, familyCount, isNote, motherOf } from '@/lib/family'

describe('isNote: uma entrada não é nota', () => {
  it('um item com o papel de entrada não é nota', () => {
    expect(isNote(newFileMeta({ name: 'aula.mp4', type: 'reading', role: 'entrada', kept: 'arquivo' }))).toBe(false)
  })

  it('sem papel, é nota: todo item de hoje, inclusive o lido de um aparelho antigo', () => {
    expect(isNote(newFileMeta({ name: 'Limites', type: 'class' }))).toBe(true)
    const old = JSON.parse(JSON.stringify(newFileMeta({ name: 'Antiga', type: 'reading' }))) as FileMeta
    delete old.role
    expect(isNote(old)).toBe(true)
  })
})

/* ---------- T042: árvore, contagens e selo ---------- */

const art = (id: string, kind: ArtifactSummary['kind'] = 'mapa'): ArtifactSummary => ({ id, kind, name: id, updatedAt: '2026-11-07T10:00:00Z' })

function item(id: string, fields: Partial<FileMeta> = {}): FileMeta {
  return newFileMeta({ id, name: id, type: 'class', ...fields })
}

/** A PDF entrada in "Cálculo", an Aula there, an Explicação in "Física", and a nota filha of the Aula in "Revisão". */
function library(): FileMeta[] {
  return [
    item('pdf', { role: 'entrada', kept: 'arquivo', folderId: 'calculo', origin: { input: 'file', name: 'limites.pdf', storage: 'drive', storedFileId: 'drv' } }),
    item('aula', { parentFileId: 'pdf', folderId: 'calculo', artifacts: [art('m1'), art('c1', 'cartoes')] }),
    item('exp', { parentFileId: 'pdf', folderId: 'fisica', artifacts: [art('m2')] }),
    item('filha', { parentFileId: 'aula', folderId: 'revisao', artifacts: [art('t1', 'tutor')] }),
    item('solta', { folderId: 'calculo', artifacts: [art('m3')] }),
  ]
}

describe('descendentes', () => {
  it('traz a família inteira, em qualquer pasta, sem o próprio item', () => {
    expect(descendantsOf(library(), 'pdf').map(file => file.id).sort()).toEqual(['aula', 'exp', 'filha'])
    expect(descendantsOf(library(), 'aula').map(file => file.id)).toEqual(['filha'])
    expect(descendantsOf(library(), 'solta')).toEqual([])
  })

  it('deixa de fora o que está na Lixeira, a não ser quando pedido', () => {
    const files = library().map(file => (file.id === 'aula' ? { ...file, deletedAt: '2026-11-07T11:00:00Z' } : file))
    expect(descendantsOf(files, 'pdf').map(file => file.id)).toEqual(['exp'])
    expect(descendantsOf(files, 'pdf', { trashed: true }).map(file => file.id).sort()).toEqual(['aula', 'exp', 'filha'])
  })

  it('um ciclo nos dados não trava nem repete ninguém', () => {
    const files = [item('a', { parentFileId: 'c' }), item('b', { parentFileId: 'a' }), item('c', { parentFileId: 'b' })]
    expect(descendantsOf(files, 'a').map(file => file.id).sort()).toEqual(['b', 'c'])
    expect(familyCount(files, 'a')).toEqual({ notes: 2, artifacts: 0 })
  })
})

describe('contagem', () => {
  it('soma as notas e os artefatos de todos os descendentes', () => {
    expect(familyCount(library(), 'pdf')).toEqual({ notes: 3, artifacts: 4 })
    expect(familyCount(library(), 'aula')).toEqual({ notes: 1, artifacts: 1 })
    expect(familyCount(library(), 'solta')).toEqual({ notes: 0, artifacts: 0 })
  })

  it('a transcrição faz parte da entrada de mídia: não conta como nota', () => {
    const files = [
      item('video', { role: 'entrada', kept: 'arquivo', type: 'reading', words: 900, origin: { input: 'recording', name: 'reuniao.webm', mime: 'audio/webm', storage: 'none' } }),
      item('ata', { parentFileId: 'video', type: 'meeting' }),
    ]
    expect(familyCount(files, 'video')).toEqual({ notes: 1, artifacts: 0 })
  })

  it('não conta o que está na Lixeira', () => {
    const files = library().map(file => (file.id === 'exp' ? { ...file, deletedAt: '2026-11-07T11:00:00Z' } : file))
    expect(familyCount(files, 'pdf')).toEqual({ notes: 2, artifacts: 3 })
  })
})

describe('mãe e selo "de: <mãe>"', () => {
  it('a mãe é a entrada ou a nota de onde o item nasceu', () => {
    expect(motherOf(library(), library()[3])?.id).toBe('aula')
    expect(motherOf(library(), library()[1])?.id).toBe('pdf')
    expect(motherOf(library(), library()[4])).toBeNull()
  })

  it('aparece quando a mãe está em outra pasta; na mesma pasta, não', () => {
    const files = library()
    expect(badgeOf(files, files.find(file => file.id === 'exp')!)).toEqual({ mother: files[0], trashed: false })
    expect(badgeOf(files, files.find(file => file.id === 'filha')!)?.mother?.id).toBe('aula')
    expect(badgeOf(files, files.find(file => file.id === 'aula')!)).toBeNull()
    expect(badgeOf(files, files.find(file => file.id === 'solta')!)).toBeNull()
  })

  it('com a mãe na Lixeira, o selo diz que ela foi apagada, mesmo na mesma pasta', () => {
    const files = library().map(file => (file.id === 'pdf' ? { ...file, deletedAt: '2026-11-07T11:00:00Z' } : file))
    expect(badgeOf(files, files.find(file => file.id === 'aula')!)).toEqual({ mother: files[0], trashed: true })
  })

  it('a mãe apagada para sempre dá o selo de mãe apagada, sem a mãe', () => {
    const files = library().filter(file => file.id !== 'pdf')
    expect(badgeOf(files, files.find(file => file.id === 'exp')!)).toEqual({ mother: null, trashed: true })
    expect(badgeOf(files, files.find(file => file.id === 'solta')!)).toBeNull()
  })
})

describe('memorização pela versão da lista', () => {
  it('a mesma lista não é percorrida de novo; uma lista nova, sim', () => {
    const files = library()
    const first = descendantsOf(files, 'pdf')
    expect(descendantsOf(files, 'pdf')).toBe(first)
    const changed = [...files, item('nova', { parentFileId: 'pdf' })]
    expect(descendantsOf(changed, 'pdf').map(file => file.id)).toContain('nova')
  })
})
