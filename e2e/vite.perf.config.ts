import path from 'path'

import { type ConfigEnv, mergeConfig, type UserConfig } from 'vite'

import base from '../vite.config'

/**
 * The app of the measures (spec 007, research R1): the production build of the project's own config (as the owner ships it; without
 * obfuscation since spec 007, T026), on its own port, cache and output, reading no .env of the project (the run passes every VITE_ variable).
 * PERF_SEM_OFUSCAR=1 builds without the obfuscator, only for the comparison of T026.
 */
export default async (env: ConfigEnv): Promise<UserConfig> => {
  const own = typeof base === 'function' ? await base(env) : base
  const dir = process.env.E2E_DIR
  if (!dir) throw new Error('E2E_DIR is not set: run it through e2e/playwright.perf.config.ts')
  if (process.env.PERF_SEM_OFUSCAR === '1') own.plugins = (own.plugins ?? []).filter(plugin => !(plugin && 'name' in plugin && /obfuscator/i.test(String(plugin.name))))
  return mergeConfig(own, {
    cacheDir: path.join(dir, 'vite-cache'),
    envDir: path.join(dir, 'env'),
    build: { outDir: path.join(dir, 'dist'), emptyOutDir: true },
    preview: { host: 'localhost', port: Number(process.env.E2E_APP_PORT ?? 8101), strictPort: true },
  })
}
