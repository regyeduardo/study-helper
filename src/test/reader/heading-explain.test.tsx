import { afterEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

import { DocumentBody } from '@/components/reader/DocumentArticle'
import { paths } from '@/lib/paths'
import { useLibraryStore } from '@/stores/library'
import { studyLibrary } from '@/test/generation/study-fixture'

const rect = (left: number, top: number, width: number, height: number) =>
  ({ left, top, width, height, right: left + width, bottom: top + height, x: left, y: top, toJSON: () => ({}) }) as DOMRect

// Título encostado na margem (sem espaço à esquerda) e com o texto quase até o fim da caixa.
const COLUMN = rect(0, 0, 1000, 800)
const HEADING_BOX = rect(10, 100, 790, 40)
const HEADING_TEXT = rect(10, 100, 770, 40)

function layout() {
  const original = Element.prototype.getBoundingClientRect
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    if (this.matches('h1, h2, h3, h4, h5, h6')) return HEADING_BOX
    if (this.id === 'root' || this.classList.contains('docscroll')) return COLUMN
    return original.call(this)
  })
  Object.assign(Range.prototype, {
    getClientRects: () => [HEADING_TEXT] as unknown as DOMRectList,
    getBoundingClientRect: () => HEADING_TEXT,
  })
}

async function shown(): Promise<HTMLElement> {
  studyLibrary()
  const meta = await useLibraryStore.getState().createFile({ name: 'Limites', type: 'class', status: 'ready', folderId: null }, '# Limites\n\n## Um título bem comprido que ocupa quase toda a largura da coluna\n\nTexto da seção.')
  const host = document.createElement('div')
  host.id = 'root'
  document.body.appendChild(host)
  render(
    <MemoryRouter initialEntries={[paths.file(meta.id)]}>
      <div className="docscroll">
        <DocumentBody fileId={meta.id} />
      </div>
    </MemoryRouter>,
    { container: host },
  )
  let heading: HTMLElement | null = null
  await waitFor(() => {
    heading = document.querySelector('[data-testid="github-viewer"]')?.shadowRoot?.querySelector('h2') ?? null
    expect(heading).toBeTruthy()
  })
  return heading as unknown as HTMLElement
}

const overlaps = (a: DOMRect, b: { left: number; top: number; width: number; height: number }) =>
  a.left < b.left + b.width && b.left < a.right && a.top < b.top + b.height && b.top < a.bottom

afterEach(() => {
  vi.restoreAllMocks()
  document.getElementById('root')?.remove()
})

describe('lâmpada do título', () => {
  it('aparece ao passar o mouse no título, fora da caixa do texto do título', async () => {
    layout()
    const heading = await shown()
    fireEvent.pointerOver(heading, { pointerType: 'mouse' })
    const bulb = await waitFor(() => {
      const found = document.querySelector<HTMLElement>('.heading-explain')
      expect(found).toBeTruthy()
      return found!
    })
    const spot = { left: parseFloat(bulb.style.left), top: parseFloat(bulb.style.top), width: 36, height: 36 }
    expect(spot.left < HEADING_TEXT.left || !overlaps(HEADING_TEXT, spot)).toBe(true)
  })

  it('some quando o mouse sai do título', async () => {
    layout()
    const heading = await shown()
    fireEvent.pointerOver(heading, { pointerType: 'mouse' })
    await waitFor(() => expect(document.querySelector('.heading-explain')).toBeTruthy())
    fireEvent.pointerOut(heading, { pointerType: 'mouse', relatedTarget: document.body })
    fireEvent.pointerLeave(heading, { pointerType: 'mouse', relatedTarget: document.body })
    await waitFor(() => expect(document.querySelector('.heading-explain')).toBeNull())
  })
})
