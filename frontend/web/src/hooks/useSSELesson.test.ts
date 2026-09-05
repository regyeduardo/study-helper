import { describe, it, expect, vi, beforeAll, beforeEach, afterAll, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useSSELesson, parseSSEStream } from './useSSELesson'

// Helper to create a mock XHR object
function createMockXHR() {
  return {
    open: vi.fn(),
    setRequestHeader: vi.fn(),
    send: vi.fn(),
    abort: vi.fn(),
    responseText: '',
  }
}

// Mock localStorage for jsdom/Node environment
function mockLocalStorage() {
  const store: Record<string, string> = {}
  return {
    getItem: vi.fn((key: string) => store[key] ?? null),
    setItem: vi.fn((key: string, value: string) => { store[key] = value }),
    removeItem: vi.fn((key: string) => { delete store[key] }),
    clear: vi.fn(() => { Object.keys(store).forEach(k => delete store[k]) }),
    get length() { return Object.keys(store).length },
    key: vi.fn((_index: number) => null),
  }
}

// Ensure localStorage is available for all tests (the hook uses it)
// Use Object.defineProperty so it persists across vi.unstubAllGlobals() in other tests
let _lsBackup: any
beforeAll(() => {
  _lsBackup = (globalThis as any).localStorage
  Object.defineProperty(globalThis, 'localStorage', {
    writable: true,
    value: mockLocalStorage(),
  })
})

afterAll(() => {
  if (typeof _lsBackup !== 'undefined') {
    Object.defineProperty(globalThis, 'localStorage', {
      writable: true,
      value: _lsBackup,
    })
  }
})

// ── Tests for parseSSEStream ──

describe('parseSSEStream', () => {
  it('parses a single event', () => {
    const raw = 'event: phase1_complete\ndata: # Lesson\n\n'
    const events = parseSSEStream(raw)
    expect(events).toHaveLength(1)
    expect(events[0]).toEqual({ event: 'phase1_complete', data: '# Lesson' })
  })

  it('parses multiple events', () => {
    const raw = [
      'event: phase1_complete',
      'data: # Lesson',
      '',
      'event: lesson_complete',
      'data: # Final',
      '',
    ].join('\n')
    const events = parseSSEStream(raw)
    expect(events).toHaveLength(2)
    expect(events[0].event).toBe('phase1_complete')
    expect(events[1].event).toBe('lesson_complete')
  })

  it('ignores empty blocks', () => {
    const raw = 'event: phase1_complete\ndata: # Lesson\n\n\n\n'
    const events = parseSSEStream(raw)
    expect(events).toHaveLength(1)
  })
})

// ── Tests for useSSELesson ──

describe('useSSELesson — originalTitle', () => {
  it('initialises originalTitle as empty string', () => {
    const { result } = renderHook(() => useSSELesson())
    expect(result.current.originalTitle).toBe('')
  })

  it('sets originalTitle when original_title SSE event is received', async () => {
    const mockXHR = {
      open: vi.fn(),
      setRequestHeader: vi.fn(),
      send: vi.fn(),
      abort: vi.fn(),
      responseText: '',
    }

    const xhrMock = vi.fn(() => mockXHR) as any
    vi.stubGlobal('XMLHttpRequest', xhrMock)

    const { result } = renderHook(() => useSSELesson())

    act(() => {
      result.current.start('/api/process-stream', new FormData())
    })

    const xhr = xhrMock.mock.results[0].value

    xhr.responseText = 'event: original_title\ndata: Aula de Biologia\n\n'
    act(() => {
      xhr.onprogress()
    })

    expect(result.current.originalTitle).toBe('Aula de Biologia')

    vi.unstubAllGlobals()
  })

  it('clears originalTitle on reset', () => {
    const mockXHR = {
      open: vi.fn(),
      setRequestHeader: vi.fn(),
      send: vi.fn(),
      abort: vi.fn(),
      responseText: '',
    }

    const xhrMock = vi.fn(() => mockXHR) as any
    vi.stubGlobal('XMLHttpRequest', xhrMock)

    const { result } = renderHook(() => useSSELesson())

    act(() => {
      result.current.start('/api/process-stream', new FormData())
    })

    const xhr = xhrMock.mock.results[0].value

    // Simulate original_title event
    xhr.responseText = 'event: original_title\ndata: Aula de Biologia\n\n'
    act(() => {
      xhr.onprogress()
    })

    expect(result.current.originalTitle).toBe('Aula de Biologia')

    // Reset
    act(() => {
      result.current.reset()
    })

    expect(result.current.originalTitle).toBe('')

    vi.unstubAllGlobals()
  })
})

