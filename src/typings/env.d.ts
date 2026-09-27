/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_GOOGLE_CLIENT_ID?: string
  readonly VITE_GOOGLE_API_BASE?: string
  readonly VITE_GOOGLE_ACCOUNTS_SCRIPT?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
