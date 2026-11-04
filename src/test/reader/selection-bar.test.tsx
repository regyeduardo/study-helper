import { afterEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

import { DocumentBody } from '@/components/reader/DocumentArticle'
import { paths } from '@/lib/paths'
import { useLibraryStore } from '@/stores/library'
import { studyLibrary } from '@/test/generation/study-fixture'

const rect = (left: number, top: number, width: number, height: number) =>
  ({ left, top, width, height, right: left + width, bottom: top + height, x: left, y: top, toJSON: () => ({}) }) as DOMRect

function pointer(coarse: boolean) {
  vi.spyOn(window, 'matchMedia').mockImplementation(
    query =>
      ({
        matches: coarse && query.includes('pointer: coarse'),
        media: query,
        onchange: null,
        addListener: () => undefined,
        removeListener: () => undefined,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
        dispatchEvent: () => false,
      }) as MediaQueryList,
  )
}

function selected(box: DOMRect) {
  vi.spyOn(window, 'getSelection').mockReturnValue({ toString: () => 'os laterais diferem', rangeCount: 1, getRangeAt: () => ({ getBoundingClientRect: () => box }) } as unknown as Selection)
}

async function shown(): Promise<ShadowRoot> {
  studyLibrary()
  const meta = await useLibraryStore.getState().createFile({ name: 'Limites', type: 'class', status: 'ready', folderId: null }, '# Limites\n\nSe os laterais diferem, o limite não existe.')
  const listening = vi.spyOn(EventTarget.prototype, 'addEventListener')
  render(
    <MemoryRouter initialEntries={[paths.file(meta.id)]}>
      <DocumentBody fileId={meta.id} />
    </MemoryRouter>,
  )
  let root: ShadowRoot | null = null
  await waitFor(() => {
    root = document.querySelector('[data-testid="github-viewer"]')?.shadowRoot ?? null
    expect(root?.textContent).toContain('laterais')
  })
  // The reader starts listening to the selection only after the document is painted.
  await waitFor(() => expect(listening.mock.contexts.some((target, index) => target instanceof ShadowRoot && listening.mock.calls[index][0] === 'mouseup')).toBe(true))
  return root as unknown as ShadowRoot
}

const barTop = () => parseFloat(screen.getByRole('toolbar', { name: 'Trecho selecionado' }).style.top)

afterEach(() => {
  vi.restoreAllMocks()
})

describe('barra do trecho selecionado', () => {
  it('no toque abre abaixo da seleção, porque o menu do navegador fica em cima', async () => {
    pointer(true)
    await shown()
    const box = rect(40, 300, 200, 22)
    selected(box)
    fireEvent(document, new Event('selectionchange'))
    await waitFor(() => expect(screen.getByRole('toolbar', { name: 'Trecho selecionado' })).toBeInTheDocument(), { timeout: 2000 })
    expect(barTop()).toBeGreaterThanOrEqual(box.bottom)
    expect(screen.getByRole('button', { name: /Explicar isto/ })).toBeInTheDocument()
  })

  it('no toque, perto do fim da tela, a barra não sai da tela', async () => {
    pointer(true)
    await shown()
    selected(rect(40, window.innerHeight - 30, 200, 22))
    fireEvent(document, new Event('selectionchange'))
    await waitFor(() => expect(screen.getByRole('toolbar', { name: 'Trecho selecionado' })).toBeInTheDocument(), { timeout: 2000 })
    expect(barTop() + 40).toBeLessThanOrEqual(window.innerHeight)
  })

  it('com mouse continua acima da seleção', async () => {
    pointer(false)
    const root = await shown()
    const box = rect(40, 300, 200, 22)
    selected(box)
    fireEvent.mouseUp(root.querySelector('p')!)
    await waitFor(() => expect(screen.getByRole('toolbar', { name: 'Trecho selecionado' })).toBeInTheDocument(), { timeout: 2000 })
    expect(barTop()).toBeLessThan(box.top)
  })
})
