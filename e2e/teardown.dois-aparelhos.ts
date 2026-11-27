import { rmSync } from 'node:fs'

/** The run's folder (database, Vite's cache) goes away, unless it was given in E2E_DIR or E2E_KEEP is set. */
export default function teardown(): void {
  if (process.env.E2E_DIR_MADE === '1' && process.env.E2E_DIR && !process.env.E2E_KEEP) rmSync(process.env.E2E_DIR, { recursive: true, force: true })
}
