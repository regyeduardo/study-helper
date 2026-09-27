import type { Progress, Segment } from '@/lib/transcription/types'

interface PuterClient {
  ai: { speech2txt(file: Blob, options?: { language?: string }): Promise<{ text?: string } | string> }
}

let loading: Promise<PuterClient> | null = null

async function client(): Promise<PuterClient> {
  if (!loading) {
    loading = import('@heyputer/puter.js').then(module => ((module as unknown as { default?: PuterClient }).default ?? (module as unknown as PuterClient)))
    loading.catch(() => (loading = null))
  }
  return loading
}

export async function transcribeWithPuter(audio: Blob, language: string, durationSeconds: number, progress: Progress): Promise<Segment[]> {
  progress('Transcrevendo pelo Puter (a janela do Puter pode pedir para você entrar)')
  const puter = await client()
  const result = await puter.ai.speech2txt(audio, language ? { language } : undefined)
  const text = (typeof result === 'string' ? result : (result.text ?? '')).trim()
  return text ? [{ start: 0, end: durationSeconds, text }] : []
}
