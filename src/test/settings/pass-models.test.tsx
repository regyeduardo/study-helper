import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'

import { PASS_DEFAULTS, PassModels } from '@/components/dialogs/PassModels'
import { SettingsDialog } from '@/components/dialogs/SettingsDialog'
import { defaultIndex } from '@/lib/defaults'
import { useLibraryStore } from '@/stores/library'

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('sem rede no teste'))))
  const index = defaultIndex()
  index.settings.ai = { provider: 'custom', baseUrl: 'https://api.deepinfra.com/v1/openai', apiKey: 'chave-teste', model: 'deepseek-ai/DeepSeek-V4.1-Flash' }
  index.settings.aiPasses = { context: 'modelo-do-contexto' }
  useLibraryStore.setState({ index, updateSettings: async patch => useLibraryStore.setState(state => ({ index: { ...state.index, settings: { ...state.index.settings, ...patch } } })) })
})

afterEach(() => vi.unstubAllGlobals())

const passes = () => useLibraryStore.getState().index.settings.aiPasses ?? {}

describe('modelo por passo', () => {
  it('fica na aba Geral da IA, dentro de Avançado', () => {
    render(<SettingsDialog initial="ai" />)
    expect(screen.getByText('Avançado: modelo por passo')).toBeInTheDocument()
    expect(screen.getByLabelText('Revisar a lista de tarefas')).toBeInTheDocument()
  })

  it('salva o modelo do passo e apaga a chave quando esvazia', async () => {
    render(<PassModels />)
    fireEvent.change(screen.getByLabelText('Revisar a lista de tarefas'), { target: { value: '  Qwen/Qwen3.7-Max  ' } })
    await waitFor(() => expect(passes().review).toBe('Qwen/Qwen3.7-Max'))
    expect(passes().context).toBe('modelo-do-contexto')
    fireEvent.change(screen.getByLabelText('Revisar a lista de tarefas'), { target: { value: '' } })
    await waitFor(() => expect('review' in passes()).toBe(false))
    expect(passes()).toEqual({ context: 'modelo-do-contexto' })
    expect(fetch).not.toHaveBeenCalled()
  })

  it('mostra os valores salvos e os recomendados no placeholder', () => {
    render(<PassModels />)
    expect(screen.getByLabelText('Contexto e glossário')).toHaveValue('modelo-do-contexto')
    expect(screen.getByLabelText('Achar e juntar as tarefas')).toHaveValue('')
    expect(screen.getByLabelText('Contexto e glossário')).toHaveAttribute('placeholder', expect.stringContaining(PASS_DEFAULTS.context))
    expect(screen.getByLabelText('Achar e juntar as tarefas')).toHaveAttribute('placeholder', expect.stringContaining('deepseek-ai/DeepSeek-V4-Pro'))
    expect(screen.getByLabelText('Revisar a lista de tarefas')).toHaveAttribute('placeholder', expect.stringContaining('deepseek-ai/DeepSeek-V4.1-Flash'))
    expect(screen.getByLabelText('Achar o que ficou sem dono')).toHaveAttribute('placeholder', expect.stringContaining('Qwen/Qwen3.7-Max'))
    expect(screen.getByLabelText('Verificar e escrever (Resumo e demais partes)')).toHaveAttribute('placeholder', expect.stringContaining('deepseek-ai/DeepSeek-V4.1-Flash'))
    expect(screen.getByText(/A visão \(ler a tela, quem fala, prints\) usa a aba Visão; recomendado: XiaomiMiMo\/MiMo-V2.6-Flash/)).toBeInTheDocument()
  })
})
