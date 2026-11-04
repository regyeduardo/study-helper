import { afterEach, describe, expect, it, vi } from 'vitest'

import type { AiSettings } from '@/types/domain'
import { probeWeb } from '@/lib/ai/probe'
import { installFetch } from '@/test/ai/fake-provider'

const openrouter: AiSettings = { provider: 'openrouter', baseUrl: '', apiKey: 'chave-or', model: 'openai/gpt-oss-120b' }
const deepinfra: AiSettings = { provider: 'deepinfra', baseUrl: '', apiKey: 'chave-di', model: 'openai/gpt-oss-120b' }

const PAGE = 'https://provas.exemplo.org/enem-2019/questao-91'

const reply = (content: string, cited: string[] = []) =>
  new Response(JSON.stringify({ choices: [{ message: { content, annotations: cited.map(url => ({ type: 'url_citation', url_citation: { url, title: 'Questão' } })) } }] }), { status: 200 })

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('Testar: pesquisa na web', () => {
  it('no OpenRouter liga o plugin web e pede uma questão real, como a Questões da web', async () => {
    const { calls } = installFetch(() => reply(JSON.stringify({ url: PAGE }), [PAGE]))
    await probeWeb(openrouter)
    expect(calls[0].body?.plugins).toEqual([{ id: 'web', max_results: 1 }])
    expect(JSON.stringify(calls[0].body?.messages)).toContain('questão')
  })

  it('pesquisa: a página que o modelo cita veio da pesquisa', async () => {
    installFetch(() => reply(JSON.stringify({ url: `${PAGE}/` }), [PAGE]))
    expect(await probeWeb(openrouter)).toEqual({ state: 'yes' })
  })

  it('a pesquisa veio, mas o modelo a ignorou e diz que não pesquisa: não serve', async () => {
    installFetch(() => reply('{"url": null}', [PAGE]))
    expect(await probeWeb(openrouter)).toEqual({ state: 'no' })
  })

  it('a pesquisa veio, mas o modelo cita uma página que não estava nela: não serve', async () => {
    installFetch(() => reply('{"url": "https://timeapi.io/api/time/current"}', [PAGE]))
    expect(await probeWeb(openrouter)).toEqual({ state: 'no' })
  })

  it('sem pesquisa nenhuma (DeepInfra), uma página inventada não conta', async () => {
    installFetch(() => reply(JSON.stringify({ url: PAGE })))
    expect(await probeWeb(deepinfra)).toEqual({ state: 'no' })
  })
})
