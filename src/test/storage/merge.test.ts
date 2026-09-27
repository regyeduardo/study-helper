import { describe, it, expect } from 'vitest'
import type { Attempt, FileSidecar, Highlight, StoredQuestion } from '@/types/domain'
import { newFileMeta, newSidecar } from '@/lib/defaults'
import { applyFieldChoices, hasTextConflict, joinHunks, mergeSidecar, mergeText } from '@/lib/sync/merge'

function numbered(count: number): string[] {
  return Array.from({ length: count }, (_, index) => `linha ${index + 1}`)
}

function attempt(id: string): Attempt {
  return { id, createdAt: `2026-01-0${id.length}T00:00:00.000Z`, deviceId: 'd', total: 2, correct: 1, answers: [] }
}

function highlight(id: string, quote: string): Highlight {
  return { id, kind: 'highlight', quote, text: '', color: 'yellow', startOffset: 0, endOffset: 1, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' }
}

function question(storedId: string): StoredQuestion {
  return { storedId, enunciado: `Pergunta ${storedId}`, alternativas: { a: '1', b: '2' }, correta: 'a', explicacao: '' }
}

function baseSidecar(): FileSidecar {
  return newSidecar(newFileMeta({ name: 'Nota', type: 'reading' }))
}

describe('mergeText (3 vias)', () => {
  it('junta sozinho mudanças em lugares diferentes', () => {
    const base = numbered(10)
    const mine = [...base]
    mine[1] = 'minha linha 2'
    const theirs = [...base]
    theirs[8] = 'linha 9 do outro'
    const hunks = mergeText(base.join('\n'), mine.join('\n'), theirs.join('\n'))
    expect(hasTextConflict(hunks)).toBe(false)
    const expected = [...base]
    expected[1] = 'minha linha 2'
    expected[8] = 'linha 9 do outro'
    expect(joinHunks(hunks)).toBe(expected.join('\n'))
  })

  it('aceita o lado que mudou quando só um lado mexeu', () => {
    const base = 'a\nb\nc'
    expect(joinHunks(mergeText(base, base, 'a\nB\nc'))).toBe('a\nB\nc')
    expect(joinHunks(mergeText(base, 'a\nb\nc\nd', base))).toBe('a\nb\nc\nd')
  })

  it('mudança igual dos dois lados não é conflito', () => {
    const hunks = mergeText('a\nb\nc', 'a\nX\nc', 'a\nX\nc')
    expect(hasTextConflict(hunks)).toBe(false)
    expect(joinHunks(hunks)).toBe('a\nX\nc')
  })

  it('conflito carrega só o trecho diferente, não o arquivo inteiro', () => {
    const base = numbered(20)
    const mine = [...base]
    mine[9] = 'minha 10'
    const theirs = [...base]
    theirs[9] = 'dele 10'
    const hunks = mergeText(base.join('\n'), mine.join('\n'), theirs.join('\n'))
    const conflicts = hunks.filter(hunk => hunk.kind === 'conflict')
    expect(conflicts).toHaveLength(1)
    expect(conflicts[0]).toMatchObject({ base: ['linha 10'], mine: ['minha 10'], theirs: ['dele 10'] })
  })

  it('cada trecho em conflito vira um pedaço separado e dá para escolher pedaço por pedaço', () => {
    const base = 'a\nb\nc\nd\ne'
    const mine = 'A\nb\nc\nd\nE'
    const theirs = 'a2\nb\nc\nd\ne2'
    const hunks = mergeText(base, mine, theirs)
    const conflictIndexes = hunks.flatMap((hunk, index) => (hunk.kind === 'conflict' ? [index] : []))
    expect(conflictIndexes).toHaveLength(2)
    hunks[conflictIndexes[0]].resolved = hunks[conflictIndexes[0]].mine
    hunks[conflictIndexes[1]].resolved = hunks[conflictIndexes[1]].theirs
    expect(joinHunks(hunks)).toBe('A\nb\nc\nd\ne2')
  })
})

describe('mergeSidecar (.json da nota)', () => {
  it('provas, destaques e questões novas dos dois lados se somam sem conflito', () => {
    const base = { ...baseSidecar(), attempts: [attempt('a0')], highlights: [highlight('h0', 'zero')], questions: [question('q0')] }
    const mine = { ...base, attempts: [...base.attempts, attempt('mine1')], highlights: [...base.highlights, highlight('hm', 'meu')], questions: [...base.questions, question('qm')] }
    const theirs = { ...base, attempts: [...base.attempts, attempt('theirs1')], highlights: [...base.highlights, highlight('ht', 'dele')], questions: [...base.questions, question('qt')] }
    const { merged, conflicts } = mergeSidecar(base, mine, theirs)
    expect(conflicts).toEqual([])
    expect(merged.attempts.map(item => item.id).sort()).toEqual(['a0', 'mine1', 'theirs1'])
    expect(merged.highlights.map(item => item.id).sort()).toEqual(['h0', 'hm', 'ht'])
    expect(merged.questions.map(item => item.storedId).sort()).toEqual(['q0', 'qm', 'qt'])
  })

  it('remover de um lado e adicionar do outro também junta sozinho', () => {
    const base = { ...baseSidecar(), highlights: [highlight('h0', 'zero'), highlight('h1', 'um')] }
    const mine = { ...base, highlights: [highlight('h1', 'um')] }
    const theirs = { ...base, highlights: [...base.highlights, highlight('h2', 'dois')] }
    const { merged, conflicts } = mergeSidecar(base, mine, theirs)
    expect(conflicts).toEqual([])
    expect(merged.highlights.map(item => item.id)).toEqual(['h1', 'h2'])
  })

  it('campos que só mudam por estatística (updated, words) não geram conflito', () => {
    const base = baseSidecar()
    const mine = { ...base, meta: { ...base.meta, words: 10, updated: { at: '2026-01-02T00:00:00.000Z', deviceId: 'a', deviceName: 'A' } } }
    const theirs = { ...base, meta: { ...base.meta, words: 20, updated: { at: '2026-01-03T00:00:00.000Z', deviceId: 'b', deviceName: 'B' } } }
    const { merged, conflicts } = mergeSidecar(base, mine, theirs)
    expect(conflicts).toEqual([])
    expect(merged.meta.updated.deviceName).toBe('B')
  })

  it('o mesmo campo mudado dos dois lados vira conflito e a escolha é aplicada', () => {
    const base = baseSidecar()
    const mine = { ...base, meta: { ...base.meta, description: 'minha' }, attempts: [attempt('m')] }
    const theirs = { ...base, meta: { ...base.meta, description: 'dele' }, attempts: [attempt('t')] }
    const { merged, conflicts } = mergeSidecar(base, mine, theirs)
    expect(conflicts).toEqual([{ path: 'meta.description', label: 'Descrição', mine: 'minha', theirs: 'dele' }])
    const resolved = applyFieldChoices(merged, conflicts, { 'meta.description': 'theirs' })
    expect(resolved.meta.description).toBe('dele')
    expect(resolved.attempts.map(item => item.id).sort()).toEqual(['m', 't'])
  })

  it('o mesmo destaque editado dos dois lados vira conflito do item', () => {
    const base = { ...baseSidecar(), highlights: [highlight('h', 'texto')] }
    const mine = { ...base, highlights: [{ ...highlight('h', 'texto'), text: 'nota minha' }] }
    const theirs = { ...base, highlights: [{ ...highlight('h', 'texto'), text: 'nota dele' }] }
    const { merged, conflicts } = mergeSidecar(base, mine, theirs)
    expect(conflicts.map(item => item.path)).toEqual(['highlights.h'])
    expect(applyFieldChoices(merged, conflicts, { 'highlights.h': 'theirs' }).highlights[0].text).toBe('nota dele')
  })
})
