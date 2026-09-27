import { describe, expect, it } from 'vitest'
import { decodeText, detectKind, extensionOf, looksLikeText, subtitleToText } from '@/lib/generation/uploads'

const text = (value: string) => new TextEncoder().encode(value)

describe('detectKind', () => {
  it.each([
    ['a.pdf', text('x'), 'pdf'],
    ['sem-extensao', text('%PDF-1.7'), 'pdf'],
    ['a.docx', text('x'), 'docx'],
    ['a.doc', text('x'), 'doc_legacy'],
    ['a.zip', text('x'), 'zip'],
    ['a.srt', text('x'), 'subtitle'],
    ['a.MP3', text('x'), 'media'],
    ['a.bin', new Uint8Array([0, 1, 2, 3]), 'media'],
    ['a.txt', text('1\n00:00:01,000 --> 00:00:02,000\nOi'), 'subtitle'],
    ['a.md', text('# título'), 'text'],
  ])('%s is %s', (name, bytes, kind) => {
    expect(detectKind(name, bytes)).toBe(kind)
  })

  it('extension and text helpers', () => {
    expect(extensionOf('a.b.TXT')).toBe('txt')
    expect(extensionOf('semponto')).toBe('')
    expect(looksLikeText(new Uint8Array())).toBe(true)
    expect(decodeText(new Uint8Array([0xe9]))).toBe('é')
  })
})

describe('subtitleToText', () => {
  it('strips SRT indexes, timestamps, tags and repeats', () => {
    expect(subtitleToText('1\r\n00:00:01,000 --> 00:00:02,000\r\n<i>Olá</i>\r\n\r\n2\r\n00:00:02,000 --> 00:00:03,000\r\n<i>Olá</i>\r\n[música]\r\nTudo bem?')).toBe('Olá Tudo bem?')
  })

  it('reads VTT and ASS dialogue', () => {
    expect(subtitleToText('WEBVTT\n\n00:01.000 --> 00:02.000\nPrimeira')).toBe('Primeira')
    expect(subtitleToText('[Script Info]\nTitle: x\nDialogue: 0,0:00:01.00,0:00:02.00,Default,,0,0,0,,{\\an8}Linha\\Ndois')).toBe('Linha dois')
  })
})
