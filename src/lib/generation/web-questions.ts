import type { AiSettings } from '@/types/domain'
import { chatController, LONG_REPLY_MAX_TOKENS } from '@/controllers/ai.controller'
import { modelOf, providerOf } from '@/lib/ai/providers'
import { type RawQuestion, validateQuestions } from '@/lib/generation/exam-questions'
import { extractQuestions } from '@/lib/generation/pipeline'

/** The size of a Prova (EXAM_FORMATS asks for 12 to 15): the web questions take what they can, the AI writes the rest. */
export const EXAM_SIZE = { min: 12, max: 15 }

export const WEB_QUESTIONS_PROMPT = `Você pesquisa na web questões REAIS de prova sobre o assunto do material abaixo, para a pessoa
treinar com elas.

## ONDE PROCURAR
Provas e listas publicadas: vestibulares, ENEM, concursos, OAB, provas de faculdade, certificações,
olimpíadas, bancos de questões, em qualquer idioma.

## O QUE TRAZER
- Só questões que você achou de fato numa página nesta pesquisa. Nunca invente questão, gabarito ou endereço.
- Só questões do assunto do material. As que fogem dele ficam de fora.
- Não há número fixo: traga todas as boas que achar. Se não achar nenhuma, devolva {"questions": []}.
- Questão em outro idioma: traduza tudo (enunciado, alternativas, explicação) para o português do Brasil.
- Fora a tradução, o enunciado e as alternativas ficam como na fonte.
- Pule a questão que depende de figura ou gráfico que não dá para escrever em texto. Tabela vai em markdown.
- Gabarito: use o oficial da fonte; sem gabarito na fonte, resolva e confira antes de marcar.
- "explicacao": por que a resposta certa é a certa, em poucas frases.
- "fonte": o endereço completo (https://...) da página onde a questão está.

## FORMATO DE SAÍDA
Responda com UM objeto JSON, sem cercas de markdown e sem texto fora do JSON:
{"questions": [ ...questões... ]}

Cada questão vira um destes tipos:
- unica (4 ou 5 alternativas, como na fonte, uma certa): {"tipo": "unica", "enunciado": "...",
  "alternativas": {"A": "...", "B": "...", "C": "...", "D": "...", "E": "..."}, "correta": "B",
  "explicacao": "...", "fonte": "https://..."}
  Se a original tem 4 alternativas, mantenha as 4, de "A" a "D", sem "E".
- multipla (marque todas, de 2 a 4 certas): igual à unica, trocando "correta" por "corretas": ["A", "D"].
- certo_errado (uma afirmação para julgar): {"tipo": "certo_errado", "enunciado": "...", "certo": true,
  "explicacao": "...", "fonte": "https://..."}
Questão aberta ou de outro formato fica de fora.

Tudo em português do Brasil, menos o endereço da fonte. Devolva apenas JSON válido.
`

/** What the web gave the Prova: how many questions and the line that tells the person. */
export interface WebOutcome {
  found: number
  note: string
}

const ONLY_AI = 'A prova saiu só com questões criadas pela IA.'
const NO_WEB_MODEL = `Sem questões da web: nenhum modelo que pesquise na web em Configurações › Inteligência artificial › Padrões por uso › Questões da web. ${ONLY_AI}`

/** What turns search on: OpenRouter's web plugin (any model), the native search of the other OpenAI-format providers. */
function searchFields(target: AiSettings): Record<string, unknown> | null {
  if (providerOf(target.provider).format !== 'openai') return null
  // `undefined` drops the temperature from the body: OpenAI's search models refuse it
  return target.provider === 'openrouter' ? { plugins: [{ id: 'web' }], temperature: undefined } : { web_search_options: {}, temperature: undefined }
}

const withSource = (item: unknown): item is Record<string, unknown> & { fonte: string } =>
  typeof item === 'object' && item !== null && typeof (item as Record<string, unknown>).fonte === 'string' && /^https?:\/\/\S+$/.test(((item as Record<string, unknown>).fonte as string).trim())

/** Asks the Questões da web model for real exam questions on the subject; never fails the Prova (only a cancel goes through). */
export async function searchWebQuestions(subject: string, target: AiSettings | null, signal?: AbortSignal): Promise<{ questions: RawQuestion[]; outcome: WebOutcome }> {
  const none = (note: string) => ({ questions: [], outcome: { found: 0, note } })
  if (!target) return none(NO_WEB_MODEL)
  const fields = searchFields(target)
  if (!fields) return none(`Sem questões da web: o app não pesquisa na web com ${modelOf(target)} (${providerOf(target.provider).name}). ${ONLY_AI}`)
  let raw: string
  try {
    raw = (await chatController(target, subject, WEB_QUESTIONS_PROMPT, LONG_REPLY_MAX_TOKENS, signal, undefined, fields)).text
  } catch (error) {
    if (signal?.aborted) throw error
    const reason = (error instanceof Error ? error.message : String(error)).trim().replace(/\.$/, '')
    return none(`Sem questões da web: a pesquisa falhou (${reason}). ${ONLY_AI}`)
  }
  const sourced = extractQuestions(raw)
    .filter(withSource)
    .map(item => ({ ...item, fonte: item.fonte.trim() }))
  const questions = validateQuestions(sourced, 4)
  if (!questions.length) return none(`Sem questões da web: a pesquisa não achou questões reais sobre o assunto. ${ONLY_AI}`)
  const count = questions.length
  return { questions, outcome: { found: count, note: `${count} ${count === 1 ? 'questão veio' : 'questões vieram'} da web, cada uma com a fonte.` } }
}
