// 24/11/2026 (dono: "Erro grave"): no filtro "Guardado", o que está no App aparece como "No App", não como "No meu Drive".
import { describe, expect, it } from 'vitest'

import { newFileMeta } from '@/lib/defaults'
import { filterLibrary, NO_FILTERS } from '@/lib/library-filters'

const NOW = '2026-11-24T12:00:00.000Z'
const aula = newFileMeta({ id: 'aula', name: 'Aula no App', type: 'class', folderId: null })
const ata = newFileMeta({ id: 'ata', name: 'Ata no Drive', type: 'meeting', folderId: null })
const video = newFileMeta({ id: 'video', name: 'Vídeo no App', type: 'video', folderId: null, kept: 'arquivo', origin: { input: 'recording', name: 'v.webm', mime: 'video/webm', storage: 'drive', storedFileId: 'app:video/m1' } })

const places = (app?: string[]) => filterLibrary({ files: [aula, ata, video], folders: [], library: 'drive', now: NOW, ...(app ? { app } : {}) }, { ...NO_FILTERS, places: [] }).facets.places

describe('Guardado: App e Google Drive separados', () => {
  it('as notas do App e a mídia guardada no App contam em "No App"; o resto, em "No meu Drive"', () => {
    const found = places(['aula'])
    expect(found.find(option => option.id === 'app')).toMatchObject({ label: 'No App', count: 2 })
    expect(found.find(option => option.id === 'drive')).toMatchObject({ label: 'No meu Drive', count: 1 })
  })

  it('escolher "No App" mostra só o que está no App', () => {
    const result = filterLibrary({ files: [aula, ata, video], folders: [], library: 'drive', app: ['aula'], now: NOW }, { ...NO_FILTERS, places: ['app'] })
    expect(result.items.map(file => file.id).sort()).toEqual(['aula', 'video'])
  })

  it('numa biblioteca sem o App, "No App" nem aparece', () => {
    const plain = filterLibrary({ files: [ata], folders: [], library: 'drive', now: NOW }, { ...NO_FILTERS, places: [] }).facets.places
    expect(plain.some(option => option.id === 'app')).toBe(false)
  })
})
