import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import MermaidRenderer from '@/components/output/MermaidRenderer'

// ── Helpers ──

/**
 * Create a fake window.mermaid with a controllable render mock.
 * Returns the mock so tests can set resolved/rejected values.
 */
function setupMermaidMock() {
  const mockRender = vi.fn()
  ;(window as any).mermaid = {
    initialize: vi.fn(),
    render: mockRender,
  }
  return mockRender
}

/**
 * Install a fake IntersectionObserver on window.
 * Returns a fire function: call fire(true) to trigger isIntersecting.
 * Per the spec: do NOT mock IntersectionObserver with vi.mock;
 * instead use this controllable fake.
 */
function setupIntersectionObserver(): (isIntersecting: boolean) => void {
  let trigger: (isIntersecting: boolean) => void

  class FakeIntersectionObserver {
    constructor(callback: IntersectionObserverCallback) {
      trigger = (isIntersecting: boolean) => {
        callback(
          [{ isIntersecting } as IntersectionObserverEntry],
          null as unknown as IntersectionObserver,
        )
      }
    }
    observe = vi.fn()
    unobserve = vi.fn()
    disconnect = vi.fn()
  }

  ;(window as any).IntersectionObserver = FakeIntersectionObserver as any
  return (isIntersecting: boolean) => trigger(isIntersecting)
}

/**
 * Multi-instance helper: returns an array of trigger functions,
 * one per constructed FakeIntersectionObserver.
 */
function setupMultiObserver(): Array<(isIntersecting: boolean) => void> {
  const triggers: Array<(isIntersecting: boolean) => void> = []

  class FakeIntersectionObserver {
    constructor(callback: IntersectionObserverCallback) {
      triggers.push((isIntersecting: boolean) => {
        callback(
          [{ isIntersecting } as IntersectionObserverEntry],
          null as unknown as IntersectionObserver,
        )
      })
    }
    observe = vi.fn()
    unobserve = vi.fn()
    disconnect = vi.fn()
  }

  ;(window as any).IntersectionObserver = FakeIntersectionObserver as any
  return triggers
}

// ── Tests ──

