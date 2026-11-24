import { create } from 'zustand'

import { ApiError } from '@/controllers/api.controller'
import { getLanguage, type LanguageDetail, type LanguageSummary, listLanguages } from '@/controllers/langs.controller'

/**
 * The languages mode (spec 004): the person's languages and the page of each one. Everything lives on the server; this keeps the last
 * answer so the screens open at once, and asks again while a text is being generated.
 */
interface LangsState {
  languages: LanguageSummary[] | null
  details: Record<string, LanguageDetail>
  /** The server's refusal code (app_disabled, offline…), null when it answered. */
  error: string | null
  load(): Promise<void>
  open(code: string): Promise<void>
  /** Asks the language again every 5 s while a text of it is being generated; gives the function that stops. */
  follow(code: string): () => void
}

const errorCode = (error: unknown) => (error instanceof ApiError ? error.code : 'internal_error')

export const useLangsStore = create<LangsState>((set, get) => ({
  languages: null,
  details: {},
  error: null,
  async load() {
    try {
      const languages = await listLanguages()
      set({ languages, error: null })
    } catch (error) {
      set({ error: errorCode(error) })
    }
  },
  async open(code) {
    try {
      const detail = await getLanguage(code)
      set({ details: { ...get().details, [code]: detail }, error: null })
    } catch (error) {
      set({ error: errorCode(error) })
    }
  },
  follow(code) {
    let stopped = false
    let timer: ReturnType<typeof setTimeout> | null = null
    const tick = async () => {
      if (stopped) return
      const generating = get().details[code]?.texts.some(text => text.status === 'generating')
      if (!generating) {
        timer = setTimeout(() => void tick(), 5_000)
        if (!get().details[code]) await get().open(code)
        return
      }
      await get().open(code)
      if (!stopped) timer = setTimeout(() => void tick(), 5_000)
    }
    timer = setTimeout(() => void tick(), 5_000)
    return () => {
      stopped = true
      if (timer) clearTimeout(timer)
    }
  },
}))
