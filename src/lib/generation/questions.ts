import { LONG_REPLY_MAX_TOKENS } from '@/controllers/ai.controller'
import { finishQuestions, type RawQuestion, reviewQuestions, validateQuestions } from '@/lib/generation/exam-questions'
import { diagramSchema } from '@/lib/generation/diagram-prompt'
import { extractQuestions } from '@/lib/generation/pipeline'
import { PROMPTS } from '@/lib/generation/prompts.data'
import type { GenerationSession } from '@/lib/generation/session'
import { EXAM_SIZE, searchWebQuestions, type WebOutcome } from '@/lib/generation/web-questions'
import type { AiSettings, FileType } from '@/types/domain'

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

const questionsWord = (count: number) => (count === 1 ? 'questão' : 'questões')

/** The exam prompt's count gives way to what the web questions left. */
function webRoom(found: number): string {
  const most = EXAM_SIZE.max - found
  const least = Math.max(1, EXAM_SIZE.min - found)
  const range = least === most ? `${most}` : `de ${least} a ${most}`
  return `\n## QUESTÕES DA WEB\nA prova já tem ${found} ${found === 1 ? 'questão real tirada' : 'questões reais tiradas'} da web (listadas no fim do conteúdo). Crie só as que faltam: ${range} ${questionsWord(most)}, no lugar de "de ${EXAM_SIZE.min} a ${EXAM_SIZE.max}", variando os formatos sem precisar usar todos. Não repita o que as da web já perguntam.`
}

/** Only the web questions carry a source: one the AI wrote has none. */
function withoutSource(question: RawQuestion): RawQuestion {
  const copy = { ...question }
  delete copy.fonte
  return copy
}

/** `web`: the Questões da web model; its real questions come first and the AI writes the rest. Without it (or when the search fails) the AI writes them all. */
export async function generateQuestions(
  markdown: string,
  title: string,
  fileType: FileType,
  session: GenerationSession,
  wrongQuestions?: WrongQuestion[],
  web: AiSettings | null = null,
): Promise<{ questions: RawQuestion[]; raw: string; web: WebOutcome }> {
  const trimmed = truncateForQuestions(markdown)
  const prep = (await session.chat(`# ${title}\n\n${trimmed}`, prepPrompt(trimmed.length))).trim() || trimmed
  const subject = `# ${title}\n\n${prep}`
  const found = await searchWebQuestions(subject, web, session.signal)
  if (found.questions.length >= EXAM_SIZE.max) return { questions: finishQuestions(found.questions), raw: '', web: found.outcome }
  let content = subject
  if (wrongQuestions?.length) content += `\n\n## Questões que a pessoa errou\n\n${JSON.stringify(wrongQuestions)}`
  let prompt = examPrompt(fileType, Boolean(wrongQuestions?.length))
  if (found.questions.length) {
    content += `\n\n## Questões da web que já estão na prova\n\n${JSON.stringify(found.questions.map(question => question.enunciado))}`
    prompt += webRoom(found.questions.length)
  }
  const { questions, raw } = await askForQuestions(content, prompt, session)
  const reviewed = validateQuestions(await reviewQuestions(questions, session)).map(withoutSource)
  return { questions: finishQuestions([...found.questions, ...reviewed]), raw, web: found.outcome }
}

export async function generateReadingExam(content: string, title: string, session: GenerationSession): Promise<{ questions: RawQuestion[]; raw: string }> {
  const { questions, raw } = await askForQuestions(`# ${title}\n\n${content}`, PROMPTS.READING_EXAM_PROMPT, session)
  return { questions: finishQuestions(questions), raw }
}
