// T119 (spec 004, FR-040; data-model.md › Drive e Local): os arquivos JSON do idioma por caminho, no mesmo contrato em todo lugar.
// Local = este navegador (IndexedDB); a memória serve aos testes da base no navegador.
import 'fake-indexeddb/auto'
import { describe, expect, it, vi } from 'vitest'

// a Google Drive in memory: files and folders with their parents and appProperties, as the Drive answers
const drive = vi.hoisted(() => {
  const files = new Map<string, { id: string; name: string; mimeType: string; parents: string[]; appProperties: Record<string, string>; body: string; trashed?: boolean }>()
  let next = 0
  const text = (media: Blob) =>
    new Promise<string>(done => {
      const reader = new FileReader()
      reader.onload = () => done(String(reader.result))
      reader.readAsText(media)
    })
  return { files, newId: () => `d${++next}`, text }
})
vi.mock('@/controllers/drive.controller', () => ({
  listDriveFilesController: async (_token: unknown, query: string) =>
    [...drive.files.values()].filter(file => !file.trashed && (!query.includes("value='idioma'") || file.appProperties.shKind === 'idioma')),
  createDriveFolderController: async (_token: unknown, name: string, parent: string | null, appProperties: Record<string, string>) => {
    const file = { id: drive.newId(), name, mimeType: 'application/vnd.google-apps.folder', parents: parent ? [parent] : [], appProperties, body: '' }
    drive.files.set(file.id, file)
    return file
  },
  createDriveFileController: async (_token: unknown, name: string, parent: string, media: Blob, appProperties: Record<string, string>) => {
    const file = { id: drive.newId(), name, mimeType: 'application/json', parents: [parent], appProperties, body: await drive.text(media) }
    drive.files.set(file.id, file)
    return file
  },
  updateDriveFileController: async (_token: unknown, id: string, changes: { media?: Blob }) => {
    const file = drive.files.get(id)!
    if (changes.media) file.body = await drive.text(changes.media)
    return file
  },
  deleteDriveFileController: async (_token: unknown, id: string) => void drive.files.delete(id),
  downloadDriveTextController: async (_token: unknown, id: string) => drive.files.get(id)!.body,
}))

import { DriveLangFiles, type LangFiles, LocalLangFiles, MemoryLangFiles } from '@/lib/langs/files'

const fakeDrive = () => {
  drive.files.clear()
  drive.files.set('raiz-idiomas', { id: 'raiz-idiomas', name: 'idiomas', mimeType: 'application/vnd.google-apps.folder', parents: ['raiz'], appProperties: { shKind: 'idiomas' }, body: '' })
  return new DriveLangFiles(async () => ({ token: async () => 'token', space: 'appDataFolder', folderId: 'raiz-idiomas' }))
}

const places: [string, () => LangFiles][] = [
  ['memória', () => new MemoryLangFiles()],
  ['este navegador', () => new LocalLangFiles(`teste-idiomas-${Math.random()}`)],
  ['Google Drive', fakeDrive],
]

describe.each(places)('arquivos do idioma (%s)', (_, make) => {
  it('grava, lê, lista o que está logo abaixo da pasta e apaga', async () => {
    const files = make()
    expect(await files.read('en/language.json')).toBeNull()
    await files.write('en/language.json', { code: 'en', name: 'Inglês' })
    await files.write('en/texts/t1.json', { id: 't1' })
    await files.write('en/texts/t2.json', { id: 't2' })
    await files.write('es/language.json', { code: 'es' })
    expect(await files.read('en/language.json')).toEqual({ code: 'en', name: 'Inglês' })
    expect((await files.list('')).sort()).toEqual(['en', 'es'])
    expect((await files.list('en')).sort()).toEqual(['language.json', 'texts'])
    expect((await files.list('en/texts')).sort()).toEqual(['t1.json', 't2.json'])
    await files.remove('en/texts/t1.json')
    expect(await files.list('en/texts')).toEqual(['t2.json'])
    expect(await files.read('en/texts/t1.json')).toBeNull()
  })

  it('o que se lê é uma cópia: mexer nela não muda o arquivo', async () => {
    const files = make()
    await files.write('en/items.json', { walk: { label: 'walk' } })
    const read = (await files.read<Record<string, { label: string }>>('en/items.json'))!
    read.walk.label = 'mudado'
    expect(await files.read('en/items.json')).toEqual({ walk: { label: 'walk' } })
  })
})

describe('arquivos do idioma no Google Drive', () => {
  it('uma pasta por idioma dentro de "idiomas", com as subpastas; quem abre de novo acha tudo pela marca do caminho', async () => {
    const files = fakeDrive()
    await files.write('en/language.json', { code: 'en' })
    await files.write('en/texts/t1.json', { id: 't1' })
    const byName = (name: string) => [...drive.files.values()].find(file => file.name === name)!
    expect(byName('en').parents).toEqual(['raiz-idiomas'])
    expect(byName('texts').parents).toEqual([byName('en').id])
    expect(byName('t1.json').parents).toEqual([byName('texts').id])
    await files.write('en/texts/t1.json', { id: 't1', title: 'Chuva' })
    expect([...drive.files.values()].filter(file => file.name === 't1.json')).toHaveLength(1)
    const again = new DriveLangFiles(async () => ({ token: async () => 'token', space: 'appDataFolder', folderId: 'raiz-idiomas' }))
    expect(await again.read('en/texts/t1.json')).toEqual({ id: 't1', title: 'Chuva' })
    expect(await again.list('en/texts')).toEqual(['t1.json'])
  })
})
