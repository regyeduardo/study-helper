import { useState, useRef, useCallback } from 'react'

// ── Types ──

export interface SSELessonOptions {
  /** Streaming mode to store in localStorage on temp_file_id_ready */
  mode?: 'live' | 'background'
}

export interface SSELessonState {
  lessonText: string
  diagrams: Record<number, string>
  /** Final markdown from the backend, with the diagrams already inlined as ```mermaid blocks */
  finalMarkdown: string
  /** Name and folder the agent proposes for this note; the user may refuse both. */
  suggestion: { name: string; folder: string } | null
  complete: boolean
  tempFileId: string | null
  error: string | null
  connecting: boolean
  active: boolean
  originalTitle: string
  originalDescription: string
}

export interface SSELessonActions {
  start: (url: string, formData: FormData) => void
  startJson: (url: string, body: unknown) => void
  abort: () => void
  reset: () => void
}

const INITIAL_STATE: SSELessonState = {
  lessonText: '',
  diagrams: {},
  finalMarkdown: '',
  suggestion: null,
  complete: false,
  tempFileId: null,
  error: null,
  connecting: false,
  active: false,
  originalTitle: '',
  originalDescription: '',
}

// ── Hook ──

export function useSSELesson(options?: SSELessonOptions): SSELessonState & SSELessonActions {
  const [state, setState] = useState<SSELessonState>(INITIAL_STATE)
  const xhrRef = useRef<XMLHttpRequest | null>(null)
  const mode = options?.mode ?? 'live'

  const reset = useCallback(() => {
    if (xhrRef.current) {
      xhrRef.current.abort()
      xhrRef.current = null
    }
    setState(INITIAL_STATE)
  }, [])

  const abort = useCallback(() => {
    if (xhrRef.current) {
      xhrRef.current.abort()
      xhrRef.current = null
    }
    setState(prev => ({ ...prev, connecting: false, complete: true }))
  }, [])

  const send = useCallback((url: string, body: FormData | string, contentType?: string) => {
    // Reset state and mark as connecting
    setState({ ...INITIAL_STATE, connecting: true })

    // POST via XHR to send the body, then parse SSE events from the response
    const xhr = new XMLHttpRequest()
    xhrRef.current = xhr
    xhr.open('POST', url, true)
    xhr.setRequestHeader('Accept', 'text/event-stream')
    if (contentType) xhr.setRequestHeader('Content-Type', contentType)

    let lastIndex = 0

    xhr.onprogress = () => {
      const newText = xhr.responseText.slice(lastIndex)
      lastIndex = xhr.responseText.length
      const events = parseSSEStream(newText)
      processEvents(events)
    }

    xhr.onloadend = () => {
      localStorage.removeItem('live-generation')
      // Handle HTTP error status (e.g., 409 Conflict)
      if (xhr.status >= 400) {
        let errorMessage = `Erro HTTP ${xhr.status}`
        try {
          const body = JSON.parse(xhr.responseText) as { detail?: string; error?: string }
          if (body.detail || body.error) errorMessage = (body.detail || body.error) as string
        } catch { /* use default */ }
        setState(prev => ({
          ...prev,
          error: errorMessage,
          connecting: false,
        }))
      }
      xhrRef.current = null
    }

    xhr.onerror = () => {
      localStorage.removeItem('live-generation')
      setState(prev => ({
        ...prev,
        error: 'Erro de conexão com o servidor.',
        connecting: false,
      }))
      xhrRef.current = null
    }

    xhr.send(body)
  }, [])

  const start = useCallback((url: string, formData: FormData) => {
    send(url, formData)
  }, [send])

  const startJson = useCallback((url: string, body: unknown) => {
    send(url, JSON.stringify(body), 'application/json')
  }, [send])

  // ── Event processing ──

  const processEvents = useCallback((events: SSERawEvent[]) => {
    for (const evt of events) {
      switch (evt.event) {
        case 'phase1_complete': {
          setState(prev => ({
            ...prev,
            lessonText: evt.data,
            connecting: false,
          }))
          break
        }
        case 'diagram_ready': {
          try {
            const { index, mermaid } = JSON.parse(evt.data) as { index: number; mermaid: string }
            setState(prev => ({
              ...prev,
              diagrams: { ...prev.diagrams, [index]: mermaid },
            }))
          } catch {
            // ignore malformed events
          }
          break
        }
        case 'diagram_fallback': {
          try {
            const { index, table } = JSON.parse(evt.data) as { index: number; table: string }
            setState(prev => ({
              ...prev,
              diagrams: { ...prev.diagrams, [index]: table },
            }))
          } catch {
            // ignore malformed events
          }
          break
        }
        case 'temp_file_id_ready': {
          try {
            const { temp_file_id } = JSON.parse(evt.data) as { temp_file_id: string }
            localStorage.setItem('live-generation', JSON.stringify({ mode, tempFileId: temp_file_id }))
          } catch {
            // ignore malformed events
          }
          break
        }
        case 'lesson_complete': {
          localStorage.removeItem('live-generation')
          setState(prev => ({
            ...prev,
            finalMarkdown: evt.data,
            complete: true,
            connecting: false,
          }))
          break
        }
        case 'suggestion': {
          try {
            const { name, folder } = JSON.parse(evt.data) as { name?: string; folder?: string }
            setState(prev => ({ ...prev, suggestion: { name: name || '', folder: folder || '' } }))
          } catch {
            // ignore malformed events
          }
          break
        }
        case 'original_title': {
          setState(prev => ({ ...prev, originalTitle: evt.data }))
          break
        }
        case 'original_description': {
          setState(prev => ({ ...prev, originalDescription: evt.data }))
          break
        }
        case 'temp_file_saved': {
          try {
            const { temp_file_id } = JSON.parse(evt.data) as { temp_file_id: string }
            setState(prev => ({
              ...prev,
              tempFileId: temp_file_id,
            }))
          } catch {
            // ignore
          }
          break
        }
        case 'error': {
          setState(prev => ({
            ...prev,
            error: evt.data || 'Erro desconhecido.',
            connecting: false,
          }))
          break
        }
      }
    }
  }, [])

  // Derive `active` from connecting, complete, and lessonText
  const active = state.connecting || (!state.complete && state.lessonText !== '')

  return {
    ...state,
    active,
    start,
    startJson,
    abort,
    reset,
  }
}

