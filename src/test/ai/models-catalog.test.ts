import { afterEach, describe, expect, it, vi } from 'vitest'

import { customListUrl, fetchModelList, ReadError } from '@/controllers/models.controller'
import { errLong, errShort, money, priceSide, sortedModels, nextSort } from '@/lib/ai/catalog'
import { useModelsStore } from '@/stores/models'
import { installFetch, jsonResponse } from '@/test/ai/fake-provider'

const failure = (reading: Promise<unknown>): Promise<ReadError> => reading.then(() => Promise.reject(new Error('leu')), error => error as ReadError)

afterEach(() => {
  vi.unstubAllGlobals()
  useModelsStore.setState({ live: {}, probes: {} })
})

describe('each provider is read live, with what each model accepts and its price', () => {
  it('OpenRouter: public list, media from input_modalities and price per million tokens', async () => {
    const { calls } = installFetch(() => jsonResponse({ data: [{ id: 'google/gemini-x', name: 'Gemini X', architecture: { input_modalities: ['text', 'image', 'audio', 'video', 'file'], output_modalities: ['text'] }, pricing: { prompt: '0.0000003', completion: '0.0000025' } }] }))
    const list = await fetchModelList({ type: 'openrouter', key: '', base: '' })
    expect(calls[0].url).toBe('https://openrouter.ai/api/v1/models')
    expect(calls[0].headers.Authorization).toBeUndefined()
    expect(list).toEqual([{ id: 'google/gemini-x', name: 'Gemini X', media: { texto: true, imagem: true, audio: true, video: true, pdf: true }, price: { input: 0.3, output: 2.5 } }])
  })

  it('DeepInfra: public list; tags say audio and video; price in cents per token or per second of audio', async () => {
    installFetch(() =>
      jsonResponse([
        { model_name: 'nvidia/Nemotron-Omni', type: 'text-generation', tags: ['multimodal', 'input-audio', 'input-video'], pricing: { cents_per_input_token: 0.00002, cents_per_output_token: 0.00008 } },
        { model_name: 'openai/whisper-large-v3', type: 'automatic-speech-recognition', tags: [], pricing: { cents_per_input_sec: 0.0045 } },
      ]),
    )
    const [omni, whisper] = await fetchModelList({ type: 'deepinfra', key: '', base: '' })
    expect(omni).toMatchObject({ id: 'nvidia/Nemotron-Omni', name: 'Nemotron-Omni', media: { texto: true, imagem: true, audio: true, video: true, pdf: null } })
    expect(omni.price).toEqual({ input: expect.closeTo(0.2, 6), output: expect.closeTo(0.8, 6) })
    expect(whisper.media).toEqual({ texto: false, imagem: false, audio: true, video: false, pdf: null })
    expect(whisper.price).toEqual({ value: expect.closeTo(0.162, 6), unit: '/h', about: 'por hora de áudio' })
  })

  it('Anthropic: with the key, every page, image and PDF from the capabilities', async () => {
    const { calls } = installFetch(request =>
      request.url.includes('after_id')
        ? jsonResponse({ data: [{ id: 'claude-b', display_name: 'Claude B', capabilities: {} }], has_more: false })
        : jsonResponse({ data: [{ id: 'claude-a', display_name: 'Claude A', capabilities: { image_input: { supported: true }, pdf_input: { supported: false } } }], has_more: true, last_id: 'claude-a' }),
    )
    const list = await fetchModelList({ type: 'anthropic', key: 'sk-ant', base: '' })
    expect(calls).toHaveLength(2)
    expect(calls[0].headers['x-api-key']).toBe('sk-ant')
    expect(list.map(model => model.media)).toEqual([
      { texto: true, imagem: true, audio: false, video: false, pdf: false },
      { texto: true, imagem: null, audio: false, video: false, pdf: null },
    ])
  })

  it('Personalizado reads <base>/models (or /v1/models) and does not say the media', async () => {
    expect(customListUrl('https://x.example/v1/')).toBe('https://x.example/v1/models')
    expect(customListUrl('http://localhost:11434')).toBe('http://localhost:11434/v1/models')
    const { calls } = installFetch(() => jsonResponse({ data: [{ id: 'llama3' }] }))
    expect(await fetchModelList({ type: 'custom', key: 'k', base: 'https://x.example/v1' })).toEqual([{ id: 'llama3', name: 'llama3', media: null }])
    expect(calls[0].headers.Authorization).toBe('Bearer k')
  })

  it('says why it could not read: no key, refused key, error, no answer', async () => {
    await expect(fetchModelList({ type: 'deepseek', key: '', base: '' })).rejects.toMatchObject({ kind: 'nokey' })
    installFetch(() => jsonResponse({ error: 'no' }, 401))
    const refused = await failure(fetchModelList({ type: 'openai', key: 'x', base: '' }))
    expect(errShort(refused)).toBe('recusada (401)')
    expect(errLong(refused)).toBe('chave recusada (401)')
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new TypeError('offline'))))
    expect(errLong(await failure(fetchModelList({ type: 'openrouter', key: '', base: '' })))).toBe('o provedor não respondeu')
  })
})

