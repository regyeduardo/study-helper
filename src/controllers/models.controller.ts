import type { AiProvider } from '@/types/domain'
import type { Media, MediaInfo } from '@/lib/ai/config'
import { providerOf } from '@/lib/ai/providers'

/** Price as the provider says it: per million tokens (input/output) or in another unit (per hour of audio, per image…). */
export type ModelPrice = { input: number | null; output: number | null } | { value: number; unit: string; about: string }

export interface CatalogModel {
  id: string
  name: string
  media: MediaInfo | null
  price?: ModelPrice | null
  /** The provider's own data says the model searches the web. */
  web?: true
}

export type ReadKind = 'nokey' | 'key' | 'http' | 'net' | 'bad'

export class ReadError extends Error {
  constructor(
    readonly kind: ReadKind,
    readonly code?: number,
  ) {
    super(kind)
  }
}

type ProviderAccess = Pick<AiProvider, 'type' | 'key' | 'base'>

const TIMEOUT_MS = 25000

async function getJson(url: string, headers: Record<string, string> = {}): Promise<unknown> {
  const control = new AbortController()
  const timer = setTimeout(() => control.abort(), TIMEOUT_MS)
  let response: Response
  try {
    response = await fetch(url, { headers, signal: control.signal, cache: 'no-store', credentials: 'omit', referrerPolicy: 'no-referrer' })
  } catch {
    throw new ReadError('net')
  } finally {
    clearTimeout(timer)
  }
  if (response.status === 401 || response.status === 403) throw new ReadError('key', response.status)
  if (!response.ok) throw new ReadError('http', response.status)
  try {
    return await response.json()
  } catch {
    throw new ReadError('bad')
  }
}

type Row = Record<string, unknown>

function rows(value: unknown): Row[] {
  if (!Array.isArray(value)) throw new ReadError('bad')
  return value.filter((row): row is Row => typeof row === 'object' && row !== null)
}

const field = (value: unknown, name: string): unknown => (typeof value === 'object' && value !== null ? (value as Row)[name] : undefined)
const bearer = (key: string): Record<string, string> => (key ? { Authorization: `Bearer ${key}` } : {})
const has = (list: unknown[], value: string) => list.includes(value)

function mediaFromList(list: unknown, onlyThese?: Media[]): MediaInfo | null {
  if (!Array.isArray(list)) return null
  const says = (value: string, media: Media) => (has(list, value) ? true : !onlyThese || onlyThese.includes(media) ? false : null)
  return { texto: says('text', 'texto'), imagem: says('image', 'imagem'), audio: says('audio', 'audio'), video: says('video', 'video'), pdf: has(list, 'pdf') || has(list, 'file') ? true : !onlyThese || onlyThese.includes('pdf') ? false : null }
}

const noMedia = (list: Row[]): CatalogModel[] => list.map(model => ({ id: String(model.id), name: String(model.name || model.id), media: null }))

const number = (value: unknown): number | null => {
  const parsed = value === undefined || value === null || value === '' ? NaN : Number(value)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null
}

function perMillion(input: unknown, output?: unknown): ModelPrice | null {
  const read = (value: unknown) => {
    const parsed = number(value)
    return parsed === null ? null : parsed * 1e6
  }
  const inPrice = read(input)
  const outPrice = read(output)
  return inPrice === null && outPrice === null ? null : { input: inPrice, output: outPrice }
}

const inUnit = (value: number, unit: string, about: string): ModelPrice => ({ value, unit, about })

async function readOpenRouter(): Promise<CatalogModel[]> {
  const body = await getJson('https://openrouter.ai/api/v1/models')
  return rows(field(body, 'data')).map(model => {
    const pricing = field(model, 'pricing')
    const params = Array.isArray(model.supported_parameters) ? model.supported_parameters : []
    const web = has(params, 'web_search_options') || String(model.id).endsWith(':online')
    return { id: String(model.id), name: String(model.name || model.id), media: mediaFromList(field(field(model, 'architecture'), 'input_modalities')), price: pricing ? perMillion(field(pricing, 'prompt'), field(pricing, 'completion')) : null, ...(web ? { web: true as const } : {}) }
  })
}