// ── SSE parser ──

interface SSERawEvent {
  event: string
  data: string
}

/**
 * Parse raw SSE response text into a list of events.
 *
 * The backend sends SSE in this format:
 *   event: <name>
 *   data: <payload>
 *   (blank line)
 *   event: <next_name>
 *   ...
 *
 * For `phase1_complete`, the payload is raw markdown which may contain
 * embedded newlines. The backend uses `fmt.Sprintf("event: %s\ndata: %s\n\n", ...)`
 * which means: 1) only the first line after `data:` gets the `data: ` prefix,
 * 2) all subsequent lines (including blank lines) are bare text until `\n\n`.
 *
 * Strategy: Lines starting with `event:` are the only event boundary.
 * Everything between `event:` declarations is accumulated. The first
 * non-`event:` line may have a `data: ` prefix which is stripped.
 */
export function parseSSEStream(text: string): SSERawEvent[] {
  const events: SSERawEvent[] = []
  const lines = text.split('\n')

  let currentEvent = ''
  const currentDataLines: string[] = []
  let dataPrefixStripped = false

  const finalize = () => {
    if (currentEvent && currentDataLines.length > 0) {
      // Trim trailing blank lines
      while (currentDataLines.length > 0 && currentDataLines[currentDataLines.length - 1] === '') {
        currentDataLines.pop()
      }
      if (currentDataLines.length > 0) {
        events.push({ event: currentEvent, data: currentDataLines.join('\n') })
      }
    }
  }

  for (const line of lines) {
    if (line.startsWith('event: ')) {
      finalize()
      currentEvent = line.slice(7).trim()
      currentDataLines.length = 0
      dataPrefixStripped = false
    } else if (currentEvent) {
      // Non-event lines while in an event are data content
      if (!dataPrefixStripped && line.startsWith('data: ')) {
        currentDataLines.push(line.slice(6))
        dataPrefixStripped = true
      } else {
        currentDataLines.push(line)
      }
    }
  }

  // Flush the last event
  finalize()

  return events
}
