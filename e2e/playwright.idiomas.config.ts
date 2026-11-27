import base from './playwright.dois-aparelhos.config'

/**
 * Spec 004, entrega 1 (só ouvir): Idiomas in a real browser, with a backend and an app of their own and a fake AI provider
 * (tests/idiomas-ouvir.spec.ts starts it on E2E_AI_PORT); no paid AI is called.
 */
process.env.E2E_AI_PORT ??= '8099'
const [api, app] = base.webServer as { env: Record<string, string> }[]
api.env = { ...api.env, DEEPINFRA_API_KEY: 'chave-falsa-e2e', DEEPINFRA_API_BASE: `http://localhost:${process.env.E2E_AI_PORT}`, OPENROUTER_API_KEY: '' }
export default { ...base, webServer: [api, app], testMatch: 'idiomas-ouvir.spec.ts', outputDir: `${base.outputDir}-idiomas` }
