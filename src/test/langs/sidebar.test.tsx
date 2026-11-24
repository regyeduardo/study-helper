// "Idiomas" no menu: um item só, separado do resto, logo acima de PASTAS (resposta do dono em 24/11: "Só idiomas").
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'

import { useViewRoute } from '@/hooks/use-view-route'
import { ReaderWorkspace } from '@/pages/workspace/container/reader'
import { seedLibrary } from '@/test/library/explorer-fixture'

function Workspace() {
  return <ReaderWorkspace route={useViewRoute()} />
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-11-24T12:00:00.000Z'))
  seedLibrary()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('Idiomas no menu', () => {
  it('fica sozinho, separado do resto, logo acima de PASTAS', () => {
    render(
      <MemoryRouter initialEntries={['/']}>
        <Routes>
          <Route path="*" element={<Workspace />} />
        </Routes>
      </MemoryRouter>,
    )
    const nav = screen.getByRole('complementary', { name: 'Navegação' })
    const entries = [...nav.querySelectorAll('.nv, .nh')].map(node => node.textContent?.trim() ?? '')
    const idiomas = entries.indexOf('Idiomas')
    expect(idiomas).toBeGreaterThan(entries.findIndex(text => text.startsWith('Gerações')))
    expect(entries[idiomas + 1]).toBe('Pastas')
    const group = screen.getByRole('button', { name: 'Idiomas' }).parentElement as HTMLElement
    expect(group.querySelectorAll('.nv')).toHaveLength(1)
    expect(group).toHaveClass('nav-lang')
  })
})
