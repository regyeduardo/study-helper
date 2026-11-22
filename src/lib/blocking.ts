import { type BlockingProgress, useBlockingStore } from '@/stores/blocking'
import { useUiStore } from '@/stores/ui'

/** What the work tells the window while it runs, and how it learns the person pressed Cancelar. */
export interface Blocker {
  progress(update: BlockingProgress): void
  /** True once the person pressed Cancelar: stop after the item in hand, never in the middle of one. */
  readonly cancelled: boolean
  /** Aborted at "Cancelar", for work that takes a signal. */
  readonly signal: AbortSignal
}

/** Where the window starts (without `done`: here `done` is the toast at the end). */
export interface BlockingOptions extends Omit<BlockingProgress, 'done'> {
  /** Offers "Cancelar" (only for work that can stop between items without leaving anything half done). */
  cancellable?: boolean
  /** A toast when it ends well ("Pronto: 1.284 itens no App"). */
  done?: string
}

/**
 * Runs an operation the person waits for inside the window that holds the app (owner's choice F): from the click the app takes no
 * click nor key, and the window shows up in the middle with the bar until the work ends. A failure goes back to the caller as it was
 * (the window closes); `working()` is the version that shows the reason in the window.
 */
export async function blocking<T>(title: string, work: (blocker: Blocker) => Promise<T>, { cancellable, done, ...progress }: BlockingOptions = {}): Promise<T> {
  const controller = new AbortController()
  const store = useBlockingStore.getState()
  const id = store.open(title, { cancellable, onCancel: () => controller.abort(), ...progress })
  const blocker: Blocker = {
    progress: update => useBlockingStore.getState().progress(id, update),
    get cancelled() {
      return controller.signal.aborted
    },
    signal: controller.signal,
  }
  try {
    const result = await work(blocker)
    if (done) useUiStore.getState().toast(done)
    return result
  } finally {
    useBlockingStore.getState().close(id)
  }
}

/** The window with the reason of a failure, until "Fechar". */
export function blockingFailure(title: string, failure: unknown): void {
  useBlockingStore.getState().fail(title, failure instanceof Error ? failure.message : String(failure))
}
