export const env = {
  googleClientId: import.meta.env.VITE_GOOGLE_CLIENT_ID ?? '',
  authWorkerUrl: (import.meta.env.VITE_AUTH_WORKER_URL ?? '').replace(/\/+$/, ''),
  transcriptionWorkerUrl: (import.meta.env.VITE_TRANSCRIPTION_WORKER_URL ?? '').replace(/\/+$/, ''),
  googleApiBase: import.meta.env.VITE_GOOGLE_API_BASE || 'https://www.googleapis.com',
  googleAccountsScript: import.meta.env.VITE_GOOGLE_ACCOUNTS_SCRIPT || 'https://accounts.google.com/gsi/client',
  basePath: import.meta.env.BASE_URL || '/',
  shareWorkerUrl: (import.meta.env.VITE_SHARE_WORKER_URL ?? '').replace(/\/+$/, ''),
  sharedFilesUrl: (import.meta.env.VITE_SHARED_FILES_URL ?? '').replace(/\/+$/, ''),
  turnstileSiteKey: import.meta.env.VITE_TURNSTILE_SITE_KEY ?? '',
  /** The Estudo backend (spec 003): the local one while developing, the server otherwise. */
  apiUrl: (import.meta.env.VITE_API_URL || (import.meta.env.DEV ? 'http://localhost:8080' : 'https://api.study.ryns.me')).replace(/\/+$/, ''),
}
