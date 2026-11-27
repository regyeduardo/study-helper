import { FullConfig } from '@playwright/test'
import { execSync } from 'child_process'
import path from 'path'

// ── Service health check definitions ──────────────────────────────────────────

interface ServiceCheck {
  name: string
  url: string
}

const SERVICES: ServiceCheck[] = [
  { name: 'Web Frontend', url: 'http://localhost:8080' },
  { name: 'API', url: 'http://localhost:8000/api/v1/health' },
]

const TIMEOUT_MS = 60_000
const BASE_INTERVAL_MS = 1_000
const MAX_BACKOFF_MS = 5_000
const REQUEST_TIMEOUT_MS = 5_000

// ── Utility helpers ───────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Poll a single service URL until it returns HTTP 2xx or the timeout expires.
 * Uses exponential backoff with a ceiling to avoid hammering unready services.
 */
async function waitForService(service: ServiceCheck): Promise<void> {
  const deadline = Date.now() + TIMEOUT_MS
  let attempt = 0

  while (Date.now() < deadline) {
    attempt++
    try {
      const response = await fetch(service.url, {
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      })
      if (response.ok) {
        console.log(`  ✓ ${service.name} is ready (HTTP ${response.status})`)
        return
      }
      console.log(
        `  ⏳ ${service.name} returned HTTP ${response.status}, retrying...`,
      )
    } catch (err) {
      const reason =
        err instanceof TypeError
          ? 'connection refused'
          : err instanceof DOMException && err.name === 'TimeoutError'
            ? 'timeout'
            : String(err)
      console.log(`  ⏳ ${service.name} not ready (${reason}), retrying...`)
    }

    const delay = Math.min(
      BASE_INTERVAL_MS * 1.5 ** (attempt - 1),
      MAX_BACKOFF_MS,
    )
    await sleep(delay)
  }

  throw new Error(
    `[global-setup] TIMEOUT: ${service.name} did not respond within ${TIMEOUT_MS / 1000}s at ${service.url}`,
  )
}

// ── Database reset ────────────────────────────────────────────────────────────

/**
 * Resolve the project root directory from the Playwright config file path.
 */
function projectRoot(config: FullConfig): string {
  // config.configFile is the absolute path to playwright.config.ts
  return path.dirname(config.configFile!)
}

/**
 * Reset the test database.
 * Attempts to run prisma migrate reset inside the file-management container.
 * If the container is not running, skips the database reset (assumes clean state).
 */
function resetTestDatabase(_config: FullConfig): void {
  console.log('\n[global-setup] Resetting test database…')

  const root = projectRoot(_config)
  const composeFile = path.resolve(root, '../compose.yml')
  const composeOverride = path.resolve(root, '../compose.test.yml')

  // Check if file-management container is running
  const containerCheck = execSync(
    `docker ps --format '{{.Names}}' --filter "name=.*file-management" --filter "status=running" 2>/dev/null`,
    { encoding: 'utf8', stdio: 'pipe' }
  ).trim()

  if (!containerCheck.includes('study-helper-file-management')) {
    console.log('  ⚠️  file-management container not running — skipping database reset\n')
    return
  }

  try {
    execSync(
      `docker compose -f "${composeFile}" -f "${composeOverride}" exec -T file-management npx prisma migrate reset --force`,
      { stdio: 'pipe', timeout: 30_000 },
    )
    console.log('  ✓ Test database reset complete\n')
  } catch (error) {
    throw new Error(
      `[global-setup] Failed to reset test database: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
}

// ── Global setup entry point ──────────────────────────────────────────────────

/**
 * Global setup hook executed once before all tests.
 *
 * 1. Waits for every Docker Compose service to pass its health check.
 * 2. Resets the test database so tests start with a clean state.
 */
async function globalSetup(config: FullConfig): Promise<void> {
  console.log('\n[global-setup] Starting…\n')

  // ── Step 1: Service health checks ──
  console.log('[global-setup] Waiting for services to be ready…')
  for (const service of SERVICES) {
    console.log(`  Checking ${service.name} at ${service.url}…`)
    await waitForService(service)
  }
  console.log('[global-setup] All services are ready!\n')

  // ── Step 2: Database reset ──
  resetTestDatabase(config)
}

export default globalSetup
