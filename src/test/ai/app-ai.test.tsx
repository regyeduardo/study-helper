// Spec 006 (dono, 23/11): quem usa a estrutura do app não escolhe modelo nem vê chave; a IA é a do app, pelo servidor, com a chave da
// env. A IA que a pessoa já configurou não se perde: fica guardada e volta ao desligar a estrutura (FR-007).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'

const { mockEnv } = vi.hoisted(() => ({ mockEnv: { apiUrl: 'https://api.example.test' } }))
vi.mock('@/lib/env', async importOriginal => ({ env: { ...((await importOriginal()) as { env: object }).env, apiUrl: mockEnv.apiUrl } }))

import type { AiConfig, Settings } from '@/types/domain'
import { ModelPick, useModelChoice } from '@/components/dialogs/ModelPick'
import { aiFetch, APP_KEY, followAppAi, toAppConfig, useAppAiStore } from '@/lib/ai/app-ai'
import { aiConfigOf, normalizeSettings, targetFor } from '@/lib/ai/config'
import { defaultIndex } from '@/lib/defaults'
import { useLibraryStore } from '@/stores/library'

/** What the administration chose (as the server keeps it: no key). */
const ADMIN: AiConfig = {
  providers: [{ id: 'p-deep', type: 'deepinfra', name: 'DeepInfra', key: '', base: '' }],
  models: [{ uid: 'm-whisper', pid: 'p-deep', mid: 'openai/whisper-large-v3-turbo', name: 'whisper-large-v3-turbo' } as AiConfig['models'][number]],
  defaults: { transcricao: 'm-whisper' },
  steps: {},
}

/** The person's own AI, with her own key. */
const OWN: AiConfig = {
  providers: [{ id: 'p-mine', type: 'openai', name: 'Minha OpenAI', key: 'sk-da-pessoa', base: '' }],
  models: [{ uid: 'm-mine', pid: 'p-mine', mid: 'gpt-4o-mini-transcribe', name: 'gpt-4o-mini-transcribe' } as AiConfig['models'][number]],
  defaults: { transcricao: 'm-mine' },
  steps: {},
}

function personSettings(): Settings {
  return { ...defaultIndex().settings, aiConfig: OWN }
}

function Pick() {
  const choice = useModelChoice('transcricao')
  return <ModelPick choice={choice} label="Transcrição" />
}

let calls: { url: string; init: RequestInit }[]

beforeEach(() => {
  calls = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit = {}) => {
      calls.push({ url, init })
      if (url === `${mockEnv.apiUrl}/v1/ai/config`) return new Response(JSON.stringify({ providers: ['deepinfra'], uses: ADMIN }), { status: 200 })
      return new Response('{}', { status: 200 })
    }),
  )
  useLibraryStore.setState({ index: { ...defaultIndex(), settings: personSettings() } })
  useAppAiStore.setState({ config: null, providers: [] })
})

afterEach(() => {
  followAppAi(false)
  vi.unstubAllGlobals()
})

describe('IA do app com a estrutura ligada', () => {
  it('a chamada a um provedor vai ao servidor, sem a chave do navegador e com a sessão', async () => {
    useAppAiStore.setState({ config: toAppConfig(ADMIN, ['deepinfra']), providers: ['deepinfra'] })
    await aiFetch('https://api.deepinfra.com/v1/openai/chat/completions', { method: 'POST', headers: { Authorization: `Bearer ${APP_KEY}`, 'Content-Type': 'application/json' }, body: '{}' })
    const call = calls.at(-1)!
    expect(call.url).toBe(`${mockEnv.apiUrl}/v1/ai/deepinfra/v1/openai/chat/completions`)
    expect(new Headers(call.init.headers).get('authorization')).toBeNull()
    expect(new Headers(call.init.headers).get('x-estudo')).toBe('1')
    expect(call.init.credentials).toBe('include')
  })

  it('sem a estrutura, a chamada vai direto ao provedor, como hoje', async () => {
    await aiFetch('https://api.openai.com/v1/audio/transcriptions', { method: 'POST', headers: { Authorization: 'Bearer sk-da-pessoa' } })
    expect(calls.at(-1)!.url).toBe('https://api.openai.com/v1/audio/transcriptions')
  })

  it('não há seletor de modelo: o modelo é o que o dono escolheu para o uso', async () => {
    followAppAi(true)
    await vi.waitFor(() => expect(useAppAiStore.getState().config).not.toBeNull())
    render(<Pick />)
    expect(screen.queryByRole('combobox')).toBeNull()
    expect(targetFor(useLibraryStore.getState().index.settings, 'transcricao')).toMatchObject({ provider: 'deepinfra', model: 'openai/whisper-large-v3-turbo', apiKey: APP_KEY })
  })

  it('uso sem modelo escolhido pelo dono: nenhum aviso na janela (pedido do dono, 23/11)', () => {
    useAppAiStore.setState({ config: toAppConfig({ ...ADMIN, defaults: {} }, ['deepinfra']), providers: ['deepinfra'] })
    render(<Pick />)
    expect(screen.queryByRole('combobox')).toBeNull()
    expect(screen.queryByRole('note')).toBeNull()
    expect(screen.queryByText(/não está configurada/)).toBeNull()
  })

  it('sem a estrutura, o seletor aparece com os modelos da pessoa', () => {
    render(<Pick />)
    expect(screen.getByRole('combobox', { name: 'Transcrição' })).toBeInTheDocument()
  })

  it('a IA da pessoa não se perde: fica guardada e volta igual ao desligar a estrutura (FR-007)', async () => {
    followAppAi(true)
    await vi.waitFor(() => expect(useAppAiStore.getState().config).not.toBeNull())
    const settings = useLibraryStore.getState().index.settings
    expect(aiConfigOf(settings).providers[0].type).toBe('deepinfra')
    // what the app keeps of the person's settings is hers, never the app's
    expect(normalizeSettings(settings).aiConfig).toEqual(OWN)
    expect(settings.aiConfig).toEqual(OWN)
    followAppAi(false)
    expect(aiConfigOf(useLibraryStore.getState().index.settings)).toEqual(OWN)
    expect(targetFor(useLibraryStore.getState().index.settings, 'transcricao')).toMatchObject({ provider: 'openai', apiKey: 'sk-da-pessoa' })
  })
})
