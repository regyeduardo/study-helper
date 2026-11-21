// História 10 (003): não há mais Entrada; tudo é Nota com o seu tipo, e a Gravação é a nota de mídia que o app gravou.
import { describe, expect, it } from 'vitest'

import type { FileMeta, SourceMeta } from '@/types/domain'
import { newFileMeta } from '@/lib/defaults'
import { isNote } from '@/lib/family'
import { isMediaNote, isRecording, isSourceNote, noteTypeOf, sourceTypeOf } from '@/lib/file-types'

const origin = (fields: Partial<SourceMeta> & Pick<SourceMeta, 'input'>): SourceMeta => ({ name: 'x', storage: 'none', ...fields })

describe('sourceTypeOf: o tipo da nota sai da origem', () => {
  it.each([
    ['YouTube', origin({ input: 'youtube', url: 'https://youtu.be/abc' }), 'video'],
    ['vídeo enviado', origin({ input: 'file', mime: 'video/mp4', name: 'aula.mp4' }), 'video'],
    ['reunião gravada com a tela', origin({ input: 'recording', mime: 'video/webm' }), 'video'],
    ['áudio enviado', origin({ input: 'file', mime: 'audio/mpeg', name: 'podcast.mp3' }), 'audio'],
    ['microfone gravado', origin({ input: 'recording', mime: 'audio/webm' }), 'audio'],
    ['PDF', origin({ input: 'file', mime: 'application/pdf', name: 'apostila.pdf' }), 'pdf'],
    ['PDF sem tipo', origin({ input: 'file', name: 'apostila.PDF' }), 'pdf'],
    ['link', origin({ input: 'url', url: 'https://exemplo.com' }), 'link'],
    ['texto colado', origin({ input: 'text', mime: 'text/plain' }), 'text'],
    ['tema', origin({ input: 'topic' }), 'topic'],
    ['outro arquivo', origin({ input: 'file', mime: 'application/vnd.ms-powerpoint', name: 'slides.ppt' }), 'document'],
  ])('%s', (_, source, type) => {
    expect(sourceTypeOf(source)).toBe(type)
  })
})

describe('noteTypeOf: a entrada antiga é lida como nota do seu tipo, sem mudar o item', () => {
  it('um item antigo com role entrada tem o tipo da origem', () => {
    const old = newFileMeta({ name: 'kickoff.webm', type: 'reading', role: 'entrada', kept: 'arquivo', origin: origin({ input: 'recording', mime: 'video/webm' }) })
    const before = JSON.stringify(old)
    expect(noteTypeOf(old)).toBe('video')
    expect(JSON.stringify(old)).toBe(before)
  })

  it('uma nota de hoje tem o próprio tipo', () => {
    expect(noteTypeOf(newFileMeta({ name: 'Aula 1', type: 'class' }))).toBe('class')
    expect(noteTypeOf(newFileMeta({ name: 'apostila.pdf', type: 'pdf', origin: origin({ input: 'file', mime: 'application/pdf' }) }))).toBe('pdf')
  })
})

describe('nota de fonte, nota de mídia e Gravação', () => {
  const recorded = newFileMeta({ name: 'Reunião', type: 'video', origin: origin({ input: 'recording', mime: 'video/webm' }) })
  const sent = newFileMeta({ name: 'aula.mp4', type: 'video', origin: origin({ input: 'file', mime: 'video/mp4' }) })
  const oldRecorded = newFileMeta({ name: 'mic', type: 'reading', role: 'entrada', origin: origin({ input: 'recording', mime: 'audio/webm' }) })
  const pdf = newFileMeta({ name: 'apostila.pdf', type: 'pdf', origin: origin({ input: 'file', mime: 'application/pdf' }) })
  const lesson = newFileMeta({ name: 'Aula', type: 'class', parentFileId: recorded.id })

  it('a nota que guarda a fonte (vídeo, áudio, PDF, link, texto, tema, arquivo) tem a página especial', () => {
    expect([recorded, sent, oldRecorded, pdf].map(isSourceNote)).toEqual([true, true, true, true])
    expect(isSourceNote(lesson)).toBe(false)
  })

  it('isNote fica para a nota escrita: a de fonte fica de fora da revisão, da Prova e da busca de conteúdo', () => {
    expect([recorded, pdf, oldRecorded].map(isNote)).toEqual([false, false, false])
    expect(isNote(lesson)).toBe(true)
  })

  it('nota de mídia é Vídeo ou Áudio', () => {
    expect([recorded, sent, oldRecorded, pdf, lesson].map(isMediaNote)).toEqual([true, true, true, false, false])
  })

  it('Gravação é a nota de mídia que o app gravou: o vídeo enviado não é', () => {
    expect([recorded, sent, oldRecorded, pdf, lesson].map(isRecording)).toEqual([true, false, true, false, false])
  })

  it('um item lido de um aparelho antigo, sem tipo novo nem papel, continua nota escrita', () => {
    const old = JSON.parse(JSON.stringify(newFileMeta({ name: 'Antiga', type: 'reading' }))) as FileMeta
    expect(isSourceNote(old)).toBe(false)
    expect(isNote(old)).toBe(true)
  })
})