function vercelPrice(pricing: unknown): ModelPrice | null {
  if (!pricing) return null
  const value = (name: string) => number(field(pricing, name))
  const hear = value('transcription_duration_cost_per_second')
  if (hear !== null) return inUnit(hear * 3600, '/h', 'por hora de áudio')
  const chars = value('speech_input_character_cost')
  if (chars !== null) return inUnit(chars * 1e6, '/M car', 'por 1M de caracteres')
  const speak = value('speech_output_cost_per_second')
  if (speak !== null) return inUnit(speak, '/s', 'por segundo de áudio gerado')
  if (value('input') !== null && value('output') !== null) return perMillion(field(pricing, 'input'), field(pricing, 'output'))
  const image = value('image')
  if (image !== null) return inUnit(image, '/img', 'por imagem')
  if (value('input') !== null) return perMillion(field(pricing, 'input'))
  const durations = field(pricing, 'video_duration_pricing')
  const video = Array.isArray(durations) ? durations.map(item => number(field(item, 'cost_per_second'))).filter((item): item is number => item !== null) : []
  if (video.length) return inUnit(Math.min(...video), '/s', 'por segundo de vídeo, a partir de')
  const session = value('realtime_session_duration_cost_per_second')
  return session === null ? null : inUnit(session, '/s', 'por segundo de sessão')
}

async function readVercel(): Promise<CatalogModel[]> {
  const body = await getJson('https://ai-gateway.vercel.sh/v1/models')
  return rows(field(body, 'data')).map(model => {
    const web = Array.isArray(model.tags) && (has(model.tags, 'web-search') || has(model.tags, 'search'))
    return { id: String(model.id), name: String(model.name || model.id), media: mediaFromList(field(field(model, 'modalities'), 'input')), price: vercelPrice(field(model, 'pricing')), ...(web ? { web: true as const } : {}) }
  })
}

function deepInfraPrice(pricing: unknown, hears: boolean): ModelPrice | null {
  if (!pricing) return null
  const dollars = (name: string) => {
    const cents = field(pricing, name)
    return typeof cents === 'number' ? cents / 100 : undefined
  }
  const inputToken = dollars('cents_per_input_token')
  if (inputToken !== undefined) return perMillion(inputToken, dollars('cents_per_output_token'))
  const inputSec = dollars('cents_per_input_sec')
  if (inputSec !== undefined) return inUnit(inputSec * 3600, '/h', 'por hora de áudio')
  const sec = dollars('cents_per_sec')
  if (sec !== undefined) return hears ? inUnit(sec * 3600, '/h', 'por hora de áudio') : inUnit(sec, '/s', 'por segundo de processamento')
  const outputSec = dollars('cents_per_output_sec')
  if (outputSec !== undefined) return inUnit(outputSec, '/s', 'por segundo gerado')
  const image = dollars('cents_per_image_unit')
  if (image !== undefined) return inUnit(image, '/img', 'por imagem')
  const chars = dollars('cents_per_input_chars')
  if (chars !== undefined) return inUnit(chars * 1e6, '/M car', 'por 1M de caracteres')
  const short = String(field(pricing, 'short') ?? '')
  const perSecond = /^\$([\d.]+) \/ second/.exec(short)
  return perSecond ? inUnit(Number(perSecond[1]), '/s', short) : null
}

async function readDeepInfra(): Promise<CatalogModel[]> {
  return rows(await getJson('https://api.deepinfra.com/models/list')).map(model => {
    const tags = Array.isArray(model.tags) ? model.tags : []
    const type = String(model.type || '')
    const hears = /speech-recognition/.test(type)
    const sees = /image-classification/.test(type)
    return {
      id: String(model.model_name),
      name: String(model.model_name).split('/').pop() ?? String(model.model_name),
      media: { texto: !hears && !sees, imagem: sees || has(tags, 'multimodal'), audio: hears || has(tags, 'input-audio'), video: has(tags, 'input-video'), pdf: null },
      price: deepInfraPrice(model.pricing, hears),
    }
  })
}

async function readDeepSeek(access: ProviderAccess): Promise<CatalogModel[]> {
  return rows(field(await getJson('https://api.deepseek.com/models', bearer(access.key)), 'data')).map(model => ({ id: String(model.id), name: String(model.id), media: mediaFromList(model.input_modalities) }))
}

async function readXai(access: ProviderAccess): Promise<CatalogModel[]> {
  const body = await getJson('https://api.x.ai/v1/language-models', bearer(access.key))
  return rows(field(body, 'models') ?? field(body, 'data')).map(model => ({ id: String(model.id), name: String(model.id), media: mediaFromList(model.input_modalities, ['texto', 'imagem']) }))
}

