import type { AiSettings } from '@/types/domain'
import { extractJson } from '@/lib/generation/mermaid'
import { GenerationSession } from '@/lib/generation/session'

export interface MissedQuestion {
  number: number
  statement: string
  right: string
  given: string
  explanation: string
}

export interface LearningGap {
  title: string
  missing: string
  questions: number[]
}

export interface Diagnosis {
  gaps: LearningGap[]
  single: boolean
}

const MAX_GAPS = 6

export const DIAGNOSIS_PROMPT = `Você é um professor fazendo o diagnóstico de uma prova. Recebe as questões que o aluno errou ou acertou só em parte,
cada uma com a resposta certa, a resposta dele e a explicação.

Agrupe os erros pelo conceito que faltou aprender: erros diferentes sobre o mesmo conceito viram UM tema só. No máximo ${MAX_GAPS} temas.
Para cada tema, diga em uma frase o que o aluno não entendeu (o equívoco, não o assunto em geral).

Decida também o formato das explicações:
- "unica": uma nota só com tudo, quando os temas são poucos (até 2) ou todos do mesmo assunto;
- "por_tema": uma nota por tema, quando são assuntos separados.

Escreva em português do Brasil. Responda SOMENTE com um objeto JSON, sem cercas de markdown:
{"temas": [{"titulo": "...", "o_que_faltou": "...", "questoes": [1, 3]}], "formato": "unica"}`

export function describeMissed(missed: MissedQuestion[]): string {
  return missed
    .map(item => [`Questão ${item.number}: ${item.statement}`, `Resposta certa: ${item.right}`, `Resposta do aluno: ${item.given}`, `Explicação: ${item.explanation}`].join('\n'))
    .join('\n\n')
}

export function readDiagnosis(payload: unknown): Diagnosis {
  const body = (payload ?? {}) as { temas?: unknown; formato?: unknown }
  const gaps = (Array.isArray(body.temas) ? body.temas : [])
    .map(item => item as { titulo?: unknown; o_que_faltou?: unknown; questoes?: unknown })
    .filter(item => typeof item.titulo === 'string' && item.titulo.trim())
    .slice(0, MAX_GAPS)
    .map(item => ({
      title: String(item.titulo).trim(),
      missing: typeof item.o_que_faltou === 'string' ? item.o_que_faltou.trim() : '',
      questions: Array.isArray(item.questoes) ? item.questoes.map(Number).filter(Number.isFinite) : [],
    }))
  return { gaps, single: body.formato !== 'por_tema' || gaps.length <= 1 }
}

export async function diagnoseMistakes(missed: MissedQuestion[], settings: AiSettings, signal?: AbortSignal): Promise<Diagnosis> {
  const session = new GenerationSession(settings, signal)
  for (let attempt = 0; attempt < 3; attempt++) {
    const diagnosis = readDiagnosis(extractJson(await session.chat(describeMissed(missed), DIAGNOSIS_PROMPT)))
    if (diagnosis.gaps.length) return diagnosis
  }
  throw new Error('A IA não devolveu um diagnóstico que dê pra usar. Tente de novo.')
}

export function gapExcerpt(gaps: LearningGap[], missed: MissedQuestion[]): string {
  return gaps
    .map(gap => {
      const examples = missed.filter(item => gap.questions.includes(item.number))
      const lines = [`Tema: ${gap.title}`, gap.missing && `O que faltou: ${gap.missing}`, ...examples.map(item => `Questão errada: ${item.statement} (certa: ${item.right}; a do aluno: ${item.given})`)]
      return lines.filter(Boolean).join('\n')
    })
    .join('\n\n')
}
