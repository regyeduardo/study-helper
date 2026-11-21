import { afterEach, describe, expect, it, vi } from 'vitest'

import { watchVisualViewport } from '@/lib/viewport'

type Listener = () => void

function fakeViewport(height: number) {
  const listeners = new Set<Listener>()
  const viewport = {
    height,
    addEventListener: vi.fn((_: string, listener: Listener) => listeners.add(listener)),
    removeEventListener: vi.fn((_: string, listener: Listener) => listeners.delete(listener)),
  }
  Object.defineProperty(window, 'visualViewport', { configurable: true, value: viewport })
  return {
    viewport,
    resizeTo(next: number) {
      viewport.height = next
      listeners.forEach(listener => listener())
    },
    listeners,
  }
}

function touchScreen(coarse: boolean) {
  vi.spyOn(window, 'matchMedia').mockImplementation(query => ({ matches: coarse && query === '(pointer: coarse)', media: query }) as MediaQueryList)
}

afterEach(() => {
  vi.restoreAllMocks()
  delete (window as { visualViewport?: unknown }).visualViewport
  document.documentElement.style.removeProperty('--vvh')
})

const vvh = () => document.documentElement.style.getPropertyValue('--vvh')

describe('the height the person can see', () => {
  it('starts with the visible height and follows the keyboard coming and going', () => {
    touchScreen(true)
    const screen = fakeViewport(844)
    watchVisualViewport()
    expect(vvh()).toBe('844px')
    screen.resizeTo(512.4)
    expect(vvh()).toBe('512px')
    screen.resizeTo(844)
    expect(vvh()).toBe('844px')
  })

  it('stops following and gives the height back to the CSS when stopped', () => {
    touchScreen(true)
    const screen = fakeViewport(700)
    const stop = watchVisualViewport()
    stop()
    expect(screen.listeners.size).toBe(0)
    expect(vvh()).toBe('')
  })

  it('leaves a computer alone: the CSS keeps its own dvh', () => {
    touchScreen(false)
    const screen = fakeViewport(900)
    watchVisualViewport()
    expect(screen.viewport.addEventListener).not.toHaveBeenCalled()
    expect(vvh()).toBe('')
  })

  it('does nothing in a browser without a visual viewport', () => {
    touchScreen(true)
    expect(() => watchVisualViewport()()).not.toThrow()
    expect(vvh()).toBe('')
  })
})
