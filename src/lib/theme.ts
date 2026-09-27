export type ThemeChoice = 'system' | 'light' | 'dark'

const THEME_KEY = 'study-helper:theme'

export function savedTheme(): ThemeChoice {
  try {
    const value = localStorage.getItem(THEME_KEY)
    return value === 'light' || value === 'dark' ? value : 'system'
  } catch {
    return 'system'
  }
}

export function applyTheme(choice: ThemeChoice = savedTheme()): void {
  const root = document.documentElement
  if (choice === 'system') root.removeAttribute('data-theme')
  else root.setAttribute('data-theme', choice)
  try {
    localStorage.setItem(THEME_KEY, choice)
  } catch {
    return
  }
}

export function isDarkTheme(): boolean {
  const forced = document.documentElement.getAttribute('data-theme')
  if (forced) return forced === 'dark'
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false
}

export function toggleTheme(): void {
  applyTheme(isDarkTheme() ? 'light' : 'dark')
}
