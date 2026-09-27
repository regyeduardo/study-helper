import { describe, it, expect } from 'vitest'
import 'fake-indexeddb/auto'

import { render, screen } from '@testing-library/react'

import { SettingsDialog } from '@/components/dialogs/SettingsDialog'
import { defaultIndex } from '@/lib/defaults'
import { ENGINES } from '@/lib/transcription'
import { LOCAL_ACCOUNT, useAccountStore } from '@/stores/account'
import { useLibraryStore } from '@/stores/library'

describe('engine list and limits', () => {
  it('offers the four engines in order', () => {
    expect(ENGINES.map(engine => engine.id)).toEqual(['whisper', 'parakeet', 'groq', 'puter'])
  })

  it.each([
    ['whisper', ['510 MB', 'WebGPU', 'nada sai do seu computador']],
    ['parakeet', ['670 MB', 'pt-BR ~930 MB', '2,5 GB', 'memória']],
    ['groq', ['20 pedidos/min', '2.000/dia', '8 h de áudio/dia', 'vai para a Groq']],
    ['puter', ['conta Puter', 'vai para o Puter']],
  ])('%s states its limits', (id, fragments) => {
    const engine = ENGINES.find(item => item.id === id)!
    for (const fragment of fragments) expect(engine.limits).toContain(fragment)
    expect(engine.where.length).toBeGreaterThan(0)
  })

  it('local engines say they run in the browser, remote ones say where audio goes', () => {
    expect(ENGINES.filter(engine => engine.where === 'roda neste navegador').map(engine => engine.id)).toEqual(['whisper', 'parakeet'])
  })

  it('settings dialog shows every engine with its limit text', () => {
    useAccountStore.setState({ accounts: [LOCAL_ACCOUNT], activeId: LOCAL_ACCOUNT.id })
    useLibraryStore.setState({ index: defaultIndex() })
    render(<SettingsDialog initial="transcription" />)
    for (const engine of ENGINES) {
      const radio = screen.getByText(engine.name).closest('[role=radio]')!
      expect(radio.querySelector('.lim')?.textContent).toBe(engine.limits)
      expect(radio.textContent).toContain(engine.where)
    }
    expect(screen.getByRole('radio', { name: /Whisper \(no navegador\)/ })).toHaveAttribute('aria-checked', 'true')
  })
})
