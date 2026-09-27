export const env = {
  googleClientId: import.meta.env.VITE_GOOGLE_CLIENT_ID ?? '',
  googleApiBase: import.meta.env.VITE_GOOGLE_API_BASE || 'https://www.googleapis.com',
  googleAccountsScript: import.meta.env.VITE_GOOGLE_ACCOUNTS_SCRIPT || 'https://accounts.google.com/gsi/client',
  basePath: import.meta.env.BASE_URL || '/',
}
