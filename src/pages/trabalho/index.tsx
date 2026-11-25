import { useEffect } from 'react'
import { useParams } from 'react-router-dom'

import { runWorker } from '@/lib/generation/worker'

/**
 * The page a job of generating runs in, on the server (spec 007, história 2, research R10b): only the headless Chromium the service
 * opened comes here, with the job's own session. Nobody looks at it; it says what it is for whoever opens it by mistake.
 */
export default function WorkerPage() {
  const { id } = useParams()
  useEffect(() => {
    if (id) void runWorker(id)
  }, [id])
  return <p role="status">Gerando na conta. Esta página é do servidor; pode fechar.</p>
}
