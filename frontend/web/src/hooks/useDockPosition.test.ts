import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useDockPosition } from './useDockPosition'

function createMockStorage(): Storage {
  const store: Record<string, string> = {}
  return {
    getItem: vi.fn((key: string) => store[key] ?? null),
    setItem: vi.fn((key: string, value: string) => { store[key] = value }),
    removeItem: vi.fn((key: string) => { delete store[key] }),
    clear: vi.fn(() => { Object.keys(store).forEach(k => delete store[k]) }),
    get length() { return Object.keys(store).length },
    key: vi.fn((_i: number) => null),
  }
}

describe('useDockPosition', () => {
  let mockStorage: Storage

  beforeEach(() => {
    mockStorage = createMockStorage()
    vi.stubGlobal('localStorage', mockStorage)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('returns "left" when localStorage has no dock_position key', () => {
    const { result } = renderHook(() => useDockPosition())
    expect(result.current[0]).toBe('left')
  })

  it('returns "right" when localStorage has dock_position: "right"', () => {
    mockStorage.setItem('dock_position', 'right')
    const { result } = renderHook(() => useDockPosition())
    expect(result.current[0]).toBe('right')
  })

  it('persists new value to localStorage when setter is called', () => {
    const { result } = renderHook(() => useDockPosition())
    act(() => {
      result.current[1]('right')
    })
    expect(result.current[0]).toBe('right')
    expect(mockStorage.getItem('dock_position')).toBe('right')
  })

  it('handles localStorage being unavailable gracefully', () => {
    vi.stubGlobal('localStorage', undefined)
    const { result } = renderHook(() => useDockPosition())
    expect(result.current[0]).toBe('left')

    act(() => {
      result.current[1]('right')
    })
    expect(result.current[0]).toBe('right')
  })
})
