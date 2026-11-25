import { appAi } from '@/controllers/api.controller'
import { getJob, reportFailure, reportFinish, reportProgress } from '@/controllers/jobs.controller'
import { toAppConfig, useAppAiStore } from '@/lib/ai/app-ai'
import { setWorkerMode } from '@/lib/generation/account-routing'
import { unpackArgs } from '@/stores/account-jobs'
import { useJobsStore } from '@/stores/jobs'
import { useLibraryStore } from '@/stores/library'
import { useServerAccount } from '@/stores/server-account'

/**
 * The job page on the server (spec 007, história 2, research R10b): the app itself, in a headless Chromium the service opened with the
 * job's own session, runs the call the device asked for, with the account's App and the app's AI, and tells the service how it goes and
 * how it ended. Nothing here goes back to the account (worker mode).
 */

/** How often the progress goes to the service (the service computes the estimate and the stall). */
export const REPORT_EVERY_MS = 1000

const AI_DOWN = /fora do ar|sem crédito|indisponível|unavailable|quota|insufficient/i

/**
 * The app's AI before the call runs: the library only asks for it, without waiting, and a call that started before it came used the
 * person's own AI, with no model (a transcription failed at once). Without it the job fails saying so.
 */
async function loadAppAi(): Promise<void> {
  try {
    const answer = await appAi()
    useAppAiStore.setState({ config: toAppConfig(answer.uses, answer.providers), providers: answer.providers })
  } catch (error) {
    throw new Error(`A IA do app está indisponível para o trabalho (${error instanceof Error ? error.message : String(error)}).`)
  }
}

export async function runWorker(jobId: string): Promise<void> {
  setWorkerMode(true)
  let report: ReturnType<typeof setInterval> | null = null
  try {
    await useServerAccount.getState().refresh()
    const me = useServerAccount.getState().me
    if (!me) throw new Error('A sessão do trabalho não abriu.')
    const job = await getJob(jobId)
    await useLibraryStore.getState().connectWorker(me.user.id)
    await loadAppAi()
    const run = (useJobsStore.getState() as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>)[job.call]
    if (typeof run !== 'function') throw new Error(`Chamada desconhecida: ${job.call}`)
    // the job of the store this call makes is the one that shows its progress
    const before = new Set(useJobsStore.getState().jobs.map(item => item.id))
    let last = ''
    report = setInterval(() => {
      const mine = useJobsStore.getState().jobs.find(item => !before.has(item.id))
      if (!mine) return
      const now = `${mine.message}|${mine.fraction}`
      if (now === last) return
      last = now
      void reportProgress(jobId, mine.message, mine.fraction).catch(() => undefined)
    }, REPORT_EVERY_MS)
    const result = await run(...unpackArgs(job.args))
    clearInterval(report)
    report = null
    // the transcription and the generations close their own job with the failure and end without throwing: that is a failure here too,
    // with its reason, never "done" with nothing made
    const mine = useJobsStore.getState().jobs.find(item => !before.has(item.id))
    if (mine?.status === 'error') throw new Error([mine.message, mine.error].filter(Boolean).join(' '))
    if (mine?.status === 'cancelled') throw new Error(mine.message || 'Cancelado.')
    await reportFinish(jobId, result ?? null)
  } catch (error) {
    if (report) clearInterval(report)
    const message = error instanceof Error ? error.message : String(error)
    await reportFailure(jobId, message, AI_DOWN.test(message) ? 'ai_unavailable' : 'internal').catch(() => undefined)
  }
}
