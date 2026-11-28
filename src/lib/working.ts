import { type Blocker, blocking, blockingFailure } from '@/lib/blocking'
import { useUiStore } from '@/stores/ui'

/**
 * A click that takes seconds (Drive writes, rendering a PDF, the AI reading a note) holds the app in the window of the operation
 * (owner's choice F), from the click until the work ends.
 *
 * `message` is what the window says while it works. `done`: a toast says the work ended; absent, whoever called says the end another way.
 * Resolves to false when the work failed: the window then stays with the reason until "Fechar".
 */
export async function working(title: string, work: (blocker: Blocker) => Promise<unknown>, options: { message?: string; done?: string } = {}): Promise<boolean> {
  try {
    await blocking(title, work, options.message ? { phase: options.message } : {})
    if (options.done) useUiStore.getState().toast(options.done)
    return true
  } catch (error) {
    blockingFailure(title, error)
    return false
  }
}

/** "1 item" / "3 itens". */
export const itemsOf = (count: number) => `${count} ${count === 1 ? 'item' : 'itens'}`

/** T194: what an operation of one item waits for before saying, in the corner, that it is still running: a quick one never blinks. */
export const SHOW_AFTER_MS = 1000

/**
 * T194 (dono, 27/11: "O sistema precisa ser rápido e fluido (mesmo que haja latência no servidor)… Corrija tudo"): an operation of one
 * item that does not hold the app. The library already shows the change at once and puts it back if the write fails; here nothing blinks
 * under a second, after that a toast in the corner says it is still running, the end is the `done` toast, and a failure stays in the
 * corner with the reason and "Tentar de novo" until closed. The window that holds the app (choice F, 21/11) stays for batches, what
 * cannot be undone and the account. Resolves to false when it failed.
 */
export async function unheld(title: string, work: () => Promise<unknown>, options: { done?: string; failed?: string } = {}): Promise<boolean> {
  let shown: number | null = null
  const timer = setTimeout(() => (shown = useUiStore.getState().holdToast(title)), SHOW_AFTER_MS)
  const stop = () => {
    clearTimeout(timer)
    if (shown !== null) useUiStore.getState().dismissToast(shown)
  }
  try {
    await work()
    stop()
    if (options.done) useUiStore.getState().toast(options.done)
    return true
  } catch (error) {
    stop()
    const reason = error instanceof Error ? error.message : String(error)
    const id = useUiStore.getState().failToast(`${options.failed ?? `${title.replace(/…$/, '')} não terminou`}: ${reason}`, () => {
      useUiStore.getState().dismissToast(id)
      void unheld(title, work, options)
    })
    return false
  }
}

