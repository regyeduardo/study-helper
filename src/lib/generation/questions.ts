import { LONG_REPLY_MAX_TOKENS } from '@/controllers/ai.controller'
import { finishQuestions, type RawQuestion, reviewQuestions, validateQuestions } from '@/lib/generation/exam-questions'
import { diagramSchema } from '@/lib/generation/diagram-prompt'
import { extractQuestions } from '@/lib/generation/pipeline'
import { PROMPTS } from '@/lib/generation/prompts.data'
import type { GenerationSession } from '@/lib/generation/session'
import type { FileType } from '@/types/domain'

const MAX_QUESTION_INPUT_CHARS = 40000
const EXAM_ATTEMPTS = 3

export interface WrongQuestion {
  enunciado: string
  explicacao: string
}

function prepPrompt(materialChars: number): string {
  const limit = Math.max(PROMPTS.PREP_MIN_CHARS, Math.min(PROMPTS.PREP_MAX_CHARS, Math.floor(materialChars / 3)))
  return PROMPTS.QUESTIONS_PREP_PROMPT.replace('{limite}', String(limit))
}

export function examPrompt(fileType: FileType = 'class', adaptive = false): string {
  const focus = PROMPTS.FILE_TYPE_FOCUS as Record<string, string>
  const parts = [
    PROMPTS.EXAM_PROMPT,
    focus[fileType] ?? focus.class,
    PROMPTS.EXAM_FORMATS,
    PROMPTS.ALTERNATIVE_RULES,
    PROMPTS.WRONG_FROM_REAL_ERRORS,
    PROMPTS.EXAM_DIAGRAMS,
    ['flowchart', 'sequence', 'state', 'pie'].map(diagramSchema).join('\n'),
    PROMPTS.EXAM_JSON,
    PROMPTS.EXAM_SELF_CONTAINED,
  ]
  if (adaptive) parts.push(PROMPTS.ADAPTIVE_FOCUS)
  return parts.join('\n')
}

function truncateForQuestions(markdown: string): string {
  if (markdown.length <= MAX_QUESTION_INPUT_CHARS) return markdown
  let cut = markdown.lastIndexOf('\n## ', MAX_QUESTION_INPUT_CHARS)
  if (cut < 0) cut = MAX_QUESTION_INPUT_CHARS
  return markdown.slice(0, cut).trim()
}

async function askForQuestions(content: string, systemPrompt: string, session: GenerationSession): Promise<{ questions: RawQuestion[]; raw: string }> {
  let raw = ''
  for (let attempt = 1; attempt <= EXAM_ATTEMPTS; attempt++) {
    raw = await session.chat(content, systemPrompt, LONG_REPLY_MAX_TOKENS)
    const questions = validateQuestions(extractQuestions(raw))
    if (questions.length) return { questions, raw }
  }
  return { questions: [], raw }
}

export async function generateQuestions(
  markdown: string,
  title: string,
  fileType: FileType,
  session: GenerationSession,
  wrongQuestions?: WrongQuestion[],
): Promise<{ questions: RawQuestion[]; raw: string }> {
  const trimmed = truncateForQuestions(markdown)
  const prep = (await session.chat(`# ${title}\n\n${trimmed}`, prepPrompt(trimmed.length))).trim() || trimmed
  let content = `# ${title}\n\n${prep}`
  if (wrongQuestions?.length) content += `\n\n## Questões que a pessoa errou\n\n${JSON.stringify(wrongQuestions)}`
  const { questions, raw } = await askForQuestions(content, examPrompt(fileType, Boolean(wrongQuestions?.length)), session)
  const reviewed = await reviewQuestions(questions, session)
  return { questions: finishQuestions(validateQuestions(reviewed)), raw }
}

export async function generateReadingExam(content: string, title: string, session: GenerationSession): Promise<{ questions: RawQuestion[]; raw: string }> {
  const { questions, raw } = await askForQuestions(`# ${title}\n\n${content}`, PROMPTS.READING_EXAM_PROMPT, session)
  return { questions: finishQuestions(questions), raw }
}
