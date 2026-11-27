import { execFileSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { defineConfig } from '@playwright/test'

/**
 * Generating in the account, end to end (spec 007, história 2, research R10b, T076): the Go service opens the system's Chromium for
 * each job, and that Chromium runs the job's page of the production app, which talks to a fake AI provider (tests/trabalho-conta.spec.ts
 * starts it on E2E_AI_PORT); no paid AI is called. A backend and an app of their own, with a small test library seeded at start.
 * Run: cd e2e && npx playwright test -c playwright.trabalho.config.ts
 */
const root = path.resolve(__dirname, '..')
if (!process.env.E2E_DIR) {
  process.env.E2E_DIR = mkdtempSync(path.join(os.tmpdir(), 'estudo-trabalho-'))
  process.env.E2E_DIR_MADE = '1'
}
const dir = process.env.E2E_DIR
mkdirSync(path.join(dir, 'env'), { recursive: true })
process.env.E2E_APP_PORT ??= '8111'
process.env.E2E_API_PORT ??= '8112'
process.env.E2E_AI_PORT ??= '8113'
process.env.E2E_TOKEN_KEY ??= randomBytes(32).toString('base64')
export const APP = `http://localhost:${process.env.E2E_APP_PORT}`
export const API = `http://localhost:${process.env.E2E_API_PORT}`
const localGo = path.join(os.homedir(), '.local/go/bin/go')
const go = process.env.GO_BIN ?? (existsSync(localGo) ? localGo : 'go')
const chromium = process.env.CHROMIUM_PATH || '/usr/bin/chromium'

const short = path.join(dir, 'curta.webm')
if (!existsSync(short)) execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=5', '-c:a', 'libopus', '-b:a', '32k', short])

export default defineConfig({
  testDir: 'tests',
  testMatch: 'trabalho-conta.spec.ts',
  outputDir: process.env.E2E_OUTPUT_DIR ?? path.join(os.tmpdir(), 'estudo-e2e-trabalho'),
  timeout: 300_000,
  expect: { timeout: 30_000 },
  workers: 1,
  retries: 0,
  reporter: [['list', { printSteps: true }]],
  use: {
    baseURL: APP,
    launchOptions: { executablePath: chromium },
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
  webServer: [
    {
      command: `"${go}" build -o "${path.join(dir, 'estudo')}" ./cmd/estudo && exec "${path.join(dir, 'estudo')}"`,
      cwd: path.join(root, 'api'),
      url: `${API}/v1/health`,
      reuseExistingServer: false,
      timeout: 300_000,
      stdout: 'pipe',
      env: {
        TOKEN_KEY: process.env.E2E_TOKEN_KEY,
        ESTUDO_DB: path.join(dir, 'estudo.db'),
        ESTUDO_ADDR: `:${process.env.E2E_API_PORT}`,
        APP_ORIGIN: APP,
        PUBLIC_URL: API,
        SECURE_COOKIES: 'false',
        BLOBS: 'memory',
        ESTUDO_DEV: '1',
        ESTUDO_SEMEAR: `--email pessoa@teste.local --senha senha-de-teste-123 --pastas 2 --notas 3 --transcricoes 0 --midias 1 --midia-curta ${short}`,
        // the jobs: the system's Chromium opens the job's page of this app
        ESTUDO_CHROMIUM: chromium,
        ESTUDO_APP_TRABALHO: APP,
        ESTUDO_GERADORES: '2',
        DEEPINFRA_API_KEY: 'chave-falsa-e2e',
        DEEPINFRA_API_BASE: `http://localhost:${process.env.E2E_AI_PORT}`,
        OPENROUTER_API_KEY: '',
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
      // the production build, as the owner ships it (vite.perf.config.ts: own port, cache and output)
      command: `"${path.join(root, 'node_modules/.bin/vite')}" build --config e2e/vite.perf.config.ts && exec "${path.join(root, 'node_modules/.bin/vite')}" preview --config e2e/vite.perf.config.ts`,
      cwd: root,
      url: APP,
      reuseExistingServer: false,
      timeout: 900_000,
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
