import { type TrackedTask, useJobsStore } from '@/stores/jobs'

/**
 * A click that takes seconds (Drive writes, rendering a PDF, the AI reading a note) answers at once:
 * a line with a spinner in the panel of tasks, from the click until the work ends.
 *
 * `message` is what the line says while it works. `done`: the line stays a few seconds saying the work ended;
 * absent, the line leaves and whoever called says the end another way (a toast).
 * Resolves to false when the work failed: the line then stays, with the reason.
 */
export async function working(title: string, work: (task: TrackedTask) => Promise<unknown>, options: { message?: string; done?: string } = {}): Promise<boolean> {
  const task = useJobsStore.getState().trackTask(title)
  if (options.message) task.update(options.message, null)
  try {
    await work(task)
    if (options.done) task.done(options.done)
    else task.drop?.()
    return true
  } catch (error) {
    task.fail(error instanceof Error ? error.message : String(error))
    return false
  }
}

/** "1 item" / "3 itens". */
export const itemsOf = (count: number) => `${count} ${count === 1 ? 'item' : 'itens'}`