describe('prices and order', () => {
  it('writes dollars in pt-BR and sorts by price, the ones without price at the end', () => {
    expect(money(0.3)).toBe('US$ 0,30')
    expect(money(2.5)).toBe('US$ 2,50')
    expect(priceSide({ input: 0.3, output: 2.5 }, 'in')).toMatchObject({ group: 0, value: 0.3, text: 'US$ 0,30' })
    expect(priceSide({ value: 0.16, unit: '/h', about: 'por hora de áudio' }, 'in')).toMatchObject({ group: 1, text: 'US$ 0,16/h' })
    const list = [
      { name: 'B', price: { input: 2, output: 3 } },
      { name: 'A', price: null },
      { name: 'C', price: { input: 0.1, output: 0.2 } },
    ]
    const sort = { key: null as 'name' | 'in' | 'out' | null, dir: 1 }
    nextSort(sort, 'in')
    expect(sortedModels(list, sort, item => item.price).map(item => item.name)).toEqual(['C', 'B', 'A'])
    nextSort(sort, 'in')
    expect(sortedModels(list, sort, item => item.price).map(item => item.name)).toEqual(['B', 'C', 'A'])
    nextSort(sort, 'in')
    expect(sort.key).toBeNull()
  })
})

describe('the live list lives only in memory', () => {
  it('reading marks the provider as being read, then keeps the list by id; an error is kept with its kind', async () => {
    installFetch(() => jsonResponse({ data: [{ id: 'm1', name: 'M1', architecture: { input_modalities: ['text'] } }] }))
    const reading = useModelsStore.getState().read({ id: 'or', type: 'openrouter', name: 'OpenRouter', key: '', base: '' }, true)
    expect(useModelsStore.getState().live.or.state).toBe('reading')
    await reading
    const live = useModelsStore.getState().live.or
    expect(live.state === 'ok' && live.byId.get('m1')?.name).toBe('M1')
    await useModelsStore.getState().read({ id: 'ds', type: 'deepseek', name: 'DeepSeek', key: '', base: '' }, true)
    const failed = useModelsStore.getState().live.ds
    expect(failed.state === 'error' && failed.error.kind).toBe('nokey')
  })
})

describe('web search, only when confirmed', () => {
  it('OpenRouter says it in supported_parameters or with :online; Testar can confirm the others; unknown is not enough', async () => {
    const { searchesWeb } = await import('@/stores/models')
    installFetch(() => jsonResponse({ data: [{ id: 'perplexity/sonar', supported_parameters: ['web_search_options'] }, { id: 'x/plain' }, { id: 'x/plain:online' }] }))
    await useModelsStore.getState().read({ id: 'or', type: 'openrouter', name: 'OpenRouter', key: '', base: '' }, true)
    const config = { providers: [{ id: 'or', type: 'openrouter' as const, name: 'OpenRouter', key: '', base: '' }], models: ['perplexity/sonar', 'x/plain', 'x/plain:online'].map(mid => ({ uid: `or::${mid}`, pid: 'or', mid, name: mid })), defaults: {}, steps: {} }
    const { live, probes } = useModelsStore.getState()
    expect(['perplexity/sonar', 'x/plain', 'x/plain:online'].map(mid => searchesWeb(config, live, probes, `or::${mid}`))).toEqual([true, false, true])
    expect(searchesWeb(config, live, { 'or::x/plain': { web: { state: 'yes' } } }, 'or::x/plain')).toBe(true)
  })
})
