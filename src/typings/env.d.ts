/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_GOOGLE_CLIENT_ID?: string
  readonly VITE_AUTH_WORKER_URL?: string
  readonly VITE_TRANSCRIPTION_WORKER_URL?: string
  readonly VITE_GOOGLE_API_BASE?: string
  readonly VITE_GOOGLE_ACCOUNTS_SCRIPT?: string
  readonly VITE_SHARE_WORKER_URL?: string
  readonly VITE_SHARED_FILES_URL?: string
  readonly VITE_TURNSTILE_SITE_KEY?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
