import { speechAudio } from '@/controllers/langs.controller'

/**
 * The model voice of the languages mode (spec 004): the server's (Kokoro in English, Chatterbox in the others, with ~400 ms of silence
 * before, cached), each sentence fetched once per page; when the server does not answer, the browser's own voice says it.
 */

const urls = new Map<string, Promise<string>>()
let current: HTMLAudioElement | null = null

function audioUrl(text: string, locale: string): Promise<string> {
  const key = `${locale}|${text}`
  let url = urls.get(key)
  if (!url) {
    url = speechAudio(text, locale).then(blob => URL.createObjectURL(blob))
    url.catch(() => urls.delete(key))
    urls.set(key, url)
  }
  return url
}

function browserVoice(text: string, locale: string, slow: boolean): Promise<void> {
  return new Promise(resolve => {
    const synth = typeof speechSynthesis === 'undefined' ? null : speechSynthesis
    if (!synth || typeof SpeechSynthesisUtterance === 'undefined') return resolve()
    const utterance = new SpeechSynthesisUtterance(text)
    utterance.lang = locale
    utterance.rate = slow ? 0.7 : 1
    utterance.onend = () => resolve()
    utterance.onerror = () => resolve()
    synth.cancel()
    synth.speak(utterance)
  })
}

/** Says the sentence and resolves when it ends (or could not be said). */
export async function say(text: string, locale: string, { slow = false }: { slow?: boolean } = {}): Promise<void> {
  stop()
  let url: string
  try {
    url = await audioUrl(text, locale)
  } catch {
    return browserVoice(text, locale, slow)
  }
  await new Promise<void>(resolve => {
    const audio = new Audio(url)
    current = audio
    audio.playbackRate = slow ? 0.7 : 1
    audio.onended = () => resolve()
    audio.onerror = () => resolve()
    audio.play().catch(() => resolve())
  })
}

/** Says each sentence in turn, with a short pause between them. */
export async function sayAll(texts: string[], locale: string, options: { slow?: boolean } = {}): Promise<void> {
  for (const [n, text] of texts.entries()) {
    if (n > 0) await new Promise(resolve => setTimeout(resolve, 350))
    await say(text, locale, options)
  }
}

export function stop(): void {
  if (current) {
    current.pause()
    current = null
  }
  if (typeof speechSynthesis !== 'undefined') speechSynthesis.cancel()
}
