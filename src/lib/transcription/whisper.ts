import type { AutomaticSpeechRecognitionPipeline } from '@huggingface/transformers'

import { SAMPLE_RATE } from '@/lib/transcription/audio'
import { hasWebGpu } from '@/lib/transcription/device'
import type { Progress, Segment } from '@/lib/transcription/types'

export const WHISPER_MODEL = 'onnx-community/whisper-small'

let loading: Promise<AutomaticSpeechRecognitionPipeline> | null = null

async function model(progress: Progress): Promise<AutomaticSpeechRecognitionPipeline> {
  if (!loading) {
    loading = (async () => {
      const { pipeline } = await import('@huggingface/transformers')
      const webgpu = await hasWebGpu()
      return (await pipeline('automatic-speech-recognition', WHISPER_MODEL, {
        device: webgpu ? 'webgpu' : 'wasm',
        dtype: webgpu ? { encoder_model: 'fp32', decoder_model_merged: 'q4' } : 'q8',
        progress_callback: (event: { status?: string; progress?: number; file?: string }) => {
          if (event.status === 'progress' && event.progress !== undefined) progress(`Baixando o Whisper (${event.file ?? 'modelo'})`, event.progress / 100)
        },
      })) as AutomaticSpeechRecognitionPipeline
    })().catch(error => {
      loading = null
      throw error
    })
  }
  return loading
}

export async function transcribeWithWhisper(samples: Float32Array, language: string, progress: Progress): Promise<Segment[]> {
  progress('Carregando o Whisper no navegador')
  const recognizer = await model(progress)
  progress('Transcrevendo com o Whisper no navegador')
  const output = (await recognizer(samples, {
    chunk_length_s: 30,
    stride_length_s: 5,
    return_timestamps: true,
    language: language || undefined,
    task: 'transcribe',
  })) as { text: string; chunks?: { timestamp: [number, number | null]; text: string }[] }
  const chunks = output.chunks ?? []
  if (!chunks.length) return output.text.trim() ? [{ start: 0, end: samples.length / SAMPLE_RATE, text: output.text.trim() }] : []
  return chunks.map(chunk => ({ start: chunk.timestamp[0] ?? 0, end: chunk.timestamp[1] ?? chunk.timestamp[0] ?? 0, text: chunk.text.trim() }))
}
