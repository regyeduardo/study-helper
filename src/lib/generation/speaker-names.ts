import type { RecordingData, RecordingSpeaker } from '@/types/domain'
import { Cancelled } from '@/controllers/ai.controller'
import { extractJson } from '@/lib/generation/mermaid'
import { transcriptChunks } from '@/lib/generation/minutes'
import { PROMPTS } from '@/lib/generation/prompts.data'
import type { GenerationSession } from '@/lib/generation/session'
import { transcriptText } from '@/lib/transcription/export'
import { MICROPHONE } from '@/lib/transcription/turns'

export interface Suggestion {
  speaker: string
  name: string
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

export function suggestionsIn(raw: string): Suggestion[] {
  const names = extractJson(raw)?.nomes
  if (!Array.isArray(names)) return []
  return names.filter((item): item is Record<string, unknown> => typeof item === 'object' && item !== null).map(item => ({ speaker: text(item.falante), name: text(item.nome) }))
}

export function applied(speakers: RecordingSpeaker[], suggestions: Suggestion[], transcript: string): RecordingSpeaker[] {
  const said = transcript.toLocaleLowerCase('pt-BR')
  const taken = new Set(speakers.map(speaker => speaker.name.toLocaleLowerCase('pt-BR')))
  return speakers.map(speaker => {
    if (speaker.id === MICROPHONE) return speaker
    const found = suggestions.find(item => item.speaker === speaker.name && item.name && said.includes(item.name.toLocaleLowerCase('pt-BR')) && !taken.has(item.name.toLocaleLowerCase('pt-BR')))
    if (!found) return speaker
    taken.add(found.name.toLocaleLowerCase('pt-BR'))
    return { ...speaker, name: found.name, suggested: true }
  })
}

export async function suggestSpeakerNames(recording: RecordingData, session: GenerationSession): Promise<RecordingData> {
  if (!recording.speakers.some(speaker => speaker.id !== MICROPHONE)) return recording
  const transcript = transcriptText(recording)
  const suggestions: Suggestion[] = []
  try {
    for (const piece of transcriptChunks(transcript)) suggestions.push(...suggestionsIn(await session.chat(piece, PROMPTS.SPEAKER_NAMES_PROMPT)))
  } catch (error) {
    if (error instanceof Cancelled) throw error
    return recording
  }
  const speakers = applied(recording.speakers, suggestions, transcript)
  return speakers.some((speaker, index) => speaker !== recording.speakers[index]) ? { ...recording, speakers } : recording
}
