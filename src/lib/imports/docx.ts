export async function docxText(bytes: ArrayBuffer): Promise<string> {
  const mammoth = await import('mammoth')
  const { value } = await mammoth.extractRawText({ arrayBuffer: bytes })
  return value
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
    .join('\n\n')
}
