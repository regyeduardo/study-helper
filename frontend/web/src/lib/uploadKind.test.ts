import { describe, it, expect } from 'vitest'
import { needsTranscription, uploadKind } from './uploadKind'

function file(name: string, type = ''): File {
  return new File(['x'], name, { type })
}

describe('uploadKind', () => {
  it('reconhece áudio e vídeo como mídia', () => {
    expect(uploadKind(file('aula.mp3'))).toBe('media')
    expect(uploadKind(file('aula.MP4'))).toBe('media')
    expect(uploadKind(file('aula.mkv'))).toBe('media')
  })

  it('reconhece legenda como legenda, não como mídia', () => {
    expect(uploadKind(file('aula.srt'))).toBe('subtitle')
    expect(uploadKind(file('aula.vtt'))).toBe('subtitle')
  })

  it('trata documentos e texto como documento', () => {
    expect(uploadKind(file('aula.pdf'))).toBe('document')
    expect(uploadKind(file('notas.txt'))).toBe('document')
    expect(uploadKind(file('notas.anotacao'))).toBe('document')
  })

  it('usa o mime type quando não há extensão', () => {
    expect(uploadKind(file('gravacao', 'audio/mpeg'))).toBe('media')
    expect(uploadKind(file('anotacoes', 'text/plain'))).toBe('document')
  })

  it('retorna null sem arquivo', () => {
    expect(uploadKind(null)).toBeNull()
  })

  it('só pede transcrição para mídia', () => {
    expect(needsTranscription(file('aula.mp3'))).toBe(true)
    expect(needsTranscription(file('aula.srt'))).toBe(false)
    expect(needsTranscription(file('aula.pdf'))).toBe(false)
    expect(needsTranscription(null)).toBe(false)
  })
})
