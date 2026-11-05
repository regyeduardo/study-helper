// "Instrução extra para a IA" of the generation dialogs: a marked block at the end of what the model reads.
import type { ChatContent } from '@/controllers/ai.controller'

export const INSTRUCTION_HEAD = '## Instrução de quem pediu (siga com prioridade, sem inventar nada)'

/** The request with the instruction below it (text, or one more part after the audio); empty leaves it as it was. */
export function withInstruction<T extends ChatContent>(content: T, instruction = ''): T {
  const said = instruction.trim()
  if (!said) return content
  const block = `${INSTRUCTION_HEAD}\n\n${said}`
  return (typeof content === 'string' ? `${content}\n\n${block}` : [...content, { type: 'text', text: block }]) as T
}
