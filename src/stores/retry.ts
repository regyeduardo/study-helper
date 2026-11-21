// What a generation window asked, kept on the job it starts: when that job fails, "Tentar de novo" opens the same window filled in.
import type { Overlay } from '@/stores/ui'

const asks = new Map<string, Overlay>()

/** Runs a generation asked in a window: while it runs, a job of it on these notes keeps `retry`. */
export async function asking<T>(fileIds: string[], retry: Overlay, run: () => Promise<T>): Promise<T> {
  for (const id of fileIds) asks.set(id, retry)
  try {
    return await run()
  } finally {
    for (const id of fileIds) if (asks.get(id) === retry) asks.delete(id)
  }
}

/** The window asked for a job starting on this note, if any. */
export const askOf = (fileId: string | null): Overlay | undefined => (fileId ? asks.get(fileId) : undefined)