describe('useSSELesson', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('starts with empty state', () => {
    const { result } = renderHook(() => useSSELesson())
    expect(result.current.lessonText).toBe('')
    expect(result.current.diagrams).toEqual({})
    expect(result.current.complete).toBe(false)
    expect(result.current.error).toBeNull()
    expect(result.current.connecting).toBe(false)
  })

  it('sets lessonText on phase1_complete event', async () => {
    // Mock XMLHttpRequest
    const mockXHR = {
      open: vi.fn(),
      setRequestHeader: vi.fn(),
      send: vi.fn(),
      abort: vi.fn(),
      responseText: '',
    }

    const xhrMock = vi.fn(() => mockXHR) as any
    vi.stubGlobal('XMLHttpRequest', xhrMock)

    const { result } = renderHook(() => useSSELesson())

    const formData = new FormData()
    act(() => {
      result.current.start('/api/process-stream', formData)
    })

    // Simulate server response
    const xhr = xhrMock.mock.results[0].value
    const phase1Data = 'event: phase1_complete\ndata: # Minha Aula\n\n'
    xhr.responseText = phase1Data

    act(() => {
      // Trigger onprogress
      xhr.onprogress()
    })

    expect(result.current.lessonText).toBe('# Minha Aula')
    expect(result.current.complete).toBe(false)

    vi.unstubAllGlobals()
  })

  it('adds diagram on diagram_ready event', async () => {
    const mockXHR = {
      open: vi.fn(),
      setRequestHeader: vi.fn(),
      send: vi.fn(),
      abort: vi.fn(),
      responseText: '',
    }

    const xhrMock = vi.fn(() => mockXHR) as any
    vi.stubGlobal('XMLHttpRequest', xhrMock)

    const { result } = renderHook(() => useSSELesson())

    act(() => {
      result.current.start('/api/process-stream', new FormData())
    })

    const xhr = xhrMock.mock.results[0].value

    // Simulate phase1 + diagram_ready
    xhr.responseText = [
      'event: phase1_complete',
      'data: # Lesson\n\n<!-- diagram:0 -->',
      '',
      'event: diagram_ready',
      'data: {"index": 0, "mermaid": "graph TD\\nA-->B"}',
      '',
    ].join('\n')

    act(() => {
      xhr.onprogress()
    })

    expect(result.current.lessonText).toBe('# Lesson\n\n<!-- diagram:0 -->')
    expect(result.current.diagrams[0]).toBe('graph TD\nA-->B')

    vi.unstubAllGlobals()
  })

  it('adds diagram on diagram_fallback event', async () => {
    const mockXHR = {
      open: vi.fn(),
      setRequestHeader: vi.fn(),
      send: vi.fn(),
      abort: vi.fn(),
      responseText: '',
    }

    const xhrMock = vi.fn(() => mockXHR) as any
    vi.stubGlobal('XMLHttpRequest', xhrMock)

    const { result } = renderHook(() => useSSELesson())

    act(() => {
      result.current.start('/api/process-stream', new FormData())
    })

    const xhr = xhrMock.mock.results[0].value

    xhr.responseText = [
      'event: phase1_complete',
      'data: # Lesson\n\n<!-- diagram:0 -->',
      '',
      'event: diagram_fallback',
      'data: {"index": 0, "table": "| A | B |\\n|---|---|"}',
      '',
    ].join('\n')

    act(() => {
      xhr.onprogress()
    })

    expect(result.current.diagrams[0]).toBe('| A | B |\n|---|---|')

    vi.unstubAllGlobals()
  })

  it('sets complete on lesson_complete event', async () => {
    const mockXHR = {
      open: vi.fn(),
      setRequestHeader: vi.fn(),
      send: vi.fn(),
      abort: vi.fn(),
      responseText: '',
    }

    const xhrMock = vi.fn(() => mockXHR) as any
    vi.stubGlobal('XMLHttpRequest', xhrMock)

    const { result } = renderHook(() => useSSELesson())

    act(() => {
      result.current.start('/api/process-stream', new FormData())
    })

    const xhr = xhrMock.mock.results[0].value

    xhr.responseText = [
      'event: phase1_complete',
      'data: # Lesson',
      '',
      'event: lesson_complete',
      'data: # Final',
      '',
    ].join('\n')

    act(() => {
      xhr.onprogress()
    })

    expect(result.current.complete).toBe(true)

    vi.unstubAllGlobals()
  })

  // ── Tests for derived `active` flag ──

  describe('active flag', () => {
    beforeEach(() => {
      vi.useFakeTimers()
    })

    afterEach(() => {
      vi.useRealTimers()
    })

    it('is false in initial state', () => {
      const { result } = renderHook(() => useSSELesson())
      expect(result.current.active).toBe(false)
    })

    it('is true after start() is called (connecting)', () => {
      const mockXHR = {
        open: vi.fn(),
        setRequestHeader: vi.fn(),
        send: vi.fn(),
        abort: vi.fn(),
        responseText: '',
      }

      const xhrMock = vi.fn(() => mockXHR) as any
      vi.stubGlobal('XMLHttpRequest', xhrMock)

      const { result } = renderHook(() => useSSELesson())

      act(() => {
        result.current.start('/api/process-stream', new FormData())
      })

      expect(result.current.active).toBe(true)
      expect(result.current.connecting).toBe(true)

      vi.unstubAllGlobals()
    })

    it('is false after lesson_complete event', () => {
      const mockXHR = {
        open: vi.fn(),
        setRequestHeader: vi.fn(),
        send: vi.fn(),
        abort: vi.fn(),
        responseText: '',
      }

      const xhrMock = vi.fn(() => mockXHR) as any
      vi.stubGlobal('XMLHttpRequest', xhrMock)

      const { result } = renderHook(() => useSSELesson())

      act(() => {
        result.current.start('/api/process-stream', new FormData())
      })

      const xhr = xhrMock.mock.results[0].value

      // Simulate phase1_complete first (text arrives, still not complete)
      xhr.responseText = 'event: phase1_complete\ndata: # Lesson\n\n'
      act(() => {
        xhr.onprogress()
      })
      expect(result.current.active).toBe(true) // lessonText !== '' && !complete

      // Simulate lesson_complete
      xhr.responseText = [
        'event: phase1_complete',
        'data: # Lesson',
        '',
        'event: lesson_complete',
        'data: # Final',
        '',
      ].join('\n')
      act(() => {
        xhr.onprogress()
      })
      expect(result.current.complete).toBe(true)
      expect(result.current.active).toBe(false)

      vi.unstubAllGlobals()
    })

    it('is false after abort() with streaming in progress', () => {
      const mockXHR = {
        open: vi.fn(),
        setRequestHeader: vi.fn(),
        send: vi.fn(),
        abort: vi.fn(),
        responseText: '',
      }

      const xhrMock = vi.fn(() => mockXHR) as any
      vi.stubGlobal('XMLHttpRequest', xhrMock)

      const { result } = renderHook(() => useSSELesson())

      act(() => {
        result.current.start('/api/process-stream', new FormData())
      })

      const xhr = xhrMock.mock.results[0].value

      // Simulate some data arriving
      xhr.responseText = 'event: phase1_complete\ndata: # Lesson\n\n'
      act(() => {
        xhr.onprogress()
      })
      expect(result.current.active).toBe(true)

      // Now abort
      act(() => {
        result.current.abort()
      })

      expect(result.current.active).toBe(false)
      expect(xhr.abort).toHaveBeenCalled()

      vi.unstubAllGlobals()
    })

    it('is false after reset()', () => {
      const mockXHR = {
        open: vi.fn(),
        setRequestHeader: vi.fn(),
        send: vi.fn(),
        abort: vi.fn(),
        responseText: '',
      }

      const xhrMock = vi.fn(() => mockXHR) as any
      vi.stubGlobal('XMLHttpRequest', xhrMock)

      const { result } = renderHook(() => useSSELesson())

      act(() => {
        result.current.start('/api/process-stream', new FormData())
      })

      const xhr = xhrMock.mock.results[0].value

      // Simulate some data arriving
      xhr.responseText = 'event: phase1_complete\ndata: # Lesson\n\n'
      act(() => {
        xhr.onprogress()
      })
      expect(result.current.active).toBe(true)

      // Now reset
      act(() => {
        result.current.reset()
      })

      expect(result.current.active).toBe(false)

      vi.unstubAllGlobals()
    })

    it('is true when lessonText !== "" and complete === false (streaming in progress)', () => {
      const mockXHR = {
        open: vi.fn(),
        setRequestHeader: vi.fn(),
        send: vi.fn(),
        abort: vi.fn(),
        responseText: '',
      }

      const xhrMock = vi.fn(() => mockXHR) as any
      vi.stubGlobal('XMLHttpRequest', xhrMock)

      const { result } = renderHook(() => useSSELesson())

      act(() => {
        result.current.start('/api/process-stream', new FormData())
      })

      const xhr = xhrMock.mock.results[0].value

      // Simulate phase1_complete with lesson text, but NOT lesson_complete
      xhr.responseText = 'event: phase1_complete\ndata: # Minha Aula\n\n'
      act(() => {
        xhr.onprogress()
      })

      expect(result.current.lessonText).toBe('# Minha Aula')
      expect(result.current.complete).toBe(false)
      expect(result.current.active).toBe(true)

      vi.unstubAllGlobals()
    })
  })
})

