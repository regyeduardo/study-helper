import type { ParakeetModel } from 'parakeet.js'

import { SAMPLE_RATE } from '@/lib/transcription/audio'
import { hasWebGpu } from '@/lib/transcription/device'
import type { Progress, Segment } from '@/lib/transcription/types'

const MULTILINGUAL = 'parakeet-tdt-0.6b-v3'
const PORTUGUESE_REPO = 'https://huggingface.co/calneymgp/parakeet-tdt-0.6b-v3-ptBR-TAGARELA-onnx-int8/resolve/main'

const loaded = new Map<string, Promise<ParakeetModel>>()

async function portuguese(): Promise<ParakeetModel> {
  const { fromUrls } = await import('parakeet.js')
  return fromUrls({
    encoderUrl: `${PORTUGUESE_REPO}/encoder-model.int8.onnx`,
    decoderUrl: `${PORTUGUESE_REPO}/decoder_joint-model.int8.onnx`,
    tokenizerUrl: `${PORTUGUESE_REPO}/vocab.txt`,
    preprocessorBackend: 'js',
    backend: 'wasm',
  })
}

async function multilingual(backend: 'webgpu' | 'wasm'): Promise<ParakeetModel> {
  const { fromHub } = await import('parakeet.js')
  return fromHub(MULTILINGUAL, { backend, encoderQuant: backend === 'webgpu' ? 'fp32' : 'int8', decoderQuant: 'int8' })
}

async function model(language: string, progress: Progress): Promise<ParakeetModel> {
  const key = language.startsWith('pt') ? 'pt' : 'multi'
  if (!loaded.has(key)) {
    const backend = (await hasWebGpu()) ? 'webgpu' : 'wasm'
    const loading = (async () => {
      if (key === 'pt') {
        progress('Baixando o Parakeet pt-BR (só na primeira vez)')
        try {
          return await portuguese()
        } catch {
          progress('O Parakeet pt-BR não carregou no navegador; usando o Parakeet multilíngue')
        }
      }
      progress('Baixando o Parakeet (só na primeira vez)')
      return multilingual(backend)
    })()
    loaded.set(key, loading)
    loading.catch(() => loaded.delete(key))
  }
  return loaded.get(key)!
}

export async function transcribeWithParakeet(samples: Float32Array, language: string, progress: Progress): Promise<Segment[]> {
  const recognizer = await model(language, progress)
  progress('Transcrevendo com o Parakeet no navegador')
  const result = await recognizer.transcribeLongAudio(samples, SAMPLE_RATE, { returnTimestamps: true })
  const chunks = result.chunks ?? []
  if (!chunks.length) return result.text.trim() ? [{ start: 0, end: samples.length / SAMPLE_RATE, text: result.text.trim() }] : []
  return chunks.map(chunk => ({ start: chunk.timestamp[0], end: chunk.timestamp[1], text: chunk.text.trim() }))
}
