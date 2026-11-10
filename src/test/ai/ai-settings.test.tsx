import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'

import { SettingsDialog } from '@/components/dialogs/SettingsDialog'
import { defaultIndex } from '@/lib/defaults'
import { useLibraryStore } from '@/stores/library'
import { useModelsStore } from '@/stores/models'
import { type CapturedRequest, installFetch, jsonResponse } from '@/test/ai/fake-provider'
import type { AiConfig, Settings } from '@/types/domain'

const DEEPINFRA = [
  { model_name: 'deepseek-ai/DeepSeek-V4.1-Flash', type: 'text-generation', tags: [], pricing: { cents_per_input_token: 0.00002, cents_per_output_token: 0.00006 } },
  { model_name: 'nvidia/Nemotron-Omni', type: 'text-generation', tags: ['multimodal', 'input-audio', 'input-video'], pricing: { cents_per_input_token: 0.00001, cents_per_output_token: 0.00004 } },
  { model_name: 'openai/whisper-large-v3', type: 'automatic-speech-recognition', tags: [], pricing: { cents_per_input_sec: 0.0045 } },
]
const OPENROUTER = {
  data: [
    { id: 'perplexity/sonar', name: 'Sonar', architecture: { input_modalities: ['text'] }, supported_parameters: ['web_search_options'], pricing: { prompt: '0.000001', completion: '0.000001' } },
    { id: 'x/mystery', name: 'Mystery' },
  ],
}

let chat: (request: CapturedRequest) => Response
let calls: CapturedRequest[]

function serve() {
  calls = installFetch(request => {
    if (request.url === 'https://api.deepinfra.com/models/list') return jsonResponse(DEEPINFRA)
    if (request.url === 'https://openrouter.ai/api/v1/models') return jsonResponse(OPENROUTER)
    if (request.url === 'https://minha.exemplo/v1/models') return jsonResponse({ data: [{ id: 'llama3' }] })
    if (request.url.endsWith('/chat/completions')) return chat(request)
    return jsonResponse({ error: 'not found' }, 404)
  }).calls
}

const di = { id: 'di', type: 'deepinfra' as const, name: 'DeepInfra', key: '', base: '' }
const or = { id: 'or', type: 'openrouter' as const, name: 'OpenRouter', key: '', base: '' }
const model = (pid: string, mid: string, name = mid.split('/').pop()!) => ({ uid: `${pid}::${mid}`, pid, mid, name })
const FLASH = model('di', 'deepseek-ai/DeepSeek-V4.1-Flash')
const OMNI = model('di', 'nvidia/Nemotron-Omni')
const WHISPER = model('di', 'openai/whisper-large-v3')

function setup(aiConfig?: AiConfig, extra: Partial<Settings> = {}) {
  const index = defaultIndex()
  index.settings = { ...index.settings, ...extra, ...(aiConfig ? { aiConfig } : {}) }
  useLibraryStore.setState({ index, repo: { saveIndex: async () => undefined } as never })
}

const config = () => useLibraryStore.getState().index.settings.aiConfig!
const tab = (name: string) => fireEvent.click(screen.getByRole('tab', { name }))
const optionsOf = (label: string) => [...(screen.getByLabelText(label) as HTMLSelectElement).options].map(option => option.textContent)
const hintOf = (label: string) => screen.getByLabelText(label).closest('.use')!.querySelector('.hint') as HTMLElement

beforeEach(() => {
  chat = () => jsonResponse({ choices: [{ message: { content: 'ok' } }] })
  serve()
  useModelsStore.setState({ live: {}, probes: {}, adding: false, ui: { tab: 'provedores', filter: 'all', shut: {} } })
})

afterEach(() => vi.unstubAllGlobals())

