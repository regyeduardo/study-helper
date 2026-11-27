import { execFileSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { defineConfig } from '@playwright/test'

/**
 * The measures of spec 007 (research R1, contracts/ui.md "Lista de operações"): a backend and an app of their own, never the owner's.
 * The backend keeps its database in a folder made for the run and the content in memory (BLOBS=memory), with the test library seeded
 * inside it at start (ESTUDO_SEMEAR); the app is the production build, served by `vite preview`. Run through `npm run perf`.
 */
const root = path.resolve(__dirname, '..')
if (!process.env.E2E_DIR) {
  process.env.E2E_DIR = mkdtempSync(path.join(os.tmpdir(), 'estudo-perf-'))
  process.env.E2E_DIR_MADE = '1'
}
const dir = process.env.E2E_DIR
mkdirSync(path.join(dir, 'env'), { recursive: true })
process.env.E2E_APP_PORT ??= '8101'
process.env.E2E_API_PORT ??= '8102'
process.env.E2E_TOKEN_KEY ??= randomBytes(32).toString('base64')
export const APP = `http://localhost:${process.env.E2E_APP_PORT}`
export const API = `http://localhost:${process.env.E2E_API_PORT}`
const localGo = path.join(os.homedir(), '.local/go/bin/go')
const go = process.env.GO_BIN ?? (existsSync(localGo) ? localGo : 'go')

// playable media for the seed: a short one for the 50 media, and one of about 1 hour for "tocar a mídia" (Opus 32 kb/s, as recorded)
const short = path.join(dir, 'curta.webm')
const long = path.join(dir, 'longa.webm')
const longSeconds = process.env.PERF_MIDIA_LONGA_S ?? '3600'
if (!existsSync(short)) execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=10', '-c:a', 'libopus', '-b:a', '32k', short])
if (!existsSync(long)) execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', `sine=frequency=330:duration=${longSeconds}`, '-c:a', 'libopus', '-b:a', '32k', long])

const notes = process.env.PERF_NOTAS ?? '1000'
const transcripts = process.env.PERF_TRANSCRICOES ?? '100'
const media = process.env.PERF_MIDIAS ?? '50'

export default defineConfig({
  testDir: 'perf',
  testMatch: process.env.PERF_TELAS === '1' ? 'telas.spec.ts' : process.env.PERF_EXPLORAR === '1' ? 'explorar.spec.ts' : 'medidas.spec.ts',
  outputDir: process.env.E2E_OUTPUT_DIR ?? path.join(os.tmpdir(), 'estudo-perf-resultados'),
  // the profile "celular" (CPU 4x slower) with the library of 1,000 notes is long
  timeout: 3 * 60 * 60_000,
  expect: { timeout: 30_000 },
  workers: 1,
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL: APP,
    launchOptions: { executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium' },
    serviceWorkers: 'block',
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
  webServer: [
    {
      command: `"${go}" build -o "${path.join(dir, 'estudo')}" ./cmd/estudo && exec "${path.join(dir, 'estudo')}"`,
      cwd: path.join(root, 'api'),
      url: `${API}/v1/health`,
      reuseExistingServer: false,
      // seeding 1,000 notes and 100 transcripts of 1 hour happens before the service listens
      timeout: 600_000,
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
        ESTUDO_SEMEAR: `--email pessoa@teste.local --senha senha-de-teste-123 --notas ${notes} --transcricoes ${transcripts} --midias ${media} --midia-curta ${short} --midia-longa ${long}`,
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
