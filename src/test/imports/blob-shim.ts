function readAsArrayBuffer(blob: Blob): Promise<ArrayBuffer> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result as ArrayBuffer)
    reader.onerror = () => reject(reader.error)
    reader.readAsArrayBuffer(blob)
  })
}

export function installBlobShim(): void {
  if (typeof Blob.prototype.arrayBuffer !== 'function') {
    Object.defineProperty(Blob.prototype, 'arrayBuffer', { configurable: true, value(this: Blob) { return readAsArrayBuffer(this) } })
  }
  if (typeof Blob.prototype.text !== 'function') {
    Object.defineProperty(Blob.prototype, 'text', { configurable: true, async value(this: Blob) { return new TextDecoder().decode(await readAsArrayBuffer(this)) } })
  }
}
