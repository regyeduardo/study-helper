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
