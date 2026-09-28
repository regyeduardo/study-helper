import { beforeEach, describe, expect, it } from 'vitest'
import { fireEvent, renderHook } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

import { useShortcuts } from '@/App'
import { useUiStore } from '@/stores/ui'

function mount() {
  renderHook(() => useShortcuts(), { wrapper: MemoryRouter })
}

describe('useShortcuts', () => {
  beforeEach(() => useUiStore.setState({ overlay: null, leftOpen: true }))

  it('opens the recording on a plain r', () => {
    mount()
    fireEvent.keyDown(window, { key: 'r' })
    expect(useUiStore.getState().overlay).toEqual({ kind: 'record' })
  })

  it('leaves browser shortcuts like Ctrl+R alone', () => {
    mount()
    for (const key of ['r', 'n', ',', 'g', '[']) {
      fireEvent.keyDown(window, { key, ctrlKey: true })
      fireEvent.keyDown(window, { key, metaKey: true })
      fireEvent.keyDown(window, { key, altKey: true })
    }
    expect(useUiStore.getState().overlay).toBeNull()
    expect(useUiStore.getState().leftOpen).toBe(true)
  })

  it('still opens the palette on Ctrl+K', () => {
    mount()
    fireEvent.keyDown(window, { key: 'k', ctrlKey: true })
    expect(useUiStore.getState().overlay).toEqual({ kind: 'palette' })
  })
})