async function readAnthropic(access: ProviderAccess): Promise<CatalogModel[]> {
  const found: Row[] = []
  let after = ''
  for (let page = 0; page < 20; page++) {
    const url = `https://api.anthropic.com/v1/models?limit=1000${after ? `&after_id=${encodeURIComponent(after)}` : ''}`
    const body = await getJson(url, { 'x-api-key': access.key, 'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true' })
    found.push(...rows(field(body, 'data')))
    const last = field(body, 'last_id')
    if (!field(body, 'has_more') || !last) break
    after = String(last)
  }
  return found.map(model => {
    const flag = (name: string) => {
      const supported = field(field(model.capabilities, name), 'supported')
      return typeof supported === 'boolean' ? supported : null
    }
    return { id: String(model.id), name: String(model.display_name || model.id), media: { texto: true, imagem: flag('image_input'), audio: false, video: false, pdf: flag('pdf_input') } }
  })
}

async function readMistral(access: ProviderAccess): Promise<CatalogModel[]> {
  return rows(field(await getJson('https://api.mistral.ai/v1/models', bearer(access.key)), 'data')).map(model => {
    const can = model.capabilities
    return {
      id: String(model.id),
      name: String(model.name || model.id),
      media: can ? { texto: Boolean(field(can, 'completion_chat')), imagem: Boolean(field(can, 'vision')), audio: Boolean(field(can, 'audio')) || Boolean(field(can, 'audio_transcription')), video: null, pdf: null } : null,
    }
  })
}

async function readOpenAi(access: ProviderAccess): Promise<CatalogModel[]> {
  return noMedia(rows(field(await getJson('https://api.openai.com/v1/models', bearer(access.key)), 'data')))
}

async function readGemini(access: ProviderAccess): Promise<CatalogModel[]> {
  const found: Row[] = []
  let token = ''
  for (let page = 0; page < 20; page++) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000${token ? `&pageToken=${encodeURIComponent(token)}` : ''}`
    const body = await getJson(url, { 'x-goog-api-key': access.key })
    found.push(...rows(field(body, 'models')))
    const next = field(body, 'nextPageToken')
    if (!next) break
    token = String(next)
  }
  return found.map(model => ({ id: String(model.name).replace(/^models\//, ''), name: String(model.displayName || model.name), media: null }))
}

async function readGroq(access: ProviderAccess): Promise<CatalogModel[]> {
  return noMedia(rows(field(await getJson('https://api.groq.com/openai/v1/models', bearer(access.key)), 'data')))
}

async function readTogether(access: ProviderAccess): Promise<CatalogModel[]> {
  const body = await getJson('https://api.together.xyz/v1/models', bearer(access.key))
  return rows(Array.isArray(body) ? body : field(body, 'data')).map(model => ({ id: String(model.id), name: String(model.display_name || model.id), media: null }))
}

export function customListUrl(base: string): string {
  const trimmed = base.trim().replace(/\/+$/, '')
  return /\/v\d+[a-z]*$/i.test(trimmed) ? `${trimmed}/models` : `${trimmed}/v1/models`
}

async function readCustom(access: ProviderAccess): Promise<CatalogModel[]> {
  const body = await getJson(customListUrl(access.base), bearer(access.key))
  const list = rows(Array.isArray(body) ? body : (field(body, 'data') ?? field(body, 'models')))
  return noMedia(list.map(model => ({ id: model.id || model.name, name: model.name || model.id })).filter(model => model.id))
}

const READERS: Record<AiProvider['type'], (access: ProviderAccess) => Promise<CatalogModel[]>> = {
  deepinfra: readDeepInfra,
  openrouter: readOpenRouter,
  vercel: readVercel,
  deepseek: readDeepSeek,
  xai: readXai,
  anthropic: readAnthropic,
  mistral: readMistral,
  openai: readOpenAi,
  gemini: readGemini,
  groq: readGroq,
  together: readTogether,
  custom: readCustom,
}

/** The provider's model list, read now (never stored). Public lists do not need the key. */
export async function fetchModelList(access: ProviderAccess): Promise<CatalogModel[]> {
  if (providerOf(access.type).needsKey && !access.key) throw new ReadError('nokey')
  return READERS[access.type](access)
}