// ── localStorage: live-generation ──

describe('useSSELesson — live-generation localStorage', () => {
  beforeEach(() => {
    vi.stubGlobal('localStorage', mockLocalStorage())
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('writes live-generation to localStorage on temp_file_id_ready', () => {
    const mockXHR = createMockXHR()
    const xhrMock = vi.fn(() => mockXHR) as any
    vi.stubGlobal('XMLHttpRequest', xhrMock)

    const { result } = renderHook(() => useSSELesson({ mode: 'live' }))

    act(() => {
      result.current.start('/api/process-stream', new FormData())
    })

    const xhr = xhrMock.mock.results[0].value

    xhr.responseText = 'event: temp_file_id_ready\ndata: {"temp_file_id": "abc123"}\n\n'
    act(() => {
      xhr.onprogress()
    })

    expect(localStorage.getItem('live-generation')).toBe(
      JSON.stringify({ mode: 'live', tempFileId: 'abc123' })
    )

    vi.unstubAllGlobals()
  })

  it('clears live-generation from localStorage on lesson_complete', () => {
    localStorage.setItem('live-generation', JSON.stringify({ mode: 'live', tempFileId: 'abc' }))

    const mockXHR = createMockXHR()
    const xhrMock = vi.fn(() => mockXHR) as any
    vi.stubGlobal('XMLHttpRequest', xhrMock)

    const { result } = renderHook(() => useSSELesson())

    act(() => {
      result.current.start('/api/process-stream', new FormData())
    })

    const xhr = xhrMock.mock.results[0].value

    // Simulate lesson_complete
    xhr.responseText = 'event: lesson_complete\ndata: # Final\n\n'
    act(() => {
      xhr.onprogress()
    })

    expect(localStorage.getItem('live-generation')).toBeNull()

    vi.unstubAllGlobals()
  })

  it('clears live-generation from localStorage on SSE error', () => {
    localStorage.setItem('live-generation', JSON.stringify({ mode: 'background', tempFileId: 'xyz' }))

    const mockXHR = createMockXHR()
    const xhrMock = vi.fn(() => mockXHR) as any
    vi.stubGlobal('XMLHttpRequest', xhrMock)

    const { result } = renderHook(() => useSSELesson())

    act(() => {
      result.current.start('/api/process-stream', new FormData())
    })

    const xhr = xhrMock.mock.results[0].value

    act(() => {
      xhr.onerror()
    })

    expect(localStorage.getItem('live-generation')).toBeNull()

    vi.unstubAllGlobals()
  })

  it('clears live-generation from localStorage on connection close (onloadend)', () => {
    localStorage.setItem('live-generation', JSON.stringify({ mode: 'background', tempFileId: 'xyz' }))

    const mockXHR = createMockXHR()
    const xhrMock = vi.fn(() => mockXHR) as any
    vi.stubGlobal('XMLHttpRequest', xhrMock)

    const { result } = renderHook(() => useSSELesson())

    act(() => {
      result.current.start('/api/process-stream', new FormData())
    })

    const xhr = xhrMock.mock.results[0].value

    act(() => {
      xhr.onloadend()
    })

    expect(localStorage.getItem('live-generation')).toBeNull()

    vi.unstubAllGlobals()
  })
})
