import { ApiError, apiMessage } from '@/controllers/api.controller'
import { env } from '@/lib/env'
import { browserLangs, langPlace } from '@/lib/langs/browser'
import type { Schedule } from '@/lib/langs/fsrs'

/**
 * The languages mode (spec 004, contracts/api-idiomas.md): languages, texts, answers and the model voice. In the account's default
 * place (24/11, FR-040): with the structure on, on the server; in the Google Drive or in this browser, the same answers come from the
 * base in the browser (src/lib/langs/browser). Names in English, as the server's.
 */

export type Area = 'lexico' | 'gramatica' | 'semantica' | 'fonologia' | 'ortografia' | 'registro' | 'pragmatica'

export interface Counts {
  items: number
  seen: number
  fixed: number
  due: number
}

export interface LanguageSummary extends Counts {
  code: string
  name: string
  locale: string
  texts: number
}

export type TextStatus = 'generating' | 'ready' | 'failed'

export interface TextRow {
  id: string
  title: string
  status: TextStatus
  error?: string
  progress: 'start' | 'continue' | 'done'
  /** How much of the text the person already knows, in percent (FR-038). */
  known: number
  createdAt: string
  /** While it generates (constitution IV): parts done of how many, when it started, the last part and around when it ends. */
  generation?: { done: number; total: number; startedAt: string; lastAt?: string; endsAt?: string }
}

export interface LanguageDetail extends Counts {
  code: string
  name: string
  locale: string
  areas: Partial<Record<Area, { total: number; seen: number; fixed: number }>>
  texts: TextRow[]
}

export type CardType = 'mc' | 'tf' | 'gap' | 'order' | 'match' | 'odd' | 'listen_mc' | 'minimal_pair' | 'same_diff' | 'find_diff' | 'stress' | 'dictation' | 'dictation_gap' | 'speak'

/** A closed card (prototipo/SCHEMA.md): only the fields of its type are filled. */
export interface Card {
  id: string
  type: CardType
  skill: 'read' | 'listen' | 'speak'
  q: string
  qEn?: string
  covers?: string[]
  needs?: string[]
  expl?: string
  dp?: string
  opts?: string[]
  optsEn?: string[]
  a?: number | boolean | 'same' | 'diff'
  text?: string
  tokens?: string[]
  answer?: string
  pairs?: [string, string][]
  say?: string | string[]
  pair?: [string, string]
  word?: string
  syllables?: string[]
  answers?: string[][]
  mode?: string
  target?: string
  accept?: string[]
  formIsTopic?: boolean
}

export interface Item {
  area: Area
  kind: string
  label: string
  say?: string
  meaning: string
  word?: string
  pattern?: string
  core?: string
  expl?: string
  ex?: string[]
  needs?: string[]
  facets?: Record<string, string>
  test: Card[]
}

export interface LanguageText {
  id: string
  language: string
  locale: string
  title: string
  status: TextStatus
  lines: string[]
  equivalences: string[][]
  items: Record<string, Item>
  practice: Card[]
  context: Card[]
  facets: { id: string; area: string; name: string }[]
  /** What the text's items need and came from other texts (tested and taught after a wrong answer; never the text's own items). */
  needed?: Record<string, Item>
  /** FSRS state of each card of the text the person has answered (spec 004, 24/11: "é por card"); the others are new. */
  schedules?: Record<string, Schedule>
}

export interface AnswerBody {
  textId: string
  cardId: string
  stage: 'test' | 'practice' | 'context'
  promptLang: 'native' | 'target'
  answer: string
  ok: boolean | null
  retry: boolean
  /** The card's FSRS state after this answer (none when skipped). */
  schedule?: Schedule
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = {}
  if (method !== 'GET') headers['X-Estudo'] = '1'
  if (body !== undefined) headers['Content-Type'] = 'application/json'
  let response: Response
  try {
    response = await fetch(`${env.apiUrl}${path}`, { method, credentials: 'include', headers, body: body === undefined ? undefined : JSON.stringify(body) })
  } catch {
    throw new ApiError(0, 'offline')
  }
  if (response.status === 204) return undefined as T
  const answer = (await response.json().catch(() => ({}))) as Record<string, unknown>
  if (!response.ok) {
    const { error, ...data } = answer
    throw new ApiError(response.status, typeof error === 'string' ? error : 'internal_error', data)
  }
  return answer as T
}

const at = (code: string) => `/v1/languages/${encodeURIComponent(code)}`

const inBrowser = browserLangs

export const listLanguages = () => inBrowser()?.langs.listLanguages() ?? call<{ languages: LanguageSummary[] }>('GET', '/v1/languages').then(answer => answer.languages)
export const addLanguage = (body: { code: string; name?: string; locale?: string }) =>
  inBrowser()?.langs.addLanguage(body) ?? call<{ code: string; name: string; locale: string }>('POST', '/v1/languages', body)
