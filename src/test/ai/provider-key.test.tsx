import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'

import { SettingsDialog } from '@/components/dialogs/SettingsDialog'
import { defaultIndex } from '@/lib/defaults'
import { useLibraryStore } from '@/stores/library'
import { useModelsStore } from '@/stores/models'
import { installFetch, jsonResponse } from '@/test/ai/fake-provider'
import type { AiConfig } from '@/types/domain'

const DEEPINFRA = [
  { model_name: 'deepseek-ai/DeepSeek-V4.1-Flash', type: 'text-generation', tags: [], pricing: { cents_per_input_token: 0.00002, cents_per_output_token: 0.00006 } },
  { model_name: 'nvidia/Nemotron-Omni', type: 'text-generation', tags: ['multimodal', 'input-audio', 'input-video'], pricing: { cents_per_input_token: 0.00001, cents_per_output_token: 0.00004 } },
  { model_name: 'openai/whisper-large-v3', type: 'automatic-speech-recognition', tags: [], pricing: { cents_per_input_sec: 0.0045 } },
]

const di = { id: 'di', type: 'deepinfra' as const, name: 'DeepInfra', key: '', base: '' }
const custom = { id: 'meu', type: 'custom' as const, name: 'Minha IA', key: '', base: 'https://minha.exemplo/v1' }

function setup(aiConfig: AiConfig) {
  const index = defaultIndex()
  index.settings = { ...index.settings, aiConfig }
  useLibraryStore.setState({ index, repo: { saveIndex: async () => undefined } as never })
}

beforeEach(() => {
  installFetch(request => {
    if (request.url === 'https://api.deepinfra.com/models/list') return jsonResponse(DEEPINFRA)
    if (request.url === 'https://minha.exemplo/v1/models') return jsonResponse({ data: [{ id: 'llama3' }] })
    return jsonResponse({ error: 'not found' }, 404)
  })
  useModelsStore.setState({ live: {}, probes: {}, adding: false, ui: { tab: 'provedores', filter: 'all', shut: {} } })
})

afterEach(() => vi.unstubAllGlobals())

describe('provedor sem chave', () => {
  it('a lista pública lida não vira "ok": a situação diz que falta a chave, também na linha do celular', async () => {
    setup({ providers: [di], models: [], defaults: {}, steps: {} })
    render(<SettingsDialog initial="ai" />)
    await waitFor(() => expect(within(screen.getByRole('row', { name: /^DeepInfra/ })).getByText('3')).toBeInTheDocument())
    const row = screen.getByRole('row', { name: /^DeepInfra/ })
    expect(within(row).queryByText('ok')).not.toBeInTheDocument()
    expect(within(row).getByText('falta a chave')).toHaveClass('sit-bad')
    expect(row.querySelector('.pv-sub')).toHaveClass('bad')
    expect(row.querySelector('.pv-sub')).toHaveTextContent('sem chave · 3 modelos')
  })

  it('com a chave colada a situação volta a ser "ok"', async () => {
    setup({ providers: [{ ...di, key: 'chave-de-teste-1234' }], models: [], defaults: {}, steps: {} })
    render(<SettingsDialog initial="ai" />)
    await waitFor(() => expect(within(screen.getByRole('row', { name: /^DeepInfra/ })).getByText('ok')).toHaveClass('sit-ok'))
  })

  it('"Testar conexão" sem chave não diz "Conectado": avisa que nada é gerado sem ela', async () => {
    setup({ providers: [di], models: [], defaults: {}, steps: {} })
    render(<SettingsDialog initial="ai" />)
    fireEvent.click(screen.getByRole('button', { name: 'Editar DeepInfra' }))
    fireEvent.click(screen.getByRole('button', { name: 'Testar conexão' }))
    const message = await screen.findByText('Li 3 modelos, mas falta a chave: sem ela nada é gerado.')
    expect(message).toHaveClass('fail')
    expect(screen.queryByText(/Conectado/)).not.toBeInTheDocument()
  })

  it('Personalizado pode não ter chave (um servidor local): o teste continua dizendo "Conectado"', async () => {
    setup({ providers: [custom], models: [], defaults: {}, steps: {} })
    render(<SettingsDialog initial="ai" />)
    fireEvent.click(screen.getByRole('button', { name: 'Editar Minha IA' }))
    fireEvent.click(screen.getByRole('button', { name: 'Testar conexão' }))
    expect(await screen.findByText('✓ Conectado · 1 modelo · não gasta token')).toBeInTheDocument()
    await waitFor(() => expect(within(screen.getByRole('row', { name: /^Minha IA/ })).getByText('1')).toBeInTheDocument())
    expect(within(screen.getByRole('row', { name: /^Minha IA/ })).queryByText('falta a chave')).not.toBeInTheDocument()
  })
})
