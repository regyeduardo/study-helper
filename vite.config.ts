import path from 'path'

import react from '@vitejs/plugin-react'
import { defineConfig, loadEnv } from 'vite'
import obfuscatorPlugin from 'vite-plugin-javascript-obfuscator'

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  const port = Number(env.VITE_PORT) || 5180
  return {
  base: process.env.BASE_PATH || '/',
  plugins: [
    react(),
    obfuscatorPlugin({
      include: [/src\/.*\.[jt]sx?$/],
      exclude: [/node_modules/],
      apply: 'build',
      options: {
        compact: true,
        identifierNamesGenerator: 'hexadecimal',
        renameGlobals: false,
        stringArray: true,
        stringArrayEncoding: ['base64'],
        stringArrayThreshold: 0.75,
        reservedStrings: ['^@', '^\\.{1,2}/', '^(mammoth|mermaid|onnxruntime-web|parakeet\\.js|zustand)$', '^pdfjs-dist'],
        splitStrings: false,
        transformObjectKeys: false,
        selfDefending: false,
        sourceMap: false,
      },
    }),
  ],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
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
