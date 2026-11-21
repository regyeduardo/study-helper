// História 9 (spec 003, FR-052 a FR-053): o lugar de cada item, por escolha própria ou seguindo a pasta de cima.
import { describe, expect, it } from 'vitest'

import type { FileMeta, FolderMeta, Place } from '@/types/domain'
import { newFileMeta } from '@/lib/defaults'
import { filePlaceOf, folderPlaceOf, mixedFolderIds, placeChoice, rootPlace } from '@/lib/storage/place'

const folder = (id: string, parentId: string | null, place?: Place): FolderMeta =>
  ({ id, name: id, parentId, position: 0, description: '', isCourse: false, courseOrigin: null, courseDescription: null, courseMaterial: null, created: { at: '', deviceId: '', deviceName: '' }, updated: { at: '', deviceId: '', deviceName: '' }, deletedAt: null, ...(place ? { place } : {}) }) as FolderMeta
const note = (id: string, folderId: string | null, place?: Place): FileMeta => newFileMeta({ id, name: id, type: 'class', folderId, ...(place ? { place } : {}) })

// Faculdade (sem escolha) › Cálculo I; Trabalho (sem escolha) › Projeto Aurora (Local) › Contratos (Drive)
const FOLDERS = [folder('faculdade', null), folder('calculo', 'faculdade'), folder('trabalho', null), folder('aurora', 'trabalho', 'local'), folder('contratos', 'aurora', 'drive')]

describe('o lugar da raiz', () => {
  it('com login no Google, a biblioteca começa no Google Drive; sem login, em Local', () => {
    expect(rootPlace(true)).toBe('drive')
    expect(rootPlace(false)).toBe('local')
  })
})

describe('o lugar de uma pasta', () => {
  it('sem escolha própria, segue a pasta de cima até a raiz', () => {
    expect(folderPlaceOf('calculo', FOLDERS, 'drive')).toBe('drive')
    expect(folderPlaceOf('calculo', FOLDERS, 'local')).toBe('local')
  })

  it('a escolha própria vale para ela e para o que está dentro sem escolha', () => {
    expect(folderPlaceOf('aurora', FOLDERS, 'drive')).toBe('local')
    expect(folderPlaceOf('contratos', FOLDERS, 'drive')).toBe('drive')
  })

  it('a raiz (fora de pasta) tem o lugar da biblioteca', () => {
    expect(folderPlaceOf(null, FOLDERS, 'drive')).toBe('drive')
  })

  it('um ciclo nos dados não trava: para onde fecha e usa a raiz', () => {
    const loop = [folder('a', 'b'), folder('b', 'a')]
    expect(folderPlaceOf('a', loop, 'drive')).toBe('drive')
  })
})

describe('o lugar de uma nota', () => {
  it('sem escolha própria, segue a pasta; com escolha, a dela', () => {
    expect(filePlaceOf(note('ata', 'aurora'), FOLDERS, 'drive')).toBe('local')
    expect(filePlaceOf(note('lista', 'calculo'), FOLDERS, 'drive')).toBe('drive')
    expect(filePlaceOf(note('rascunho', 'calculo', 'local'), FOLDERS, 'drive')).toBe('local')
  })
})

describe('a pasta com itens em lugares diferentes', () => {
  it('é marcada, e as pastas acima dela também', () => {
    const files = [note('lista', 'calculo'), note('ata', 'aurora'), note('contrato', 'contratos')]
    const mixed = mixedFolderIds(FOLDERS, files, 'drive')
    // Trabalho (Drive) tem Projeto Aurora (Local); Projeto Aurora (Local) tem Contratos (Drive)
    expect([...mixed].sort()).toEqual(['aurora', 'trabalho'])
  })

  it('uma nota com escolha própria diferente marca a pasta dela', () => {
    const mixed = mixedFolderIds(FOLDERS, [note('lista', 'calculo'), note('rascunho', 'calculo', 'local')], 'drive')
    expect(mixed.has('calculo')).toBe(true)
    expect(mixed.has('faculdade')).toBe(true)
  })

  it('o que está na Lixeira não conta', () => {
    const trashed = { ...note('rascunho', 'calculo', 'local'), deletedAt: '2026-11-20T10:00:00.000Z' }
    expect(mixedFolderIds([folder('faculdade', null), folder('calculo', 'faculdade')], [note('lista', 'calculo'), trashed], 'drive').size).toBe(0)
  })
})

describe('quem pode escolher cada lugar', () => {
  it('Local sempre; Google Drive pede login; App pede a conta liberada', () => {
    expect(placeChoice('local', { signedIn: false, appAllowed: false })).toBe('ok')
    expect(placeChoice('drive', { signedIn: false, appAllowed: false })).toBe('entrar')
    expect(placeChoice('drive', { signedIn: true, appAllowed: false })).toBe('ok')
    expect(placeChoice('app', { signedIn: true, appAllowed: false })).toBe('liberar')
    expect(placeChoice('app', { signedIn: true, appAllowed: true })).toBe('ok')
  })
})