describe('MermaidRenderer', () => {
  // Silence console.error so rejected renders don't pollute output
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  // ── Tracer bullet ──

  it('renders an SVG when valid mermaid code is given and element enters the viewport', async () => {
    const mockRender = setupMermaidMock()
    const fireIntersection = setupIntersectionObserver()

    mockRender.mockResolvedValue({ svg: '<svg><text>HELLO</text></svg>' })

    const { container } = render(<MermaidRenderer code="graph TD; A-->B;" />)

    // Before intersection: skeleton with minHeight, no SVG
    const mermaidContainer = container.querySelector('.mermaid-container') as HTMLElement
    expect(mermaidContainer.querySelector('svg')).toBeNull()
    expect(mermaidContainer.style.minHeight).toBe('300px')

    // Trigger viewport entry
    fireIntersection(true)

    // Wait for async render
    await vi.waitFor(() => {
      expect(mermaidContainer.querySelector('svg')).toBeTruthy()
    })

    const svg = mermaidContainer.querySelector('svg')!
    expect(svg.innerHTML).toContain('HELLO')

    // Skeleton removed after render
    expect(mermaidContainer.style.minHeight).toBe('')
  })

  // ── Case 1: Not yet visible ──

  it('keeps skeleton when element has not yet entered the viewport', () => {
    setupMermaidMock()
    setupIntersectionObserver()

    const { container } = render(<MermaidRenderer code="graph TD; A-->B;" />)

    const mermaidContainer = container.querySelector('.mermaid-container') as HTMLElement
    expect(mermaidContainer.querySelector('svg')).toBeNull()
    expect(mermaidContainer.style.minHeight).toBe('300px')
  })

  // ── Case 2: Render error ──

  it('leaves the container empty when mermaid.render throws', async () => {
    const mockRender = setupMermaidMock()
    const fireIntersection = setupIntersectionObserver()

    mockRender.mockRejectedValue(new Error('syntax error'))

    const { container } = render(<MermaidRenderer code="BAD CODE" />)

    const mermaidContainer = container.querySelector('.mermaid-container') as HTMLElement

    // Trigger intersection
    fireIntersection(true)

    // Wait for render to be attempted
    await vi.waitFor(() => {
      expect(mockRender).toHaveBeenCalled()
    })

    // Container is empty: no error text, no amber box, no SVG, no skeleton
    expect(mermaidContainer.innerHTML).toBe('')
    expect(mermaidContainer.style.minHeight).toBe('')
  })

  it('removes the leaked mermaid error element from document.body on syntax error', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    const mockRender = setupMermaidMock()
    const fireIntersection = setupIntersectionObserver()

    mockRender.mockRejectedValue(new Error('syntax error'))

    render(<MermaidRenderer code="this is not valid mermaid syntax !!!" />)

    fireIntersection(true)

    await vi.waitFor(() => {
      // Container should be empty
      expect(screen.queryByRole('img')).toBeNull()
      // No leaked SVG in body
      const leaked = document.body.querySelector('svg[id^="mermaid-"]')
      expect(leaked).toBeNull()
      // Warn called, not error
      expect(warnSpy).toHaveBeenCalled()
      expect(errorSpy).not.toHaveBeenCalled()
    })

    warnSpy.mockRestore()
    errorSpy.mockRestore()
  })

  // ── Case 3: Multiple instances ──

  it('only renders diagrams whose observer callback has fired', async () => {
    const mockRender = setupMermaidMock()
    const triggers = setupMultiObserver()

    mockRender.mockResolvedValue({ svg: '<svg>RENDERED</svg>' })

    const { container } = render(
      <div>
        <MermaidRenderer code="graph TD; A-->B;" />
        <MermaidRenderer code="graph TD; C-->D;" />
      </div>,
    )

    const containers = container.querySelectorAll('.mermaid-container')
    expect(containers).toHaveLength(2)
    expect(triggers).toHaveLength(2)

    // Neither has rendered
    expect(containers[0].querySelector('svg')).toBeNull()
    expect(containers[1].querySelector('svg')).toBeNull()

    // Trigger only the first instance
    triggers[0](true)

    await vi.waitFor(() => {
      expect(containers[0].querySelector('svg')).toBeTruthy()
    })

    // Second still not rendered
    expect(containers[1].querySelector('svg')).toBeNull()

    // Trigger the second
    triggers[1](true)

    await vi.waitFor(() => {
      expect(containers[1].querySelector('svg')).toBeTruthy()
    })

    // Both have now rendered
    expect(containers[0].querySelector('svg')).toBeTruthy()
    expect(containers[1].querySelector('svg')).toBeTruthy()
  })

  // ── Zoom and pan controls ──

  describe('zoom and pan controls', () => {
    it('renders zoom-in, zoom-out, and reset buttons on a valid diagram', async () => {
      const mockRender = setupMermaidMock()
      const fireIntersection = setupIntersectionObserver()
      mockRender.mockResolvedValue({ svg: '<svg><text>HELLO</text></svg>' })

      render(<MermaidRenderer code="graph TD; A-->B" />)
      fireIntersection(true)

      await vi.waitFor(() => {
        expect(screen.getByRole('button', { name: /\+/ })).toBeInTheDocument()
        expect(screen.getByRole('button', { name: /–/ })).toBeInTheDocument()
        expect(screen.getByRole('button', { name: /reset/i })).toBeInTheDocument()
      })
    })

    it('clicking zoom-in button increases the transform scale', async () => {
      const mockRender = setupMermaidMock()
      const fireIntersection = setupIntersectionObserver()
      mockRender.mockResolvedValue({ svg: '<svg><text>HELLO</text></svg>' })

      render(<MermaidRenderer code="graph TD; A-->B" />)
      fireIntersection(true)

      const zoomInBtn = await screen.findByRole('button', { name: /\+/ })
      const contentWrapper = document.querySelector(
        '.react-transform-component',
      ) as HTMLElement

      const initialTransform = contentWrapper.style.transform

      fireEvent.click(zoomInBtn)

      await vi.waitFor(() => {
        const newTransform = contentWrapper.style.transform
        // After zoom-in, scale should be larger (e.g., scale(1.5) or scale(2))
        expect(newTransform).not.toBe(initialTransform)
        // The transform should contain a scale value greater than 1
        const scaleMatch = newTransform.match(/scale\(([\d.]+)\)/)
        expect(scaleMatch).not.toBeNull()
        if (scaleMatch) {
          expect(Number.parseFloat(scaleMatch[1])).toBeGreaterThan(1)
        }
      })
    })

    it('clicking zoom-out button decreases the transform scale', async () => {
      const mockRender = setupMermaidMock()
      const fireIntersection = setupIntersectionObserver()
      mockRender.mockResolvedValue({ svg: '<svg><text>HELLO</text></svg>' })

      render(<MermaidRenderer code="graph TD; A-->B" />)
      fireIntersection(true)

      // First zoom in so zoom-out has room to work (minScale=1 by default)
      const zoomInBtn = await screen.findByRole('button', { name: /\+/ })
      const zoomOutBtn = await screen.findByRole('button', { name: /–/ })
      const contentWrapper = document.querySelector(
        '.react-transform-component',
      ) as HTMLElement

      fireEvent.click(zoomInBtn)

      // Wait for zoom-in to take effect
      await vi.waitFor(() => {
        const afterZoom = contentWrapper.style.transform
        const m = afterZoom.match(/scale\(([\d.]+)\)/)
        expect(m && Number.parseFloat(m[1])).toBeGreaterThan(1)
      })

      const afterZoomTransform = contentWrapper.style.transform

      fireEvent.click(zoomOutBtn)

      await vi.waitFor(() => {
        const newTransform = contentWrapper.style.transform
        expect(newTransform).not.toBe(afterZoomTransform)
        const scaleMatch = newTransform.match(/scale\(([\d.]+)\)/)
        expect(scaleMatch).not.toBeNull()
        if (scaleMatch) {
          // Scale should be less than the zoomed-in value but still >= 1
          expect(Number.parseFloat(scaleMatch[1])).toBeLessThan(
            Number.parseFloat(afterZoomTransform.match(/scale\(([\d.]+)\)/)![1]),
          )
        }
      })
    })

    it('clicking reset restores the default transform', async () => {
      const mockRender = setupMermaidMock()
      const fireIntersection = setupIntersectionObserver()
      mockRender.mockResolvedValue({ svg: '<svg><text>HELLO</text></svg>' })

      render(<MermaidRenderer code="graph TD; A-->B" />)
      fireIntersection(true)

      const zoomInBtn = await screen.findByRole('button', { name: /\+/ })
      const resetBtn = await screen.findByRole('button', { name: /reset/i })
      const contentWrapper = document.querySelector(
        '.react-transform-component',
      ) as HTMLElement

      // First zoom in
      fireEvent.click(zoomInBtn)

      // Wait for zoom to take effect
      await vi.waitFor(() => {
        const afterZoom = contentWrapper.style.transform
        expect(afterZoom).toContain('scale(')
        const m = afterZoom.match(/scale\(([\d.]+)\)/)
        expect(m && Number.parseFloat(m[1])).toBeGreaterThan(1)
      })

      // Then click reset
      fireEvent.click(resetBtn)

      // After reset, transform should contain scale(1)
      await vi.waitFor(() => {
        const afterReset = contentWrapper.style.transform
        expect(afterReset).toContain('scale(1')
      })
    })
  })
})
