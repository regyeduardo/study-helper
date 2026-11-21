import { describe, expect, it } from 'vitest'

import type { ShareRecord, SharedFile, SharedItem } from '@/types/domain'
import { findValidShare, sharedMediaFailure, sharedMediaState } from '@/lib/share'
import { mergeShares } from '@/lib/sync/merge'

const DAY = 24 * 3600_000
const NOW = Date.parse('2026-11-20T12:00:00Z')
const iso = (offset: number) => new Date(NOW + offset).toISOString()

function record(fields: Partial<ShareRecord> = {}): ShareRecord {
  return { id: 'LinkLinkLinkLinkLink1', kind: 'file', itemId: 'nota-1', title: 'Nota', bytes: 100, withExams: false, createdAt: iso(-DAY), expiresAt: iso(2 * DAY), ...fields }
}

describe('achar o link já feito de um item', () => {
  it('acha pelo item, sem importar se foi feito como arquivo ou como entrada (a nota virou entrada na migração, ou o contrário)', () => {
    expect(findValidShare([record({ kind: 'file' })], 'entrada', 'nota-1', NOW)?.id).toBe('LinkLinkLinkLinkLink1')
    expect(findValidShare([record({ kind: 'entrada' })], 'file', 'nota-1', NOW)?.id).toBe('LinkLinkLinkLinkLink1')
    expect(findValidShare([record({ kind: 'entrada' })], 'entrada', 'nota-1', NOW)?.id).toBe('LinkLinkLinkLinkLink1')
  })

  it('pasta é outra coisa: o link de uma pasta não vale para uma nota, nem o de uma nota para uma pasta', () => {
    expect(findValidShare([record({ kind: 'folder' })], 'file', 'nota-1', NOW)).toBeNull()
    expect(findValidShare([record({ kind: 'file' })], 'folder', 'nota-1', NOW)).toBeNull()
    expect(findValidShare([record({ kind: 'folder' })], 'folder', 'nota-1', NOW)?.id).toBe('LinkLinkLinkLinkLink1')
  })

  it('ignora o que venceu e o que é de outro item; entre dois no prazo, fica o que vale por mais tempo', () => {
    const old = record({ id: 'AntigoAntigoAntigo01', expiresAt: iso(1 * DAY) })
    const fresh = record({ id: 'NovoNovoNovoNovoNovo1', expiresAt: iso(3 * DAY) })
    expect(findValidShare([old, fresh], 'file', 'nota-1', NOW)?.id).toBe('NovoNovoNovoNovoNovo1')
    expect(findValidShare([fresh, old], 'file', 'nota-1', NOW)?.id).toBe('NovoNovoNovoNovoNovo1')
    expect(findValidShare([record({ expiresAt: iso(-1) })], 'file', 'nota-1', NOW)).toBeNull()
    expect(findValidShare([record({ itemId: 'outra' })], 'file', 'nota-1', NOW)).toBeNull()
  })
})

describe('link atualizado em outro aparelho', () => {
  it('o mesmo link com prazo maior em um dos lados fica com o prazo maior (atualizar no mesmo link muda só o prazo e a data)', () => {
    const base = record({ expiresAt: iso(1 * DAY) })
    const mine = record({ expiresAt: iso(1 * DAY) })
    const theirs = record({ expiresAt: iso(3 * DAY), updatedAt: iso(0) })
    expect(mergeShares([base], [mine], [theirs])).toEqual([theirs])
    expect(mergeShares([base], [theirs], [mine])).toEqual([theirs])
  })

  it('um link só de um lado entra; um que este aparelho apagou não volta; o resto segue como no mergeKept', () => {
    const a = record({ id: 'AAAAAAAAAAAAAAAAAAAA1' })
    const b = record({ id: 'BBBBBBBBBBBBBBBBBBBB1' })
    const c = record({ id: 'CCCCCCCCCCCCCCCCCCCC1' })
    expect(mergeShares([a], [a], [a, b]).map(share => share.id)).toEqual(['AAAAAAAAAAAAAAAAAAAA1', 'BBBBBBBBBBBBBBBBBBBB1'])
    expect(mergeShares([a, c], [a], [a, c]).map(share => share.id)).toEqual(['AAAAAAAAAAAAAAAAAAAA1'])
  })
})

function sharedFile(fields: Partial<SharedFile> = {}): SharedFile {
  return { id: 'e', name: 'Entrada', folderId: null, type: 'meeting', position: 0, description: '', tags: [], content: '', questions: [], highlights: [], ...fields }
}

function item(file: SharedFile, fields: Partial<SharedItem> = {}): SharedItem {
  return { version: 2, id: 'ShareShareShareShare1', kind: 'entrada', title: 'Entrada', createdAt: iso(-3600_000), expiresAt: iso(2 * DAY), mediaExpiresAt: iso(2 * DAY), folders: [], files: [file], ...fields }
}

const MEDIA = { url: 'https://share.test/media/x/e', mime: 'video/mp4', size: 1000 }

describe('o que o link diz sobre a mídia de uma nota', () => {
  it('pronta: a mídia está no link e não venceu', () => {
    const file = sharedFile({ media: MEDIA })
    expect(sharedMediaState(item(file), file, NOW)).toEqual({ kind: 'ready', media: MEDIA })
  })

  it('subindo: quem compartilhou ainda está enviando (ou o envio não terminou)', () => {
    const file = sharedFile({ mediaPending: { mime: 'video/mp4', size: 1000 } })
    expect(sharedMediaState(item(file), file, NOW)).toEqual({ kind: 'pending', mime: 'video/mp4', size: 1000 })
  })

  it('venceu: a mídia some do link depois de 3 dias, esteja ela pronta ou ainda subindo', () => {
    const gone = { mediaExpiresAt: iso(-1000) }
    const ready = sharedFile({ media: MEDIA })
    const pending = sharedFile({ mediaPending: { mime: 'video/mp4', size: 1000 } })
    expect(sharedMediaState(item(ready, gone), ready, NOW)).toEqual({ kind: 'expired' })
    expect(sharedMediaState(item(pending, gone), pending, NOW)).toEqual({ kind: 'expired' })
  })

  it('nenhuma: o link não traz mídia para essa nota', () => {
    const file = sharedFile()
    expect(sharedMediaState(item(file), file, NOW)).toEqual({ kind: 'none' })
    expect(sharedMediaState(item(file), undefined, NOW)).toEqual({ kind: 'none' })
  })
})

describe('por que a mídia do link não baixou', () => {
  it('cada resposta do Worker tem a sua frase; sem resposta é a conexão', () => {
    expect(sharedMediaFailure(410)).toBe('A mídia deste compartilhamento expirou (fica 3 dias).')
    expect(sharedMediaFailure(404)).toBe('A mídia ainda não terminou de subir, ou quem compartilhou a apagou.')
    expect(sharedMediaFailure(403)).toBe('Este endereço do app não tem permissão para baixar a mídia do link.')
    expect(sharedMediaFailure(null)).toBe('Sem conexão com o serviço de compartilhamento. Confira a internet e tente de novo.')
    expect(sharedMediaFailure(500)).toBe('O serviço de compartilhamento não respondeu direito (erro 500). Tente de novo daqui a pouco.')
  })
})
