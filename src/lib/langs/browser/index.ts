/**
 * Where the languages mode lives (spec 004, FR-040; owner, 24/11: "Tudo no lugar padrão"): the account's default place. With the app
 * structure on, the App (the server, as before); with a Google account, the Google Drive; else this browser. In the Drive and here,
 * the base, the generation and the grading run in the browser, with the AI of "Cartões" (the person's own, or the app's).
 */
import { useEffect, useState } from 'react'

import { chatController, LONG_REPLY_MAX_TOKENS } from '@/controllers/ai.controller'
import { targetFor } from '@/lib/ai/config'
import { missingSetup } from '@/lib/ai/providers'
import { BrowserLangs } from '@/lib/langs/browser/base'
import { AiNotConfigured, BrowserGenerator, type GenModel } from '@/lib/langs/browser/generate'
import { DriveLangFiles, type LangFiles, LocalLangFiles } from '@/lib/langs/files'
import { CombinedRepository } from '@/lib/storage/combined-repository'
import { DriveRepository } from '@/lib/storage/drive-repository'
import { useLibraryStore } from '@/stores/library'
import { useServerAccount } from '@/stores/server-account'

export type LangPlace = 'app' | 'drive' | 'local'

export function langPlace(): LangPlace {
  const library = useLibraryStore.getState()
  if (library.appOn) return 'app'
  return library.repo instanceof CombinedRepository ? 'drive' : 'local'
}

export interface Browser {
  place: Exclude<LangPlace, 'app'>
  langs: BrowserLangs
  generator: BrowserGenerator
}

/** The model of "Cartões": closed cards in JSON, the same indicated pair as "Gerar itens e cards" of the app's AI. */
function cardsModel(): GenModel[] {
  const settings = targetFor(useLibraryStore.getState().index.settings, 'cartoes')
  return [
    {
      id: settings.model,
      chat: async (prompt, signal) => {
        const problem = missingSetup(settings)
        if (problem) throw new AiNotConfigured(problem)
        return (await chatController(settings, prompt, '', LONG_REPLY_MAX_TOKENS, signal)).text
      },
    },
  ]
}

let current: { key: string; browser: Browser } | null = null

/** The base in the browser for the place now; null when the languages live in the App (the server). */
export function browserLangs(): Browser | null {
  const place = langPlace()
  if (place === 'app') return null
  const library = useLibraryStore.getState()
  const key = `${place}:${library.accountId ?? ''}`
  if (current?.key === key) return current.browser
  let files: LangFiles
  if (place === 'drive') {
    const drive = (library.repo as CombinedRepository).drive
    files = drive instanceof DriveRepository ? new DriveLangFiles(() => drive.languagesFolder()) : new LocalLangFiles(`estudo-idiomas-${library.accountId}`)
  } else files = new LocalLangFiles(library.accountId ? `estudo-idiomas-${library.accountId}` : 'estudo-idiomas')
  let generator: BrowserGenerator | null = null
  const langs = new BrowserLangs(files, { generationOf: id => generator?.progressOf(id) })
  generator = new BrowserGenerator(langs, cardsModel)
  const browser: Browser = { place, langs, generator }
  current = { key, browser }
  // the texts left generating when the tab closed go back to the queue
  void generator.resume().catch(() => undefined)
  return browser
}

/** For the screens: where the languages live and whether that place can be read now (the server session, or the library opened). */
export function useLangsPlace(): { place: LangPlace; ready: boolean } {
  const appOn = useLibraryStore(state => state.appOn)
  const libraryReady = useLibraryStore(state => state.ready)
  const repo = useLibraryStore(state => state.repo)
  const account = useServerAccount(state => state.status)
  const place: LangPlace = appOn ? 'app' : repo instanceof CombinedRepository ? 'drive' : 'local'
  return { place, ready: place === 'app' ? account === 'signed-in' : libraryReady }
}

/** Re-renders while a generation in this browser moves (constitution IV). */
export function useBrowserGeneration(): number {
  const [tick, setTick] = useState(0)
  useEffect(() => {
    const browser = langPlace() === 'app' ? null : browserLangs()
    return browser?.generator.subscribe(() => setTick(n => n + 1))
  }, [])
  return tick
}
