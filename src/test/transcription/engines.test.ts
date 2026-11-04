import { describe, expect, it } from 'vitest'

import { ENGINES, transcribe } from '@/lib/transcription'
import type { TranscriptionEngine } from '@/types/domain'

const audioBlob = () => ({ arrayBuffer: async () => new ArrayBuffer(8) }) as unknown as Blob

describe('transcription engines', () => {
  it('only the paid providers and Gemini are offered', () => {
    expect(ENGINES.map(engine => engine.id)).toEqual(['openai', 'deepinfra', 'gemini', 'custom'])
    expect(ENGINES.some(engine => /grátis|navegador|minutos/i.test(`${engine.name} ${engine.where} ${engine.limits}`))).toBe(false)
  })

  it.each(['free', 'whisper', 'parakeet', 'groq', 'puter'])('an engine that left (%s) asks to choose another one', async engine => {
    await expect(transcribe(audioBlob(), { engine: engine as TranscriptionEngine, language: 'pt', credentials: {}, speakersEngine: '' })).rejects.toThrow('Escolha um modelo de Transcrição em Configurações › Inteligência artificial › Padrões por uso, ou na hora de gerar.')
  })
})