describe('Provedores', () => {
  it('starts with DeepInfra and OpenRouter, each read live with its count and situation', async () => {
    setup()
    render(<SettingsDialog initial="ai" />)
    expect(screen.getAllByRole('tab').map(item => item.textContent)).toEqual(['Provedores', 'Modelos', 'Padrões por uso', 'Recomendações'])
    expect(screen.getByText('Cada provedor tem sua chave. Os modelos vêm dele, lidos ao vivo.')).toBeInTheDocument()
    await waitFor(() => expect(within(screen.getByRole('row', { name: /^DeepInfra/ })).getByText('3')).toBeInTheDocument())
    const row = screen.getByRole('row', { name: /^DeepInfra/ })
    expect(within(row).getByText('falta a chave')).toHaveClass('sit-bad')
    expect(within(row).getByText('sem chave')).toBeInTheDocument()
    await waitFor(() => expect(within(screen.getByRole('row', { name: /^OpenRouter/ })).getByText('2')).toBeInTheDocument())
  })

  it('a provider that needs a key and has none shows the warning; Personalizado asks the URL; Testar conexão does not spend', async () => {
    setup()
    render(<SettingsDialog initial="ai" />)
    fireEvent.click(screen.getByRole('button', { name: '+ Adicionar provedor' }))
    const panel = screen.getByRole('group', { name: 'Painel do provedor' })
    expect(within(panel).getByText('Novo provedor')).toBeInTheDocument()
    fireEvent.click(within(panel).getByRole('button', { name: 'DeepSeek' }))
    expect(screen.getByLabelText('Nome')).toHaveValue('DeepSeek')
    expect(screen.getByLabelText('URL base')).toHaveValue('https://api.deepseek.com')
    expect(screen.getByLabelText('URL base')).toHaveAttribute('readonly')
    fireEvent.click(within(panel).getByRole('button', { name: 'Salvar' }))
    await waitFor(() => expect(screen.getByText('DeepSeek: sem chave. Cole a chave e teste.')).toBeInTheDocument())
    expect(config().providers.map(provider => provider.name)).toEqual(['DeepInfra', 'OpenRouter', 'DeepSeek'])

    fireEvent.click(screen.getByRole('button', { name: '+ Adicionar provedor' }))
    fireEvent.click(within(screen.getByRole('group', { name: 'Tipo' })).getByRole('button', { name: 'Personalizado' }))
    fireEvent.click(screen.getByRole('button', { name: 'Salvar' }))
    expect(screen.getByText('Informe a URL base, com http:// ou https://.')).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('URL base'), { target: { value: 'https://minha.exemplo/v1' } })
    fireEvent.change(screen.getByLabelText('Chave'), { target: { value: 'chave-minha-1234' } })
    fireEvent.click(screen.getByRole('button', { name: 'Testar conexão' }))
    expect(await screen.findByText('✓ Conectado · 1 modelo · não gasta token')).toBeInTheDocument()
    expect(calls.some(call => call.method === 'POST')).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: 'Salvar' }))
    await waitFor(() => expect(config().providers.at(-1)).toMatchObject({ type: 'custom', name: 'Personalizado', key: 'chave-minha-1234', base: 'https://minha.exemplo/v1' }))
    expect(screen.getByRole('row', { name: /^Personalizado/ })).toHaveTextContent('••••1234')
  })

  it('removing a provider asks first and takes its models and the defaults that used them', async () => {
    setup({ providers: [di, or], models: [FLASH], defaults: { estudo: FLASH.uid }, steps: {} })
    render(<SettingsDialog initial="ai" />)
    fireEvent.click(screen.getByRole('button', { name: 'Editar DeepInfra' }))
    fireEvent.click(screen.getByRole('button', { name: 'Remover provedor' }))
    expect(screen.getByText('Remover DeepInfra e o modelo dele?')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Remover' }))
    await waitFor(() => expect(config()).toEqual({ providers: [or], models: [], defaults: {}, steps: {} }))
  })
})

