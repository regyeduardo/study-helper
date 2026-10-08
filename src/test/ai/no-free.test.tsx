import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'

import { SettingsDialog } from '@/components/dialogs/SettingsDialog'
import { missingSetup, PROVIDERS } from '@/lib/ai/providers'
import { defaultIndex } from '@/lib/defaults'
import { LOCAL_ACCOUNT, useAccountStore } from '@/stores/account'
import { useLibraryStore } from '@/stores/library'
import type { AiProviderId } from '@/types/domain'

const LEFT = 'O provedor de IA que você usava saiu do app. Escolha outro em Configurações › Inteligência artificial.'

describe('text AI without the free providers', () => {
  it('the free one, OVHcloud, Pollinations and LLM7 are no longer offered', () => {
    expect(PROVIDERS.map(provider => provider.id)).toEqual(['gemini', 'anthropic', 'openai', 'xai', 'custom'])
  })

  it.each(['free', 'ovh', 'pollinations', 'llm7'])('whoever used %s is asked to choose another one', provider => {
    expect(missingSetup({ provider: provider as AiProviderId, baseUrl: '', apiKey: '', model: '' })).toBe(LEFT)
  })

  it('the AI settings say the provider in use left and ask to choose another', () => {
    useAccountStore.setState({ accounts: [LOCAL_ACCOUNT], activeId: LOCAL_ACCOUNT.id })
    const index = defaultIndex()
    useLibraryStore.setState({ index: { ...index, settings: { ...index.settings, ai: { provider: 'ovh' as AiProviderId, baseUrl: '', apiKey: '', model: '' } } } })
    render(<SettingsDialog initial="ai" />)
    expect(screen.getByRole('alert')).toHaveTextContent(LEFT)
    expect(screen.queryByText(/OVHcloud|Pollinations|LLM7|Grátis na nuvem · sem chave/)).toBeNull()
  })
})
