import base from './playwright.dois-aparelhos.config'

/**
 * Spec 004, prova de 100% (dono, 23/11): Idiomas with the REAL app AI (DeepInfra/OpenRouter keys from the environment, never printed)
 * and a local S3 (MinIO) in place of R2: real generation, real model voice, the word cache and "Reportar". Costs a few cents.
 * Run: export the keys and E2E_S3 ("endpoint|bucket|key|secret"), then npx playwright test -c playwright.idiomas-real.config.ts
 */
const [endpoint, bucket, key, secret] = (process.env.E2E_S3 ?? '').split('|')
const [api, app] = base.webServer as { env: Record<string, string> }[]
api.env = {
  ...api.env,
  BLOBS: '',
  R2_ENDPOINT: endpoint ?? '',
  R2_BUCKET: bucket ?? '',
  R2_ACCESS_KEY_ID: key ?? '',
  R2_SECRET_ACCESS_KEY: secret ?? '',
  DEEPINFRA_API_KEY: process.env.DEEPINFRA_API_KEY ?? '',
  OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY ?? '',
}
export default { ...base, webServer: [api, app], testMatch: 'idiomas-real.spec.ts', timeout: 15 * 60_000, outputDir: `${base.outputDir}-idiomas-real` }
