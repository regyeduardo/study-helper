import type { Artifact, ArtifactKind, MapNode } from '@/types/domain'
import { Cancelled } from '@/controllers/ai.controller'
import { withInstruction } from '@/lib/generation/instruction'
import { extractJson } from '@/lib/generation/mermaid'
import { transcriptChunks } from '@/lib/generation/minutes'
import type { GenerationSession } from '@/lib/generation/session'
import { cleanTitle } from '@/lib/generation/title'

export const NAME_PROMPT = `Você dá nome a um material de estudo feito a partir de uma nota, em português do Brasil: um mapa mental, um baralho de cartões de memorização ou uma conversa com o tutor. Você recebe o tipo e o conteúdo do material e, às vezes, a instrução de quem pediu. Responda só com JSON no formato {"nome": "..."}. O nome diz do que trata ESTE material, com 2 a 6 palavras, sem aspas e sem ponto final, sem repetir o tipo (nada de "Mapa mental de…" ou "Cartões sobre…"). Se houver instrução, o nome mostra o foco dela. Use os nomes de conceitos, matérias, projetos e pessoas que aparecem no conteúdo. Se o conteúdo não tiver assunto claro, devolva {"nome": ""}.`

const KIND_LABELS: Record<ArtifactKind, string> = { mapa: 'mapa mental', cartoes: 'cartões de memorização', tutor: 'conversa com o tutor' }
const NAME_TOKENS = 200

/** The artifact's own text: a map's nodes, a deck's fronts, a conversation's turns. */
export function nameSource(artifact: Artifact): string {
  if (artifact.kind === 'cartoes') return artifact.cards.map(card => card.front).join('\n')
  if (artifact.kind === 'tutor') return artifact.turns.map(turn => `${turn.who === 'você' ? 'Pessoa' : 'Tutor'}: ${turn.text}`).join('\n')
  const lines = (node: MapNode, depth: number): string[] => [`${'  '.repeat(depth)}${node.mark ? `${node.mark} ` : ''}${node.text}`, ...node.children.flatMap(child => lines(child, depth + 1))]
  return lines(artifact.diagram.root, 0).join('\n')
}

/** A short, specific name for an artifact, from its content; null when the AI fails or has none. */
export async function nameArtifact(content: string, kind: ArtifactKind, instruction = '', session: GenerationSession): Promise<string | null> {
  const opening = transcriptChunks(content.trim())[0]
  if (!opening) return null
  let answer: string
  try {
    answer = await session.chat(withInstruction(`Tipo: ${KIND_LABELS[kind]}\n\nConteúdo:\n${opening}`, instruction), NAME_PROMPT, NAME_TOKENS)
  } catch (error) {
    if (error instanceof Cancelled) throw error
    return null
  }
  return cleanTitle(extractJson(answer)?.nome)
}