export const getLanguage = (code: string) => inBrowser()?.langs.getLanguage(code) ?? call<LanguageDetail>('GET', at(code))
export function addText(code: string, body: { title: string; text: string }): Promise<{ id: string; status: TextStatus }> {
  const browser = inBrowser()
  if (!browser) return call<{ id: string; status: TextStatus }>('POST', `${at(code)}/texts`, body)
  return browser.langs.addText(code, body).then(added => {
    browser.generator.enqueue(code, added.id)
    return added
  })
}
export const getText = (code: string, id: string) => inBrowser()?.langs.getText(code, id) ?? call<LanguageText>('GET', `${at(code)}/texts/${encodeURIComponent(id)}`)
export function retryText(code: string, id: string): Promise<{ status: TextStatus }> {
  const browser = inBrowser()
  if (!browser) return call<{ status: TextStatus }>('POST', `${at(code)}/texts/${encodeURIComponent(id)}/retry`)
  return browser.langs.retryText(code, id).then(answer => {
    browser.generator.enqueue(code, id)
    return answer
  })
}
export const deleteText = (code: string, id: string) => inBrowser()?.langs.deleteText(code, id) ?? call<void>('DELETE', `${at(code)}/texts/${encodeURIComponent(id)}`)
export const recordAnswer = (code: string, body: AnswerBody) => inBrowser()?.langs.recordAnswer(code, body) ?? call<void>('POST', `${at(code)}/answers`, body)
/** The base of the language: each item's skills ("learning" or "fixed") and whether a review is due. */
export const getKnowledge = (code: string) => inBrowser()?.langs.getKnowledge(code) ?? call<Record<string, Record<string, string | boolean>>>('GET', `${at(code)}/knowledge`)
export const getProgress = (code: string, id: string) =>
  inBrowser()?.langs.getProgress(code, id) ?? call<{ state: Record<string, unknown>; updatedAt: string }>('GET', `${at(code)}/texts/${encodeURIComponent(id)}/progress`)
/** "Reportar" (wireframe C): the card is made again another way; the new one comes next time. */
export type ReportReason = 'two_right' | 'wrong_answer' | 'bad_audio' | 'confusing' | 'other'
export const reportCard = (code: string, textId: string, cardId: string, body: { reason: ReportReason; note: string }) =>
  inBrowser()?.generator.report(code, textId, cardId, body.reason, body.note) ??
  call<{ status: 'remaking' }>('POST', `${at(code)}/texts/${encodeURIComponent(textId)}/cards/${encodeURIComponent(cardId)}/report`, body)
export const saveProgress = (code: string, id: string, state: Record<string, unknown>) =>
  inBrowser()?.langs.saveProgress(code, id, state) ?? call<void>('PUT', `${at(code)}/texts/${encodeURIComponent(id)}/progress`, { state })

/** The model voice saying a sentence (mp3, cached on the server). */
export async function speechAudio(text: string, locale: string): Promise<Blob> {
  // in the Drive and in this browser there is no server voice: the browser's voice says it
  if (langPlace() !== 'app') throw new ApiError(0, 'no_server_voice')
  let response: Response
  try {
    response = await fetch(`${env.apiUrl}/v1/speech/tts`, { method: 'POST', credentials: 'include', headers: { 'X-Estudo': '1', 'Content-Type': 'application/json' }, body: JSON.stringify({ text, locale }) })
  } catch {
    throw new ApiError(0, 'offline')
  }
  if (!response.ok) {
    const answer = (await response.json().catch(() => ({}))) as { error?: string }
    throw new ApiError(response.status, answer.error ?? 'internal_error')
  }
  return response.blob()
}

/** Why a text could not be generated, for the person. */
export function failedReason(reason: string | undefined): string {
  switch (reason) {
    case 'provider_down':
      return 'A IA não respondeu agora.'
    case 'invalid_content':
      return 'A IA não conseguiu montar os cards deste texto.'
    case 'ai_not_configured':
      return langPlace() === 'app' ? 'A IA do app ainda não está pronta.' : 'falta escolher o modelo de Cartões.'
    default:
      return 'Não deu para gerar.'
  }
}

/** The sentence the person reads for each refusal of the languages mode. */
export function langsMessage(error: unknown): string {
  if (!(error instanceof ApiError)) return apiMessage(error)
  switch (error.code) {
    case 'app_disabled':
      return 'Os idiomas usam a estrutura do app. Ligue em Configurações › Outros.'
    case 'language_exists':
      return 'Você já estuda este idioma.'
    case 'invalid_language':
      return 'Confira o nome e o código do idioma (ex.: sv, pt-BR).'
    case 'title_required':
      return 'Dê um título ao texto.'
    case 'text_required':
      return 'Cole o texto que você quer estudar.'
    case 'text_too_large':
      return `O texto passa de ${Number(error.data.maxLength || 100000).toLocaleString('pt-BR')} caracteres. Mande uma parte de cada vez.`
    case 'link_unreadable':
      return 'Não deu para ler o link. Cole o texto.'
    case 'not_found':
      return 'Não achei. Talvez tenha sido apagado.'
    case 'not_ready':
      return 'O texto ainda está sendo preparado.'
    case 'provider_down':
      return 'A voz não respondeu agora. Tente de novo.'
    default:
      return apiMessage(error)
  }
}