describe('Modelos', () => {
  it('"Adicionar modelo" is a dialog over the settings, with the live list, price, media, the Aceita filter and the price order', async () => {
    setup({ providers: [di, or], models: [], defaults: {}, steps: {} })
    render(<SettingsDialog initial="ai" />)
    tab('Modelos')
    expect(screen.getByText('Nenhum modelo ainda.')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '+ Adicionar modelo' }))
    const dialog = screen.getByRole('dialog', { name: 'Adicionar modelo' })
    expect(screen.getByRole('dialog', { name: 'Configurações' }).closest('.scrim')).toHaveAttribute('inert')
    await waitFor(() => expect(within(dialog).getByText('3 de 3 modelos · lido agora do provedor')).toBeInTheDocument())
    const flash = within(dialog).getByRole('row', { name: /DeepSeek-V4.1-Flash/ })
    expect(within(flash).getByText('US$ 0,20')).toBeInTheDocument()
    expect(within(flash).getByText('US$ 0,60')).toBeInTheDocument()
    expect(within(within(dialog).getByRole('row', { name: /whisper/ })).getByText('US$ 0,162/h')).toBeInTheDocument()
    fireEvent.click(within(within(dialog).getByRole('group', { name: 'Aceita' })).getByRole('button', { name: 'vídeo' }))
    expect(within(dialog).getByText('1 de 3 modelos · lido agora do provedor')).toBeInTheDocument()
    fireEvent.click(within(dialog).getByRole('button', { name: 'Limpar filtros' }))
    fireEvent.click(within(dialog).getByTitle('Ordenar por entrada'))
    const names = () => within(dialog).getAllByRole('row').slice(1).map(row => row.querySelector('.an b')!.textContent)
    expect(names()).toEqual(['Nemotron-Omni', 'DeepSeek-V4.1-Flash', 'whisper-large-v3'])
    fireEvent.click(within(dialog).getByTitle('Ordenar por entrada'))
    expect(names()).toEqual(['DeepSeek-V4.1-Flash', 'Nemotron-Omni', 'whisper-large-v3'])
    fireEvent.click(within(dialog).getByRole('button', { name: 'Adicionar Nemotron-Omni' }))
    expect(within(dialog).getByRole('button', { name: 'Adicionar Nemotron-Omni' })).toHaveTextContent('✓ Adicionado')
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(screen.queryByRole('dialog', { name: 'Adicionar modelo' })).not.toBeInTheDocument()
    expect(screen.getByRole('dialog', { name: 'Configurações' })).toBeInTheDocument()
    expect(screen.getByText('Meus modelos · 1, de 1 provedor')).toBeInTheDocument()
    expect(config().models).toEqual([{ uid: OMNI.uid, pid: 'di', mid: OMNI.mid, name: 'Nemotron-Omni' }])
    const row = screen.getByRole('row', { name: /Nemotron-Omni/ })
    expect(row.querySelector('[data-media="video"]')).toHaveAttribute('data-state', 'yes')
    expect(row.querySelector('[data-media="pdf"]')).toHaveAttribute('data-state', 'unknown')
    expect(screen.getByText(/Nada fica guardado sobre o que cada modelo aceita ou custa/)).toBeInTheDocument()
  })
})

