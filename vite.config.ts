import path from 'path'

import react from '@vitejs/plugin-react'
import { defineConfig, loadEnv } from 'vite'

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  const port = Number(env.VITE_PORT) || 5180
  return {
  base: process.env.BASE_PATH || '/',
  // no obfuscation: every device ran the scrambled code, 2,6x slower to open the app (spec 007, T026, owner's choice of 24/11)
  plugins: [
    react(),
  ],
  resolve: {
    alias: [
      { find: '@', replacement: path.resolve(__dirname, './src') },
      // the local OCR runs on wasm only: the default build would download the 29.5 MB WebGPU wasm instead of the 14.8 MB one
      { find: /^onnxruntime-web$/, replacement: 'onnxruntime-web/wasm' },
    ],
  },
  server: {
    host: '::',
    port,
    strictPort: true,
    allowedHosts: true,
  },
  preview: {
    port,
    strictPort: true,
  },
  optimizeDeps: {
    exclude: ['onnxruntime-web', '@huggingface/transformers'],
    // found up front: discovered late, the OCR worker would load two copies of onnxruntime-web and one fetches its wasm from a CDN
    include: ['ppu-paddle-ocr/web'],
  },
  worker: {
    format: 'es',
  },
  build: {
    sourcemap: false,
    target: 'es2022',
    minify: 'terser',
    terserOptions: {
      compress: { drop_console: true, drop_debugger: true, passes: 2 },
      mangle: { toplevel: true },
      format: { comments: false },
    },
    chunkSizeWarningLimit: 4096,
  },
}
})
