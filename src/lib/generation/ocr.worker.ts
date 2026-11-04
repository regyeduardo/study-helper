// The local OCR, inside a Web Worker: PaddleOCR PP-OCRv6 tiny on onnxruntime-web, wasm with 1 thread (the app is
// not cross-origin isolated). The models (public/ocr) and the wasm come from the app itself; the browser caches them.
import * as ort from 'onnxruntime-web'
import wasm from 'onnxruntime-web/ort-wasm-simd-threaded.wasm?url'
import { PaddleOcrService } from 'ppu-paddle-ocr/web'

const scope = self as unknown as { onmessage: ((event: MessageEvent<{ id: number; image: string }>) => void) | null; postMessage(message: unknown): void }

// set after the imports ran: ppu points the wasm to a CDN when nothing is set
ort.env.wasm.numThreads = 1
ort.env.wasm.wasmPaths = { wasm }
const models = new URL(`${import.meta.env.BASE_URL}ocr/`, self.location.href).href
const service = new PaddleOcrService({
  model: { detection: `${models}PP-OCRv6_tiny_det.ort`, recognition: `${models}PP-OCRv6_tiny_rec.ort`, charactersDictionary: `${models}ppocrv6_tiny_dict.txt` },
  session: { executionProviders: ['wasm'], graphOptimizationLevel: 'all' },
})

service.initialize().then(
  () => scope.postMessage({ ready: true }),
  error => scope.postMessage({ fatal: error instanceof Error ? error.message : String(error) }),
)

scope.onmessage = async ({ data }) => {
  try {
    const bytes = await (await fetch(data.image)).arrayBuffer()
    // per box, not per line: each piece keeps its own confidence (a merged line shares one) and reads better
    const result = await service.recognize(bytes, { flatten: true, noCache: true, strategy: 'per-box' })
    scope.postMessage({ id: data.id, texts: result.results.map(item => ({ text: item.text, confidence: item.confidence })) })
  } catch (error) {
    scope.postMessage({ id: data.id, error: error instanceof Error ? error.message : String(error) })
  }
}