describe('Padrões por uso', () => {
  const all = (): AiConfig => ({ providers: [di, or], models: [FLASH, OMNI, WHISPER], defaults: {}, steps: {} })

  it('each selector lists only the models that take what the use receives; the uses inherit from their mother', async () => {
    setup(all())
    render(<SettingsDialog initial="ai" />)
    tab('Padrões por uso')
    await waitFor(() => expect(optionsOf('Vídeo e áudio')).toEqual(['escolha um modelo', 'Nemotron-Omni · DeepInfra']))
    expect(optionsOf('Estudo')).toEqual(['escolha um modelo', 'DeepSeek-V4.1-Flash · DeepInfra', 'Nemotron-Omni · DeepInfra'])
    expect(optionsOf('Transcrição')).toEqual(['herda de Vídeo e áudio (sem modelo)', 'Nemotron-Omni · DeepInfra', 'whisper-large-v3 · DeepInfra'])
    fireEvent.change(screen.getByLabelText('Estudo'), { target: { value: FLASH.uid } })
    fireEvent.change(screen.getByLabelText('Vídeo e áudio'), { target: { value: OMNI.uid } })
    await waitFor(() => expect(config().defaults).toEqual({ estudo: FLASH.uid, midia: OMNI.uid }))
    expect(optionsOf('Aula')[0]).toBe('herda de Estudo (DeepSeek-V4.1-Flash)')
    expect(optionsOf('Ata')[0]).toBe('herda de Estudo (DeepSeek-V4.1-Flash)')
    expect(optionsOf('Leitura de tela')[0]).toBe('herda de Vídeo e áudio (Nemotron-Omni)')
    expect(optionsOf('Contexto')[0]).toBe('herda da Ata (DeepSeek-V4.1-Flash)')
    expect(screen.getByText('Avançado: modelo por passo (herda da Ata)')).toBeInTheDocument()
  })

  it('warns under the selector when the model does not take what the use receives, and the default can be removed', async () => {
    setup({ ...all(), defaults: { estudo: FLASH.uid } })
    render(<SettingsDialog initial="ai" />)
    tab('Padrões por uso')
    await waitFor(() => expect(hintOf('Aula')).toHaveTextContent('DeepSeek-V4.1-Flash não aceita imagem.'))
    expect(hintOf('Aula')).toHaveTextContent('PDF e foto da Aula vão pela Leitura de tela.')
    expect(hintOf('Aula')).toHaveTextContent('? o provedor não informa se aceita PDF')
    expect(screen.getByText('Estudo · 10 usos · 1 aviso')).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('Estudo'), { target: { value: '' } })
    await waitFor(() => expect(config().defaults).toEqual({}))
    expect(optionsOf('Aula')[0]).toBe('herda de Estudo (sem modelo)')
  })

  it('"Testar" sends a tiny sample for a media the provider does not say; the answer stays only in memory', async () => {
    setup({ ...all(), defaults: { estudo: FLASH.uid } })
    render(<SettingsDialog initial="ai" />)
    tab('Padrões por uso')
    await waitFor(() => expect(hintOf('Aula')).toHaveTextContent('? o provedor não informa se aceita PDF'))
    fireEvent.click(within(hintOf('Aula')).getByRole('button', { name: 'Testar' }))
    await waitFor(() => expect(hintOf('Aula')).not.toHaveTextContent('não informa se aceita PDF'))
    const sent = calls.find(call => call.url === 'https://api.deepinfra.com/v1/openai/chat/completions')!
    expect(sent.body).toMatchObject({ model: FLASH.mid, max_tokens: 16 })
    expect(JSON.stringify(sent.body)).toContain('application/pdf')
    expect(useModelsStore.getState().probes[FLASH.uid]?.pdf).toEqual({ state: 'yes' })
    expect(JSON.stringify(config())).not.toContain('pdf')
  })

  it('Questões da web lists only models that search the web, does not inherit Estudo when it does not, and Testar can confirm one', async () => {
    const sonar = model('or', 'perplexity/sonar', 'Sonar')
    const mystery = model('or', 'x/mystery', 'Mystery')
    setup({ providers: [di, or], models: [FLASH, sonar, mystery], defaults: { estudo: FLASH.uid }, steps: {} })
    chat = () => jsonResponse({ choices: [{ message: { content: '{"url": "https://provas.exemplo/enem/q91"}', annotations: [{ type: 'url_citation', url_citation: { url: 'https://provas.exemplo/enem/q91' } }] } }] })
    render(<SettingsDialog initial="ai" />)
    tab('Padrões por uso')
    await waitFor(() => expect(optionsOf('Questões da web')).toEqual(['escolha um modelo', 'Sonar · OpenRouter']))
    expect(hintOf('Questões da web')).toHaveTextContent('Precisa de um modelo que pesquise na web.')
    fireEvent.change(screen.getByLabelText('Modelo para testar a pesquisa na web'), { target: { value: mystery.uid } })
    fireEvent.click(within(hintOf('Questões da web')).getByRole('button', { name: 'Testar' }))
    expect(await screen.findByText('✓ Mystery pesquisa na web')).toBeInTheDocument()
    expect(optionsOf('Questões da web')).toEqual(['escolha um modelo', 'Sonar · OpenRouter', 'Mystery · OpenRouter'])
  })
})

describe('old settings', () => {
  it('the AI, the key and the transcription saved before show up as providers, models and defaults', async () => {
    setup(undefined, {
      ai: { provider: 'custom', baseUrl: 'https://api.deepinfra.com/v1/openai', apiKey: 'di-chave-9876', model: FLASH.mid },
      transcription: { engine: 'deepinfra', language: 'pt', credentials: { deepinfra: { apiKey: 'di-chave-9876', baseUrl: '', model: '', extra: '' } }, speakersEngine: '' },
    })
    render(<SettingsDialog initial="ai" />)
    expect(screen.getByRole('row', { name: /^DeepInfra/ })).toHaveTextContent('••••9876')
    tab('Modelos')
    expect(screen.getByText('Meus modelos · 2, de 1 provedor')).toBeInTheDocument()
    tab('Padrões por uso')
    expect(screen.getByLabelText('Estudo')).toHaveValue(`deepinfra::${FLASH.mid}`)
    expect(screen.getByLabelText('Transcrição')).toHaveValue('deepinfra::openai/whisper-large-v3')
  })
})
