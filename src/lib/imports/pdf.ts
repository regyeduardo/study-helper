export async function pdfText(bytes: ArrayBuffer): Promise<string> {
  const pdfjs = await import('pdfjs-dist')
  const worker = await import('pdfjs-dist/build/pdf.worker.min.mjs?url')
  pdfjs.GlobalWorkerOptions.workerSrc = worker.default
  const document = await pdfjs.getDocument({ data: new Uint8Array(bytes) }).promise
  const pages: string[] = []
  for (let number = 1; number <= document.numPages; number++) {
    const page = await document.getPage(number)
    const content = await page.getTextContent()
    const lines: string[] = []
    let line = ''
    for (const item of content.items) {
      if (!('str' in item)) continue
      line += item.str
      if (item.hasEOL) {
        lines.push(line)
        line = ''
      }
    }
    if (line) lines.push(line)
    pages.push(lines.join('\n').trim())
  }
  return pages.join('\n\n').trim()
}
