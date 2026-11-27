import path from 'path'

import { type ConfigEnv, mergeConfig, type UserConfig } from 'vite'

import base from '../vite.config'

/**
 * The app for the end-to-end tests: the project's own config, on its own port and cache (the owner's dev server keeps its
 * node_modules/.vite untouched), reading no .env of the project (the test passes every VITE_ variable itself).
 */
export default async (env: ConfigEnv): Promise<UserConfig> => {
  const own = typeof base === 'function' ? await base(env) : base
  const dir = process.env.E2E_DIR
  if (!dir) throw new Error('E2E_DIR is not set: run it through playwright.dois-aparelhos.config.ts')
  return mergeConfig(own, {
    cacheDir: path.join(dir, 'vite-cache'),
    envDir: path.join(dir, 'env'),
    server: { host: 'localhost', port: Number(process.env.E2E_APP_PORT ?? 8097), strictPort: true, hmr: false, watch: null },
  })
}
