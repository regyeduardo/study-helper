import os from 'node:os'
import path from 'node:path'

import { defineConfig } from '@playwright/test'

/**
 * Browser flows of feature 002 against the Vite dev server, with no API, no login and a fake AI inside the spec.
 * Start the app first, from the repo root: npm run dev -- --port 5183 --strictPort
 * Then, from e2e/: node_modules/.bin/playwright test -c playwright.local.config.ts
 */
export default defineConfig({
  testDir: 'tests/flows',
  testMatch: 'mapas-hierarquia-explorador.spec.ts',
  // Playwright empties this folder on every run: never point it at the shared e2e/test-results.
  outputDir: process.env.E2E_OUTPUT_DIR ?? path.join(os.tmpdir(), 'estudo-e2e-mapas'),
  workers: 1,
  retries: 0,
  timeout: 120_000,
  expect: { timeout: 15_000 },
  reporter: [['list']],
  use: {
    baseURL: 'http://localhost:5183',
    launchOptions: { executablePath: '/usr/bin/chromium' },
    serviceWorkers: 'block',
    screenshot: 'only-on-failure',
  },
})
