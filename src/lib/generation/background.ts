/**
 * The writing a call starts and does not wait for: "Explicar" and "Gerar desta nota" give the note back at once, so the person goes on
 * reading while it is written. On this device nothing changes; the job page on the server waits for it before saying the job ended,
 * or the session left and the writing died with the page (25/11: "Explicação: handshake" done in Gerações, never written).
 */

const running = new Set<Promise<void>>()

/** Keeps `work` among what is still being written until it ends (well or not); gives `work` back as it is. */
export function inBackground<T>(work: Promise<T>): Promise<T> {
  const tracked: Promise<void> = work.then(
    () => undefined,
    () => undefined,
  )
  running.add(tracked)
  void tracked.then(() => running.delete(tracked))
  return work
}

export const hasBackground = (): boolean => running.size > 0

/** Resolves when everything started in the background has ended, including what was started meanwhile. */
export async function backgroundSettled(): Promise<void> {
  while (running.size) await Promise.all([...running])
}
