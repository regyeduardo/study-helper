import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { defineConfig } from '@playwright/test'

/**
 * End-to-end tests (spec 003): a backend and an app of their own, never the owner's (:8080/:8081, its Docker volume, the real R2).
 * The backend keeps its database in a folder made for the run and the media in memory (BLOBS=memory); the Google is fake (fixtures/fake-google.ts).
 */
const root = path.resolve(__dirname, '..')
if (!process.env.E2E_DIR) {
  // one folder per run, shared with the workers through the environment; teardown.dois-aparelhos.ts removes it
  process.env.E2E_DIR = mkdtempSync(path.join(os.tmpdir(), 'estudo-e2e-'))
  process.env.E2E_DIR_MADE = '1'
}
const dir = process.env.E2E_DIR
mkdirSync(path.join(dir, 'env'), { recursive: true })
process.env.E2E_APP_PORT ??= '8097'
process.env.E2E_API_PORT ??= '8098'
process.env.E2E_TOKEN_KEY ??= randomBytes(32).toString('base64')
export const APP = `http://localhost:${process.env.E2E_APP_PORT}`
export const API = `http://localhost:${process.env.E2E_API_PORT}`
const localGo = path.join(os.homedir(), '.local/go/bin/go')
const go = process.env.GO_BIN ?? (existsSync(localGo) ? localGo : 'go')

export default defineConfig({
  testDir: 'tests',
  testMatch: 'dois-aparelhos.spec.ts',
  // apart from the run's folder (Playwright writes here after the teardown); emptied by Playwright on every run
  outputDir: process.env.E2E_OUTPUT_DIR ?? path.join(os.tmpdir(), 'estudo-e2e-dois-aparelhos'),
  timeout: 180_000,
  expect: { timeout: 10_000 },
  workers: 1,
  reporter: [['list', { printSteps: true }]],
  globalTeardown: './teardown.dois-aparelhos.ts',
  use: {
    baseURL: APP,
    launchOptions: { executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium' },
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
  webServer: [
    {
      command: `"${go}" build -o "${path.join(dir, 'estudo')}" ./cmd/estudo && exec "${path.join(dir, 'estudo')}"`,
      cwd: path.join(root, 'api'),
      url: `${API}/v1/health`,
      reuseExistingServer: false,
      timeout: 180_000,
      stdout: 'ignore',
      env: {
        TOKEN_KEY: process.env.E2E_TOKEN_KEY,
        ESTUDO_DB: path.join(dir, 'estudo.db'),
        ESTUDO_ADDR: `:${process.env.E2E_API_PORT}`,
        APP_ORIGIN: APP,
        PUBLIC_URL: API,
        SECURE_COOKIES: 'false',
        BLOBS: 'memory',
        R2_ENDPOINT: '',
        R2_BUCKET: '',
        R2_ACCESS_KEY_ID: '',
        R2_SECRET_ACCESS_KEY: '',
        ADMIN_EMAILS: '',
        GOOGLE_CLIENT_ID: '',
        GOOGLE_CLIENT_SECRET: '',
      },
    },
    {
      command: `"${path.join(root, 'node_modules/.bin/vite')}" --config e2e/vite.e2e.config.ts`,
      cwd: root,
      url: APP,
      reuseExistingServer: false,
      timeout: 120_000,
      stdout: 'ignore',
      env: {
        VITE_API_URL: API,
        VITE_GOOGLE_CLIENT_ID: 'e2e-fake-client',
        VITE_GOOGLE_API_BASE: 'https://google.fake',
        VITE_GOOGLE_ACCOUNTS_SCRIPT: 'https://google.fake/gsi/client',
      },
    },
  ],
})
