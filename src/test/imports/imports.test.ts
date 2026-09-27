import { beforeAll, describe, expect, it, vi } from 'vitest'
import { strToU8, zipSync } from 'fflate'

import { importDocument } from '@/lib/imports'
import { docxText } from '@/lib/imports/docx'
import { pdfText } from '@/lib/imports/pdf'
import { buildZip, readZip } from '@/lib/imports/zip'
import { installBlobShim } from '@/test/imports/blob-shim'
import { buildDocx, buildPdf, fileOf } from '@/test/imports/fixtures'

installBlobShim()

vi.mock('mammoth', async importOriginal => {
  const actual = (await importOriginal()) as { default?: typeof import('mammoth') } & typeof import('mammoth')
  const real = actual.default ?? actual
  const extractRawText = (input: { arrayBuffer?: ArrayBuffer }) =>
    real.extractRawText(input.arrayBuffer ? { buffer: Buffer.from(input.arrayBuffer) } : (input as { buffer: Buffer }))
  return { ...real, default: { ...real, extractRawText }, extractRawText }
})

function arrayBufferOf(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
}

describe('pdf import via pdf.js', () => {
  beforeAll(async () => {
    const specifier = 'pdfjs-dist/build/pdf.worker.min.mjs'
    const worker: unknown = await import(specifier)
    ;(globalThis as { pdfjsWorker?: unknown }).pdfjsWorker = worker
  })

  it('extracts every line of every page as text', async () => {
    const pdf = buildPdf([['Photosynthesis basics', 'Light becomes chemical energy'], ['Second page summary']])
    const text = await pdfText(arrayBufferOf(pdf))
    expect(text).toBe('Photosynthesis basics\nLight becomes chemical energy\n\nSecond page summary')
  })

  it('imports a .pdf file into markdown through importDocument', async () => {
    const pdf = buildPdf([['Cell biology notes']])
    const imported = await importDocument(fileOf(pdf, 'notes.pdf', 'application/pdf'))
    expect(imported).toEqual({ markdown: 'Cell biology notes' })
  })
})

describe('docx import via mammoth', () => {
  it('extracts paragraphs separated by blank lines', async () => {
    const docx = buildDocx(['Chapter one', '   ', 'Mitochondria produce ATP', 'Final remark & note'])
    const text = await docxText(arrayBufferOf(docx))
    expect(text).toBe('Chapter one\n\nMitochondria produce ATP\n\nFinal remark & note')
  })

  it('imports a .docx file through importDocument', async () => {
    const docx = buildDocx(['Only paragraph'])
    const imported = await importDocument(fileOf(docx, 'Lesson.DOCX'))
    expect(imported).toEqual({ markdown: 'Only paragraph' })
  })
})

describe('zip import via fflate', () => {
  it('reads markdown, frontmatter type and questions json', () => {
    const questions = [{ question: 'What is ATP?', answer: 'Energy currency' }]
    const zip = zipSync({
      'lesson.md': strToU8('---\ntype: lesson\n---\n\n# Energy\n\nATP powers the cell.'),
      'lesson-questions.json': strToU8(JSON.stringify(questions)),
      '__MACOSX/lesson.md': strToU8('junk'),
      '.hidden.md': strToU8('hidden'),
    })
    expect(readZip(arrayBufferOf(zip))).toEqual({ markdown: '# Energy\n\nATP powers the cell.', questions, type: 'lesson' })
  })

  it('round trips what buildZip exports', async () => {
    const blob = buildZip('# Title\n\nBody text', [{ question: 'Q1' }], 'my-file', 'explanation')
    const bytes = new Uint8Array(await blob.arrayBuffer())
    const imported = await importDocument(fileOf(bytes, 'export.zip', 'application/zip'))
    expect(imported).toEqual({ markdown: '# Title\n\nBody text', questions: [{ question: 'Q1' }], type: 'explanation' })
  })

  it('ignores a broken json and still returns the markdown', () => {
    const zip = zipSync({ 'a.md': strToU8('plain body'), 'a-questions.json': strToU8('{not json') })
    expect(readZip(arrayBufferOf(zip))).toEqual({ markdown: 'plain body', questions: undefined, type: undefined })
  })

  it('fails when the zip has no markdown', () => {
    const zip = zipSync({ 'readme.txt': strToU8('nothing') })
    expect(() => readZip(arrayBufferOf(zip))).toThrow('Nenhum arquivo .md encontrado no ZIP.')
  })
})

describe('importDocument dispatch', () => {
  it('reads a markdown file with frontmatter', async () => {
    const imported = await importDocument(fileOf(strToU8('---\ntype: meeting\n---\n\nMinutes body'), 'minutes.md'))
    expect(imported).toEqual({ markdown: 'Minutes body', type: 'meeting' })
  })

  it('rejects unsupported formats', async () => {
    await expect(importDocument(fileOf(strToU8('x'), 'sheet.xlsx'))).rejects.toThrow('Formato não suportado: xlsx')
  })
})
